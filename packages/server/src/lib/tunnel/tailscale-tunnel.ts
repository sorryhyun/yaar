/**
 * Tailscale Serve tunnel.
 *
 * Unlike {@link SshTunnel}, this owns no transport of its own — `tailscaled`
 * already holds the tunnel and manages its resilience. `tailscale serve` just
 * registers a proxy rule with the local daemon:
 *
 *     https://<host>.<tailnet>.ts.net:443  →  http://127.0.0.1:<port>
 *
 * so the "tunnel" is pure CLI orchestration: check the daemon is up, register
 * the serve rule, read the MagicDNS name, and tear the rule down on shutdown.
 * There is no reconnect loop or keepalive here because the daemon does that.
 *
 * The endpoint is reachable only by devices on the same tailnet — this is
 * network-layer auth, strictly stronger than a public URL gated by a token.
 * Requires HTTPS certificates enabled for the tailnet (MagicDNS + HTTPS in the
 * admin console); without them `serve --https=443` fails and we surface the fix.
 */

import { execFile } from 'child_process';
import type { TunnelConfig, TunnelProvider } from './types.js';

const TAG = '[Tunnel]';
const COMMAND_TIMEOUT = 15_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a resolved binary with args. Injectable so tests avoid a real daemon. */
export type CommandRunner = (bin: string, args: string[]) => Promise<CommandResult>;

const defaultRunner: CommandRunner = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: COMMAND_TIMEOUT }, (err, stdout, stderr) => {
      // ENOENT etc. surface as err with no numeric code — treat as failure.
      const code =
        err && typeof (err as NodeJS.ErrnoException).code === 'number'
          ? ((err as unknown as { code: number }).code as number)
          : err
            ? 1
            : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

/** Candidate `tailscale` binaries: explicit config → PATH → macOS app bundle. */
function binaryCandidates(config: TunnelConfig): string[] {
  const candidates: string[] = [];
  if (config.tailscalePath) candidates.push(config.tailscalePath);
  candidates.push('tailscale');
  candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  return candidates;
}

export class TailscaleTunnel implements TunnelProvider {
  private config: TunnelConfig;
  private localPort: number;
  private run: CommandRunner;
  private bin: string | null = null;
  private magicDns: string | null = null;
  private connected = false;

  constructor(config: TunnelConfig, localPort: number, runner: CommandRunner = defaultRunner) {
    this.config = config;
    this.localPort = localPort;
    this.run = runner;
  }

  /** Find a runnable `tailscale` binary and confirm the daemon is up. */
  private async resolveBinary(): Promise<CommandResult | null> {
    for (const candidate of binaryCandidates(this.config)) {
      const result = await this.run(candidate, ['status', '--json']);
      // A missing binary yields a non-zero code with empty stdout; a present
      // one always prints JSON (even when logged out). Use stdout as the signal.
      if (result.stdout.trim().length > 0) {
        this.bin = candidate;
        return result;
      }
    }
    return null;
  }

  async connect(): Promise<boolean> {
    const status = await this.resolveBinary();
    if (!status || !this.bin) {
      console.warn(
        `${TAG} tailscale binary not found (checked PATH and /Applications). Install Tailscale or set tailscalePath in config/tunnel.json.`,
      );
      return false;
    }

    // Parse daemon state + MagicDNS name.
    let parsed: { BackendState?: string; Self?: { DNSName?: string } };
    try {
      parsed = JSON.parse(status.stdout);
    } catch {
      console.warn(`${TAG} Could not parse \`tailscale status --json\` output`);
      return false;
    }

    if (parsed.BackendState !== 'Running') {
      console.warn(
        `${TAG} Tailscale is not running (state: ${parsed.BackendState ?? 'unknown'}). Run \`tailscale up\` to log into your tailnet.`,
      );
      return false;
    }

    const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '') ?? '';
    if (!dnsName) {
      console.warn(`${TAG} Tailscale did not report a MagicDNS name for this machine.`);
      return false;
    }
    this.magicDns = dnsName;

    // Clear any stale serve rule we may have left on :443 (non-destructive to
    // other ports), then register the proxy in the background.
    await this.run(this.bin, ['serve', '--https=443', 'off']);
    const target = `http://127.0.0.1:${this.localPort}`;
    const serve = await this.run(this.bin, ['serve', '--bg', '--https=443', target]);

    if (serve.code !== 0) {
      const detail = `${serve.stderr}\n${serve.stdout}`.toLowerCase();
      if (detail.includes('https') || detail.includes('cert')) {
        console.warn(
          `${TAG} \`tailscale serve\` failed — HTTPS certificates are not enabled for this tailnet. Enable MagicDNS + HTTPS in the Tailscale admin console (https://login.tailscale.com/admin/dns), then restart.`,
        );
      } else {
        console.warn(
          `${TAG} \`tailscale serve\` failed: ${serve.stderr.trim() || serve.stdout.trim()}`,
        );
      }
      return false;
    }

    this.connected = true;
    console.log(`${TAG} Tunnel: https://${this.magicDns} (tailnet-only)`);
    return true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPublicUrl(token: string): string {
    return `https://${this.magicDns}/#remote=${token}`;
  }

  async shutdown(): Promise<void> {
    this.connected = false;
    if (!this.bin) return;
    await this.run(this.bin, ['serve', '--https=443', 'off']);
  }
}
