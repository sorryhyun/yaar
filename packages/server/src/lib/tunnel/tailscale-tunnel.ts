/**
 * Tailscale Serve tunnel.
 *
 * This owns no transport of its own — `tailscaled` already holds the tunnel and
 * manages its resilience. `tailscale serve` just registers a proxy rule with the
 * local daemon:
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
import type { OriginPair, TunnelConfig, TunnelProvider } from './types.js';

const TAG = '[Tunnel]';
const COMMAND_TIMEOUT = 15_000;

/** Public HTTPS port the isolated app origin is served on when none is configured. */
export const DEFAULT_APP_ORIGIN_PORT = 8443;

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
  /** Local socket that receives app-origin traffic, or null when not isolating. */
  private appLocalPort: number | null;
  /** Public port the app-origin rule was actually registered on (null if it isn't). */
  private appServePort: number | null = null;

  constructor(
    config: TunnelConfig,
    localPort: number,
    runner: CommandRunner = defaultRunner,
    appLocalPort: number | null = null,
  ) {
    this.config = config;
    this.localPort = localPort;
    this.run = runner;
    this.appLocalPort = appLocalPort;
  }

  /** Public HTTPS port the app origin is served on. */
  private get appOriginPort(): number {
    return this.config.appOriginPort ?? DEFAULT_APP_ORIGIN_PORT;
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

    if (!(await this.registerServeRule(443, this.localPort))) return false;

    this.connected = true;
    console.log(`${TAG} Tunnel: https://${this.magicDns} (tailnet-only)`);

    // Phase 3: a second rule on a different public port, pointed at a *different*
    // local socket. Different port means a different browser origin, which is what
    // re-erects the app-origin boundary over the network; the distinct local socket
    // is how the server attributes a request to one side of it without trusting a
    // proxy-supplied header. Failure here is not fatal — the desktop is already up,
    // and the boundary simply stays off, as it is on every other transport.
    if (this.appLocalPort !== null) {
      if (await this.registerServeRule(this.appOriginPort, this.appLocalPort)) {
        this.appServePort = this.appOriginPort;
        console.log(
          `${TAG} Isolated app origin: https://${this.magicDns}:${this.appOriginPort} (app-origin isolation active over Tailscale)`,
        );
      } else {
        console.warn(
          `${TAG} Could not serve the isolated app origin on :${this.appOriginPort} — apps will be same-origin with the desktop. Set "appOriginPort" in config/tunnel.json to use a different port.`,
        );
      }
    }

    return true;
  }

  /**
   * Point `https://<magicDns>:<publicPort>` at `http://127.0.0.1:<localPort>`.
   *
   * Clears any stale rule we left on that port first — `serve off` for one port is
   * non-destructive to the others, so this never disturbs a rule the user set up
   * themselves on a different port.
   */
  private async registerServeRule(publicPort: number, localPort: number): Promise<boolean> {
    if (!this.bin) return false;
    const flag = `--https=${publicPort}`;
    await this.run(this.bin, ['serve', flag, 'off']);
    const serve = await this.run(this.bin, [
      'serve',
      '--bg',
      flag,
      `http://127.0.0.1:${localPort}`,
    ]);
    if (serve.code === 0) return true;

    const detail = `${serve.stderr}\n${serve.stdout}`.toLowerCase();
    if (detail.includes('https') || detail.includes('cert')) {
      console.warn(
        `${TAG} \`tailscale serve ${flag}\` failed — HTTPS certificates are not enabled for this tailnet. Enable MagicDNS + HTTPS in the Tailscale admin console (https://login.tailscale.com/admin/dns), then restart.`,
      );
    } else {
      console.warn(
        `${TAG} \`tailscale serve ${flag}\` failed: ${serve.stderr.trim() || serve.stdout.trim()}`,
      );
    }
    return false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPublicUrl(token: string): string {
    return `https://${this.magicDns}/#remote=${token}`;
  }

  /**
   * The origin pair, once both serve rules are up. Null when the app rule is not
   * registered — the caller must then leave the boundary off rather than guess a
   * hostname the browser would never reach.
   */
  originBoundary(): OriginPair | null {
    if (!this.connected || !this.magicDns || this.appServePort === null) return null;
    return {
      desktopOrigin: `https://${this.magicDns}`,
      appOrigin: `https://${this.magicDns}:${this.appServePort}`,
    };
  }

  async shutdown(): Promise<void> {
    this.connected = false;
    if (!this.bin) return;
    await this.run(this.bin, ['serve', '--https=443', 'off']);
    if (this.appServePort !== null) {
      await this.run(this.bin, ['serve', `--https=${this.appServePort}`, 'off']);
      this.appServePort = null;
    }
  }
}
