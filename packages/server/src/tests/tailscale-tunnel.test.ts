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
 */
function fakeRunner(opts: { statusResult?: CommandResult; serveResult?: CommandResult } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const runner = async (bin: string, args: string[]): Promise<CommandResult> => {
    calls.push({ bin, args });
    if (args[0] === 'status') return opts.statusResult ?? ok(RUNNING_STATUS);
    if (args[0] === 'serve' && args.includes('--bg')) return opts.serveResult ?? ok('');
    return ok(''); // `serve off` cleanup
  };
  return { runner, calls };
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
});
