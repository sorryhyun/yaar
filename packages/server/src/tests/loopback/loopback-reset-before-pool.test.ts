/**
 * S13 — a reset pressed before the first message actually resets.
 *
 * Reset is monitor-scoped from the UI: `CommandPalette` always sends `activeMonitorId`, so
 * the session-wide branch of `handleReset` is unreachable from the desktop. That branch was
 * the only one that dropped what the *previous* session left behind — the restored context
 * tape and the resumable provider threads — and the monitor-scoped branch did nothing at all
 * without a pool, on the reasoning that no pool means no agents and no queues.
 *
 * True of the agents, false of the session: those two fields sit on `LiveSession` until the
 * first message builds the pool out of them (`doInitialize`). So the one moment a user is
 * most likely to press reset — a fresh desktop that just restored yesterday's windows,
 * before typing anything — was the one moment reset was a no-op. The next message resumed
 * the old thread and the old conversation answered, which is exactly what the button was
 * pressed to prevent.
 *
 * Asserted at both ends: the provider must not be asked to resume the saved thread, and the
 * tape the pool is built with must not carry the pruned monitor's messages.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { monitorSource } from '../../agents/context.js';
import { monitorRole } from '../../agents/roles.js';
import type { TransportOptions } from '../../providers/types.js';
import { boot, type Harness } from './harness/boot.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

const PREVIOUS_THREAD = 'thread-from-yesterday';

function bootWithHistory() {
  return boot({
    contextMessages: [
      {
        role: 'user',
        content: 'PREVIOUS_MONITOR_TURN',
        timestamp: '2026-08-14T10:00:00.000Z',
        source: monitorSource('0'),
      },
      {
        role: 'user',
        content: 'OTHER_MONITOR_TURN',
        timestamp: '2026-08-14T10:00:01.000Z',
        source: monitorSource('1'),
      },
    ],
    savedThreadIds: { [monitorRole('0')]: PREVIOUS_THREAD, [monitorRole('1')]: 'other-thread' },
  });
}

/** Records what each turn was handed, since `TurnRecord` keeps the prompt but not the options. */
function recordTurns(h: Harness): { prompt: string; options: TransportOptions }[] {
  const seen: { prompt: string; options: TransportOptions }[] = [];
  h.registry.onTurn((ctx) => {
    seen.push({ prompt: ctx.prompt, options: ctx.options });
    return [{ kind: 'text', content: 'ok' }];
  });
  return seen;
}

describe('S13 — monitor reset before the pool exists', () => {
  it('drops the restored thread and context of the monitor it names', async () => {
    const h = await bootWithHistory();
    harness = h;
    const seen = recordTurns(h);

    await h.client.deliverAsync({ type: ClientEventType.RESET, monitorId: '0' });
    await h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'hello',
    });

    const turn = seen.find((t) => t.prompt.includes('hello'));
    expect(turn).toBeDefined();
    expect(turn!.options.resumeThread).toBeFalsy();
    expect(turn!.options.sessionId).not.toBe(PREVIOUS_THREAD);

    const tape = h.session.getPool()?.contextTape.getMessages({ includeWindows: true }) ?? [];
    expect(tape.some((m) => m.content === 'PREVIOUS_MONITOR_TURN')).toBe(false);
    // Monitor 1 was not the one reset, so its history is still there to resume.
    expect(tape.some((m) => m.content === 'OTHER_MONITOR_TURN')).toBe(true);
  });

  it('leaves an unreset monitor resuming its own thread', async () => {
    const h = await bootWithHistory();
    harness = h;
    const seen = recordTurns(h);

    // Reset first, while there is still no pool — that is the case under test. Monitor 1 is
    // minted afterwards so its turn runs on the fields the reset was free to touch.
    await h.client.deliverAsync({ type: ClientEventType.RESET, monitorId: '0' });
    void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
    const frame = await h.client.waitForFrame(
      ServerEventType.MONITORS,
      (f) => f.focus !== undefined,
    );
    expect(frame.focus).toBe('1');
    const second = await h.connect('1');

    await second.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '1',
      content: 'hello',
    });

    const turn = seen.find((t) => t.prompt.includes('hello'));
    expect(turn).toBeDefined();
    expect(turn!.options.resumeThread).toBe(true);
    expect(turn!.options.sessionId).toBe('other-thread');
  });

  it('drops the restored thread of a monitor that has not spoken yet', async () => {
    // The same defect once a pool exists: another monitor's message builds the pool, so the
    // reset takes `ContextPool.resetMonitor` — which pruned the tape but left this monitor's
    // saved thread for its still-unspent first turn to resume.
    const h = await bootWithHistory();
    harness = h;
    const seen = recordTurns(h);

    void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
    const frame = await h.client.waitForFrame(
      ServerEventType.MONITORS,
      (f) => f.focus !== undefined,
    );
    expect(frame.focus).toBe('1');
    const second = await h.connect('1');

    await h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'wake the pool',
    });
    expect(h.session.getPool()).not.toBeNull();

    await second.deliverAsync({ type: ClientEventType.RESET, monitorId: '1' });
    await second.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: '1',
      content: 'hello',
    });

    const turn = seen.find((t) => t.prompt.includes('hello'));
    expect(turn).toBeDefined();
    expect(turn!.options.resumeThread).toBeFalsy();
    expect(turn!.options.sessionId).not.toBe('other-thread');
  });
});
