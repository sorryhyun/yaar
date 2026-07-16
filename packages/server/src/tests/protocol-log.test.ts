/**
 * Tests for the App Protocol traffic log.
 *
 * The log exists so an agent can see what an app actually did rather than infer it from
 * source — the duplicate-emit and ordering bugs it's meant to catch are invisible otherwise.
 * So the properties that matter are: both directions are recorded, ordering is preserved,
 * outcomes (result / error / timeout) are attributed to the right request, and one fat
 * payload can't evict the history.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  beginRequest,
  endRequest,
  recordEmit,
  readLog,
  clearLog,
} from '../features/window/protocol-log.js';

describe('protocol log', () => {
  beforeEach(() => clearLog());

  it('records a command with its result and duration', () => {
    const entry = beginRequest('0/ai-chat', {
      kind: 'command',
      command: 'send',
      params: { text: 'hi' },
    });
    endRequest(entry, { kind: 'command', result: { ok: true } }, 42);

    const [logged] = readLog({ windowKey: '0/ai-chat' });
    expect(logged.direction).toBe('out');
    expect(logged.kind).toBe('command');
    expect(logged.name).toBe('send');
    expect(logged.params).toEqual({ text: 'hi' });
    expect(logged.result).toEqual({ ok: true });
    expect(logged.durationMs).toBe(42);
    expect(logged.error).toBeUndefined();
  });

  it('attributes a timeout to the request that timed out', () => {
    const entry = beginRequest('0/ai-chat', { kind: 'query', stateKey: 'messages' });
    endRequest(entry, null, 5000);

    const [logged] = readLog({ windowKey: '0/ai-chat' });
    expect(logged.error).toContain('timeout');
    expect(logged.result).toBeUndefined();
  });

  it('records an app error rather than treating it as a result', () => {
    const entry = beginRequest('0/ai-chat', { kind: 'command', command: 'boom' });
    endRequest(entry, { kind: 'command', result: undefined, error: 'no such command' }, 3);

    const [logged] = readLog({ windowKey: '0/ai-chat' });
    expect(logged.error).toBe('no such command');
    expect(logged.result).toBeUndefined();
  });

  it('captures emits from the app — the direction that was previously invisible', () => {
    recordEmit('0/ai-chat', 'reply', { text: 'hello' });

    const [logged] = readLog({ windowKey: '0/ai-chat' });
    expect(logged.direction).toBe('in');
    expect(logged.kind).toBe('emit');
    expect(logged.name).toBe('reply');
    expect(logged.params).toEqual({ text: 'hello' });
  });

  it('preserves ordering across directions, so a double-emit is visible as two entries', () => {
    const entry = beginRequest('0/ai-chat', { kind: 'command', command: 'send' });
    endRequest(entry, { kind: 'command', result: null }, 1);
    recordEmit('0/ai-chat', 'reply', { n: 1 });
    recordEmit('0/ai-chat', 'reply', { n: 2 });

    const log = readLog({ windowKey: '0/ai-chat' });
    expect(log.map((e) => `${e.direction}:${e.kind}`)).toEqual([
      'out:command',
      'in:emit',
      'in:emit',
    ]);
    // Sequence numbers are monotonic, so ordering survives even if timestamps collide.
    expect(log[0].seq).toBeLessThan(log[1].seq);
    expect(log[1].seq).toBeLessThan(log[2].seq);
  });

  it('scopes reads to one window, and reads every window when unscoped', () => {
    recordEmit('0/ai-chat', 'reply', {});
    recordEmit('1/ai-chat', 'reply', {});

    expect(readLog({ windowKey: '0/ai-chat' })).toHaveLength(1);
    expect(readLog({ windowKey: '1/ai-chat' })).toHaveLength(1);
    expect(readLog()).toHaveLength(2);
  });

  it('truncates a fat payload instead of storing it whole', () => {
    recordEmit('0/ai-chat', 'blob', 'x'.repeat(10_000));

    const [logged] = readLog({ windowKey: '0/ai-chat' });
    expect(String(logged.params)).toContain('truncated');
    expect(String(logged.params).length).toBeLessThan(3_000);
  });

  it('does not record devtools polling its own console', () => {
    // The console panel polls __console twice a second and each reply carries the whole
    // accumulated buffer back. Logged, those replays buried the two entries the log was
    // opened to read — and evicted real traffic on the way, since the buffer is finite.
    for (let i = 0; i < 20; i++) {
      const poll = beginRequest('0/devtools-preview-1', { kind: 'query', stateKey: '__console' });
      endRequest(poll, { kind: 'query', data: [{ level: 'log', args: ['noise'] }] }, 2);
    }
    const cmd = beginRequest('0/devtools-preview-1', { kind: 'command', command: 'increment' });
    endRequest(cmd, { kind: 'command', result: { count: 1 } }, 5);

    const log = readLog({ windowKey: '0/devtools-preview-1' });
    expect(log).toHaveLength(1);
    expect(log[0].name).toBe('increment');
  });

  it('still records an ordinary query', () => {
    // Only the console poll is filtered — a state query is exactly the traffic the log is for.
    const entry = beginRequest('0/ai-chat', { kind: 'query', stateKey: 'messages' });
    endRequest(entry, { kind: 'query', data: [] }, 3);

    expect(readLog({ windowKey: '0/ai-chat' })).toHaveLength(1);
  });

  it('evicts oldest entries rather than growing without bound', () => {
    for (let i = 0; i < 600; i++) recordEmit('0/ai-chat', 'tick', { i });

    const log = readLog({ windowKey: '0/ai-chat', limit: 1000 });
    expect(log.length).toBeLessThanOrEqual(500);
    // The survivors are the newest ones.
    expect((log.at(-1)!.params as { i: number }).i).toBe(599);
  });
});
