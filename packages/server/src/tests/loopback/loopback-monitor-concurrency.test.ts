/**
 * S10 — a second monitor is only a second desktop if it can be used while the first thinks.
 *
 * One tab holds one socket. Switching monitors does not open another, so a message typed
 * on monitor 1 travels the same connection as the turn still streaming on monitor 0 — and
 * that connection serialized its frames one at a time. `routeOne` awaits `routeMessage`,
 * and a `USER_MESSAGE` whose monitor agent is idle is processed *inline*, so the frame for
 * monitor 0 held the head of the queue for the whole turn. Monitor 1's message was not
 * slow, not queued, and not refused: it had not been read yet. The desktop looked frozen
 * until the other one finished, which is the opposite of what a second monitor is for.
 *
 * The lanes in `WsData` are the fix — ordering per *thing contended for* rather than per
 * socket. Three rows, because the split is only correct if it keeps what the single chain
 * was there to guarantee:
 *
 *   - two monitors run at once (this is the bug);
 *   - two messages for the *same* monitor still queue behind each other, since
 *     `ContextPool` decides to steer, enqueue or reject by asking whether that agent is
 *     busy right now;
 *   - `RESYNC` still sees everything sent before it, on every lane — it is a barrier
 *     across all of them rather than a member of one.
 *
 * `loopback-ordering.test.ts` holds the same guarantee from the answer-frame side.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred } from './harness/deferred.js';
import { expectSettlesWithin, expectStillPending, expectConcurrent } from './harness/liveness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Mint monitor 1 on the session. The tab stays where it is; only the list grows. */
async function addSecondMonitor(h: Harness): Promise<void> {
  void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
  const frame = await expectSettlesWithin(
    h.client.waitForFrame(ServerEventType.MONITORS, (f) => f.focus !== undefined),
    1000,
    'the MONITORS frame',
  );
  expect(frame.focus).toBe('1');
}

/**
 * A script whose turn parks inside a tool until the test lets go, for prompts containing
 * `held`, and answers immediately otherwise. Returns the two ends of the gate.
 */
function gatedTurns(h: Harness) {
  const entered = deferred<void>();
  const gate = deferred<void>();
  h.registry.onTurn((ctx) =>
    ctx.prompt.includes('held')
      ? [
          {
            kind: 'tool' as const,
            name: 'held',
            run: async () => {
              entered.resolve();
              await gate.promise;
              return 'released';
            },
          },
        ]
      : [{ kind: 'text' as const, content: 'ok' }],
  );
  return { entered, gate };
}

describe('S10 — one monitor thinking does not block the others', () => {
  it('answers a message for monitor 1 while monitor 0 is mid-turn on the same socket', async () => {
    const h = await boot();
    harness = h;
    await addSecondMonitor(h);

    const { entered, gate } = gatedTurns(h);

    const slow = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm-hold',
      monitorId: '0',
      content: 'a held turn',
    });
    await expectSettlesWithin(entered.promise, 1000, 'monitor 0 reaching its tool');

    // Same connection, other desktop. Nothing it needs belongs to the turn in flight.
    const other = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm-other',
      monitorId: '1',
      content: 'a message on the second monitor',
    });

    // Settling *before* the held turn is the whole claim — a serialized queue also
    // settles this eventually, which is precisely why it went unnoticed.
    await expectConcurrent(slow, other, 2000, "monitor 1's turn");

    gate.resolve();
    await expectSettlesWithin(slow, 2000, 'the held turn');

    const monitors = h.registry.turns.map((t) => t.monitorId);
    expect(monitors).toContain('0');
    expect(monitors).toContain('1');
  });

  it('still queues a second message for the same monitor behind the first', async () => {
    const h = await boot();
    harness = h;

    const { entered, gate } = gatedTurns(h);

    const first = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'a held turn',
    });
    await expectSettlesWithin(entered.promise, 1000, 'the turn reaching its tool');

    const second = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: '0',
      content: 'the follow-up',
    });

    // One lane per monitor, so this one is genuinely behind the turn in front of it.
    await expectStillPending(second, "the same monitor's second message");

    gate.resolve();
    await expectSettlesWithin(Promise.all([first, second]), 2000, 'both messages');
  });

  it('holds RESYNC until every lane has been heard, not just its own', async () => {
    const h = await boot();
    harness = h;
    await addSecondMonitor(h);

    const { entered, gate } = gatedTurns(h);

    const slow = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm-hold',
      monitorId: '1',
      content: 'a held turn',
    });
    await expectSettlesWithin(entered.promise, 1000, 'monitor 1 reaching its tool');

    // RESYNC is on no lane and every lane: its contract is "you have now heard everything
    // I sent before this", and the frame it must not overtake is running elsewhere.
    const snapshot = h.client.waitForFrame(ServerEventType.SNAPSHOT);
    const resync = h.client.deliverAsync({ type: ClientEventType.RESYNC });
    await expectStillPending(snapshot, 'the SNAPSHOT');

    gate.resolve();
    await expectSettlesWithin(slow, 2000, 'the held turn');
    await expectSettlesWithin(resync, 2000, 'the RESYNC');
    await expectSettlesWithin(snapshot, 2000, 'the SNAPSHOT');
  });
});
