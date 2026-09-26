/**
 * The three pieces both providers share for running a turn: the input channel,
 * the steer gate, and the deadline under it.
 *
 * Each existed twice before, once per provider, and the copies had drifted:
 *
 * 1. **`withDeadline` clears its timer on every path.** The Codex steer raced its
 *    wait against a bare `setTimeout` that was never cleared, so every steer left
 *    a live 10s timer behind.
 * 2. **The channel's close is drain-then-done.** Items queued before `close()`
 *    are delivered, a pull already parked wakes and sees done, and a push after
 *    close is dropped rather than delivered-or-not depending on timing.
 * 3. **`isLast` ends the channel behind the item.** This is how the Codex loop
 *    stopped deciding turn end a second time from raw method names.
 * 4. **A steer waits for its turn and only its turn** — it refuses when idle,
 *    when the turn ends or is replaced under it, and when it never starts.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { withDeadline } from '../providers/deadline.js';
import { createInputChannel } from '../providers/input-channel.js';
import { TurnGate } from '../providers/turn-gate.js';

/** Count the timers armed and not yet fired or cleared, by wrapping the globals. */
function trackTimers() {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = realSet(() => {
      live.delete(id);
      fn(...args);
    }, ms);
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    live.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  return {
    live: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

let timers: ReturnType<typeof trackTimers> | null = null;
afterEach(() => {
  timers?.restore();
  timers = null;
});

describe('withDeadline', () => {
  it('clears its timer when the promise resolves first', async () => {
    timers = trackTimers();
    expect(await withDeadline(Promise.resolve('ok'), 10_000)).toBe('ok');
    expect(timers.live()).toBe(0);
  });

  it('clears its timer when the promise rejects first', async () => {
    timers = trackTimers();
    await expect(withDeadline(Promise.reject(new Error('no')), 10_000)).rejects.toThrow('no');
    expect(timers.live()).toBe(0);
  });

  it('rejects once the deadline passes', async () => {
    await expect(withDeadline(new Promise(() => {}), 5)).rejects.toThrow('timed out after 5ms');
  });
});

describe('createInputChannel', () => {
  it('delivers in push order, across pulls that park and wake', async () => {
    const channel = createInputChannel<number>();
    channel.push(1);
    const parked = (async () => {
      const seen: number[] = [];
      for await (const n of channel.iterable) seen.push(n);
      return seen;
    })();
    await Promise.resolve();
    channel.push(2);
    channel.push(3);
    channel.close();
    expect(await parked).toEqual([1, 2, 3]);
  });

  it('wakes a pull parked on an empty channel when it closes', async () => {
    const channel = createInputChannel<string>();
    const pull = channel.iterable.next();
    channel.close();
    expect(await pull).toEqual({ value: undefined, done: true });
  });

  it('drains what was queued before close, then reports done', async () => {
    const channel = createInputChannel<string>();
    channel.push('a');
    channel.push('b');
    channel.close();
    expect((await channel.iterable.next()).value).toBe('a');
    expect((await channel.iterable.next()).value).toBe('b');
    expect((await channel.iterable.next()).done).toBe(true);
  });

  it('drops a push after close', async () => {
    const channel = createInputChannel<string>();
    channel.close();
    channel.push('late');
    expect(channel.closed).toBe(true);
    expect((await channel.iterable.next()).done).toBe(true);
  });

  it('closes behind an item isLast accepts, and drops what follows', async () => {
    const channel = createInputChannel<string>({ isLast: (s) => s === 'end' });
    channel.push('a');
    channel.push('end');
    channel.push('after');
    expect(channel.closed).toBe(true);
    const seen: string[] = [];
    for await (const s of channel.iterable) seen.push(s);
    expect(seen).toEqual(['a', 'end']);
  });
});

describe('TurnGate', () => {
  it('refuses at once with no turn in flight', async () => {
    const gate = new TurnGate();
    expect(gate.active).toBe(false);
    expect(await gate.waitForStart(10_000)).toEqual({ ok: false, reason: 'idle' });
  });

  it('answers at once for a turn already started, without arming a timer', async () => {
    timers = trackTimers();
    const gate = new TurnGate<string>();
    gate.begin().start('turn-1');
    expect(await gate.waitForStart(10_000)).toEqual({ ok: true, value: 'turn-1' });
    expect(timers.live()).toBe(0);
  });

  it('waits for the start, then clears its timer', async () => {
    timers = trackTimers();
    const gate = new TurnGate<string>();
    const turn = gate.begin();
    expect(gate.active).toBe(true);
    expect(gate.current).toBeUndefined();

    const waiting = gate.waitForStart(10_000);
    turn.start('turn-1');

    expect(await waiting).toEqual({ ok: true, value: 'turn-1' });
    expect(gate.current).toBe('turn-1');
    // The Codex copy's leak: the race was won, and its 10s timer lived on.
    expect(timers.live()).toBe(0);
  });

  it('wakes a waiter as soon as its turn ends unstarted', async () => {
    timers = trackTimers();
    const gate = new TurnGate();
    const turn = gate.begin();
    const waiting = gate.waitForStart(10_000);
    turn.end();
    expect(await waiting).toEqual({ ok: false, reason: 'ended' });
    expect(gate.active).toBe(false);
    expect(timers.live()).toBe(0);
  });

  it('refuses when a newer turn replaced the one it waited on', async () => {
    const gate = new TurnGate<string>();
    gate.begin();
    const waiting = gate.waitForStart(10_000);
    const next = gate.begin();
    next.start('turn-2');
    expect(await waiting).toEqual({ ok: false, reason: 'ended' });
  });

  it('does not let a stale handle end or start the turn that replaced it', async () => {
    const gate = new TurnGate<string>();
    const stale = gate.begin();
    const current = gate.begin();
    stale.start('turn-1');
    stale.end();
    expect(gate.active).toBe(true);
    expect(gate.current).toBeUndefined();
    current.start('turn-2');
    expect(gate.current).toBe('turn-2');
  });

  it('times out a turn that never starts', async () => {
    const gate = new TurnGate();
    gate.begin();
    expect(await gate.waitForStart(5)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('reset ends the turn in flight and wakes its waiter', async () => {
    const gate = new TurnGate();
    gate.begin();
    const waiting = gate.waitForStart(10_000);
    gate.reset();
    expect(await waiting).toEqual({ ok: false, reason: 'ended' });
    expect(gate.active).toBe(false);
  });
});
