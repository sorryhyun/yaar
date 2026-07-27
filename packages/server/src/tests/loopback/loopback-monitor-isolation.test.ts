/**
 * S9 — what one desktop did stays on that desktop.
 *
 * Monitors are separate desktops with separate agents, and S8.2 already proves a turn on
 * monitor 1 does not carry monitor 0's *message*. Two other things reached across anyway,
 * and both of them landed in the prompt:
 *
 *  - the interaction timeline was one object per session, so whichever monitor spoke next
 *    drained everything the user had done on every desktop — and drained it *away* from
 *    the monitor it belonged to, which never saw it at all;
 *  - `<open_windows>` was the session's whole window list under a `monitor="1"` label, so
 *    monitor 1's agent was told it had monitor 0's windows and could address them.
 *
 * Both are asserted here on the real stack: the interactions go through `USER_INTERACTION`
 * frames on the tab that performed them, and the windows through the session's own
 * registry, so what the assertions read is the prompt the provider was actually handed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Mint monitor 1 and open a tab on it. */
async function addSecondMonitor(h: Harness) {
  void h.client.deliverAsync({ type: ClientEventType.ADD_MONITOR });
  const frame = await expectSettlesWithin(
    h.client.waitForFrame(ServerEventType.MONITORS, (f) => f.focus !== undefined),
    1000,
    'the MONITORS frame',
  );
  expect(frame.focus).toBe('1');
  return h.connect('1');
}

/** The prompt of the most recent turn that ran on this monitor. */
function lastPromptOn(h: Harness, monitorId: string): string {
  const turns = h.registry.turns.filter((t) => t.monitorId === monitorId);
  expect(turns.length).toBeGreaterThan(0);
  return turns.at(-1)!.prompt;
}

/** Send a message and wait for its turn to finish. */
async function say(
  h: Harness,
  client: Harness['client'],
  monitorId: string,
  messageId: string,
  content: string,
): Promise<void> {
  await expectSettlesWithin(
    client.deliverAsync({ type: ClientEventType.USER_MESSAGE, messageId, monitorId, content }),
    2000,
    `monitor ${monitorId}'s turn`,
  );
}

describe('S9.1 — the timeline belongs to the monitor the interaction happened on', () => {
  it('monitor 0 focusing a window is drained into monitor 0, not into monitor 1', async () => {
    const h = await boot();
    harness = h;
    h.registry.onTurn(() => [{ kind: 'text', content: 'ok' }]);

    const notes = h.seedIframeWindow('notes', { monitorId: '0' });
    const tab1 = await addSecondMonitor(h);
    // The pool — and with it the timelines — is built by the first message, so an
    // interaction before one is recorded nowhere. Say something first.
    await say(h, h.client, '0', 'm-a1', 'hello');

    // The user clicks a window on monitor 0. Nothing is said to any agent yet.
    await h.client.deliver({
      type: ClientEventType.USER_INTERACTION,
      interactions: [{ type: 'window.focus', timestamp: 1, windowId: notes }],
    });

    // Monitor 1 speaks first. It must not be told about a click on another desktop —
    // and, just as importantly, must not consume it.
    await say(h, tab1, '1', 'm-b1', 'what is on my desktop');
    const onOne = lastPromptOn(h, '1');
    expect(onOne).not.toContain('<ui:focus>');
    expect(onOne).not.toContain('notes');

    // Monitor 0 speaks next, and its own click is still there waiting for it.
    await say(h, h.client, '0', 'm-a2', 'and mine');
    expect(lastPromptOn(h, '0')).toContain('<ui:focus>');
  });
});

describe("S9.2 — open_windows is the monitor's windows, not the session's", () => {
  it("monitor 1 is told about its own window and not about monitor 0's", async () => {
    const h = await boot();
    harness = h;
    h.registry.onTurn(() => [{ kind: 'text', content: 'ok' }]);

    h.seedIframeWindow('notes', { monitorId: '0' });
    const tab1 = await addSecondMonitor(h);
    h.seedIframeWindow('clock', { monitorId: '1' });

    await say(h, tab1, '1', 'm-b', 'list what is open');

    const onOne = lastPromptOn(h, '1');
    expect(onOne).toContain('<open_windows monitor="1">');
    expect(onOne).toContain('yaar://windows/clock');
    expect(onOne).not.toContain('yaar://windows/notes');

    await say(h, h.client, '0', 'm-a', 'and here');

    const onZero = lastPromptOn(h, '0');
    expect(onZero).toContain('yaar://windows/notes');
    expect(onZero).not.toContain('yaar://windows/clock');
  });
});
