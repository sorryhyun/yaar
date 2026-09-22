import { describe, expect, it } from 'bun:test';
import { TermuxApi, shellQuote, type TermuxCommandResult } from '../termux/termux-api.js';

const ok = (stdout = ''): TermuxCommandResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const hung: TermuxCommandResult = { code: 143, stdout: '', stderr: '', timedOut: true };

function fake(respond: (bin: string) => TermuxCommandResult = () => ok()) {
  const calls: Array<{ bin: string; args: string[]; stdin?: string }> = [];
  const api = new TermuxApi(async (bin, args, { stdin }) => {
    calls.push({ bin, args, stdin });
    return respond(bin);
  });
  return { api, calls };
}

describe('TermuxApi', () => {
  it('is available when the probe returns JSON, and probes once', async () => {
    const { api, calls } = fake(() => ok('{"percentage":80}'));
    expect(await api.available()).toBe(true);
    expect(await api.available()).toBe(true);
    expect(calls.map((c) => c.bin)).toEqual(['termux-battery-status']);
  });

  it('is unavailable when the probe hangs — the package without the app', async () => {
    const { api } = fake(() => hung);
    expect(await api.available()).toBe(false);
  });

  it('passes notification fields as argv, never through a shell', async () => {
    const { api, calls } = fake();
    await api.notify({ id: 'n1', title: '-t $(rm)', content: 'hi', priority: 'high' });
    expect(calls[0]).toEqual({
      bin: 'termux-notification',
      args: ['--id', 'n1', '--title', '-t $(rm)', '--content', 'hi', '--priority', 'high'],
      stdin: undefined,
    });
  });

  it('sends clipboard and toast text over stdin', async () => {
    const { api, calls } = fake();
    await api.setClipboard('-s secret');
    await api.toast('-b hello', { short: true });
    expect(calls[0]).toMatchObject({ bin: 'termux-clipboard-set', args: [], stdin: '-s secret' });
    expect(calls[1]).toMatchObject({ bin: 'termux-toast', args: ['-s'], stdin: '-b hello' });
  });

  it('reports a failed read as null, and an empty clipboard as the empty string', async () => {
    expect(await fake(() => hung).api.getClipboard()).toBeNull();
    expect(await fake(() => ok('')).api.getClipboard()).toBe('');
  });
});

describe('shellQuote', () => {
  it('survives embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
