import { describe, expect, it } from 'bun:test';
import { TailscaleTunnel, type CommandResult } from '../lib/tunnel/tailscale-tunnel.js';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

const RUNNING_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'my-box.tailnet-abc.ts.net.' },
});

/**
 * Build a fake runner and record every invocation. `serveResult` controls what
 * the `serve --bg` call returns; `statusResult` overrides the status probe.
 * `serveResultByPort` narrows a result to one public port, which is how the
 * desktop rule and the app-origin rule are told apart.
 */
function fakeRunner(
  opts: {
    statusResult?: CommandResult;
    serveResult?: CommandResult;
    serveResultByPort?: Record<string, CommandResult>;
  } = {},
) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const runner = async (bin: string, args: string[]): Promise<CommandResult> => {
    calls.push({ bin, args });
    if (args[0] === 'status') return opts.statusResult ?? ok(RUNNING_STATUS);
    if (args[0] === 'serve' && args.includes('--bg')) {
      const port = args.find((a) => a.startsWith('--https='))?.slice('--https='.length) ?? '';
      return opts.serveResultByPort?.[port] ?? opts.serveResult ?? ok('');
    }
    return ok(''); // `serve off` cleanup
  };
  return { runner, calls };
}

/** The `serve --bg` invocations, in order, as `--https=<port> → <target>`. */
function serveRules(calls: Array<{ args: string[] }>): string[] {
  return calls.filter((c) => c.args.includes('--bg')).map((c) => c.args.slice(2).join(' '));
}

describe('TailscaleTunnel', () => {
  it('registers a serve rule and reports the MagicDNS url', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);

    expect(await tunnel.connect()).toBe(true);
    expect(tunnel.isConnected()).toBe(true);
    // trailing dot stripped from the DNSName
    expect(tunnel.getPublicUrl('tok123')).toBe('https://my-box.tailnet-abc.ts.net/#remote=tok123');

    const serve = calls.find((c) => c.args.includes('--bg'));
    expect(serve?.args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:8000']);
  });

  it('clears a stale :443 rule before registering', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);
    await tunnel.connect();

    const offIdx = calls.findIndex((c) => c.args.join(' ') === 'serve --https=443 off');
    const bgIdx = calls.findIndex((c) => c.args.includes('--bg'));
    expect(offIdx).toBeGreaterThanOrEqual(0);
    expect(offIdx).toBeLessThan(bgIdx); // cleanup runs before the new rule
  });

  it('fails cleanly when the binary is absent (empty stdout)', async () => {
    const runner = async (): Promise<CommandResult> => fail('command not found');
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);
    expect(await tunnel.connect()).toBe(false);
    expect(tunnel.isConnected()).toBe(false);
  });

  it('fails when the daemon is not logged into a tailnet', async () => {
    const { runner } = fakeRunner({
      statusResult: ok(JSON.stringify({ BackendState: 'NeedsLogin' })),
    });
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);
    expect(await tunnel.connect()).toBe(false);
  });

  it('fails when HTTPS certs are not enabled for the tailnet', async () => {
    const { runner } = fakeRunner({
      serveResult: fail('HTTPS is not enabled on this tailnet'),
    });
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);
    expect(await tunnel.connect()).toBe(false);
  });

  it('turns the serve rule off on shutdown', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);
    await tunnel.connect();
    calls.length = 0;
    await tunnel.shutdown();

    expect(tunnel.isConnected()).toBe(false);
    expect(calls.at(-1)?.args.join(' ')).toBe('serve --https=443 off');
  });

  it('publishes one origin only, when no app-origin socket was opened', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner);
    await tunnel.connect();

    expect(serveRules(calls)).toEqual(['--https=443 http://127.0.0.1:8000']);
    expect(tunnel.originBoundary()).toBeNull();
  });
});

/**
 * Phase 3: the second serve rule is the whole origin boundary over the network.
 *
 * Two public ports on one stable MagicDNS name are two browser origins (the
 * same-origin policy separates on port), and they are pointed at two *different*
 * local sockets so the server can attribute a request to one of them without
 * trusting a proxy-supplied header — see `http/origin-boundary.ts`.
 */
describe('TailscaleTunnel — isolated app origin', () => {
  it('serves the app origin on a second port and a second local socket', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner, 8001);

    expect(await tunnel.connect()).toBe(true);
    expect(serveRules(calls)).toEqual([
      '--https=443 http://127.0.0.1:8000',
      '--https=8443 http://127.0.0.1:8001',
    ]);
    expect(tunnel.originBoundary()).toEqual({
      desktopOrigin: 'https://my-box.tailnet-abc.ts.net',
      appOrigin: 'https://my-box.tailnet-abc.ts.net:8443',
    });
  });

  it('honors a configured appOriginPort', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel(
      { service: 'tailscale', appOriginPort: 9443 },
      8000,
      runner,
      8001,
    );
    await tunnel.connect();

    expect(serveRules(calls)).toContain('--https=9443 http://127.0.0.1:8001');
    expect(tunnel.originBoundary()?.appOrigin).toBe('https://my-box.tailnet-abc.ts.net:9443');
  });

  it('keeps the desktop up but reports no boundary when the app rule fails', async () => {
    // A boundary the browser cannot actually reach is worse than none: apps would be
    // pointed at a dead origin. So the desktop tunnel stands and isolation stays off.
    const { runner } = fakeRunner({
      serveResultByPort: { '8443': fail('port 8443 is not allowed') },
    });
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner, 8001);

    expect(await tunnel.connect()).toBe(true);
    expect(tunnel.isConnected()).toBe(true);
    expect(tunnel.originBoundary()).toBeNull();
  });

  it('turns both rules off on shutdown', async () => {
    const { runner, calls } = fakeRunner();
    const tunnel = new TailscaleTunnel({ service: 'tailscale' }, 8000, runner, 8001);
    await tunnel.connect();
    calls.length = 0;
    await tunnel.shutdown();

    const offRules = calls.map((c) => c.args.join(' '));
    expect(offRules).toContain('serve --https=443 off');
    expect(offRules).toContain('serve --https=8443 off');
  });
});
