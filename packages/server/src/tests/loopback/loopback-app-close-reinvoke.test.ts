/**
 * S7 — closing an app window and re-invoking the app in the same breath.
 *
 * This is a monitor agent's ordinary move: interrupt what the app is doing, close its
 * window, open a fresh one, send it a new instruction. Three things make it a race no
 * other suite could see:
 *
 *   - the close is fire-and-forget (`WindowEventCoordinator` does not await the app
 *     processor's teardown),
 *   - the re-invoke does not come over the socket — `invoke {action:'message'}` calls
 *     `ContextPool.handleTask` directly, so the connection's frame queue, which
 *     serializes everything a *client* sends, does not serialize this,
 *   - and `AgentSession.interrupt()` resolves when the **provider** has stopped, not when
 *     the turn has unwound.
 *
 * So the re-invoke lands in the gap between "the model stopped" and "the turn finished",
 * and used to find the app idle because the close cleared the window queue's flag right
 * there. Two turns then ran on one `AgentSession`, sharing one `running` flag, and it
 * failed in both directions at once: the dying turn's `finally` cleared `running` under
 * the new turn, whose read loop stopped at its next message — the re-invoked window never
 * rendered — while the new turn's `running = true` un-cancelled the interrupted one,
 * which delivered the answer the close existed to throw away.
 *
 * Hence the two assertions below, which are the same bug seen from each end: the new
 * message must be answered, and the cancelled one must stay cancelled.
 *
 * The close also *retires* the app agent now, when the window it closed was the app's last
 * one on that monitor — the rule sub-agents already followed. That is a lifecycle change,
 * not a consequence of the race, and it has its own two rows here: the replacement must be
 * a genuinely new agent (a close means start over, memory included), and an app with a
 * second window still open must keep the agent that is driving it.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType, type OSAction } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred } from './harness/deferred.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

const APP = 'memo';

/** Let the fire-and-forget close teardown run. Not a guess: nothing else announces it. */
async function settleClose(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

/** Every non-empty assistant response the session broadcast. */
function responses(h: Harness): string[] {
  return h.client
    .framesOf(ServerEventType.AGENT_RESPONSE)
    .map((f) => f.content)
    .filter(Boolean);
}

describe('S7 — an app window closed mid-turn, then re-invoked', () => {
  it('answers the re-invoked message, and leaves the interrupted one cancelled', async () => {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow(APP);
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    const parkedFirst = deferred();
    const releaseFirst = deferred();
    const parkedSecond = deferred();
    const releaseSecond = deferred();

    // Both turns park in a tool, so the test decides the interleaving rather than the
    // scheduler. The order that matters is: turn two is *mid-flight* when turn one
    // unwinds — a turn two that starts and finishes inside the gap never touches the
    // shared flag and would pass either way.
    h.registry.onTurn((ctx) =>
      ctx.prompt.includes('SECOND')
        ? [
            {
              kind: 'tool',
              name: 'park-second',
              run: async () => {
                parkedSecond.resolve();
                await releaseSecond.promise;
                return 'done';
              },
            },
            { kind: 'text', content: 'SECOND-ANSWER' },
          ]
        : [
            {
              kind: 'tool',
              name: 'park-first',
              run: async () => {
                parkedFirst.resolve();
                await releaseFirst.promise;
                return 'done';
              },
            },
            { kind: 'text', content: 'FIRST-ANSWER' },
          ],
    );

    // The app agent is working — genuinely parked inside a tool, the way it is parked on
    // an MCP round trip in production.
    const first = h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'FIRST do a long thing',
    });
    await parkedFirst.promise;

    // The monitor agent closes the window. Fire-and-forget, exactly as `window.close` is.
    h.session.windowState.handleAction({ type: 'window.close', windowId: APP } as OSAction, '0');
    await settleClose();

    // ...and re-invokes the app on a fresh window, straight into the pool. The first turn
    // has not unwound yet: this is the gap.
    const windowKey2 = h.seedIframeWindow(APP);
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey2 });
    const second = h.session.getPool()!.handleTask({
      requestedType: 'app',
      kind: 'relay',
      messageId: 'm2',
      windowId: APP,
      content: '<monitor:0>SECOND please answer</monitor:0>',
      monitorId: '0',
    });

    // Under the fix turn two is queued and has not started, so this resolves nothing and
    // the wait below falls through on its timer; under the race it is already parked, and
    // releasing turn one now is what used to cut it off.
    await Promise.race([parkedSecond.promise, new Promise((r) => setTimeout(r, 250))]);
    releaseFirst.resolve();
    await settleClose();
    releaseSecond.resolve();

    await first;
    await second;
    await settleClose();

    // The stall. Under the race this turn ran and produced nothing at all.
    expect(h.registry.turns.some((t) => t.prompt.includes('SECOND'))).toBe(true);
    expect(responses(h).join('|')).toContain('SECOND-ANSWER');

    // The other half: an interrupted turn must not be revived by the turn that follows it.
    expect(responses(h).join('|')).not.toContain('FIRST-ANSWER');

    // And it answered on a *new* agent: that was the app's last window, so the close
    // retired the one that had been driving it. `agentId` here is the `AgentSession`
    // instance, which is what owns the provider thread and therefore the memory.
    const [before, after] = h.registry.turns;
    expect(before!.agentId).toBeDefined();
    expect(after!.agentId).not.toBe(before!.agentId);
  }, 15000);

  it('keeps the agent when the app still has another window on the monitor', async () => {
    // The agent is keyed `monitorId::appId` and drives every window of the app on that
    // monitor. Retiring it on any close would kill the agent still working in the others,
    // so the trigger is the app leaving the desktop, not a window leaving the screen.
    const h = await boot();
    harness = h;
    const first = h.seedIframeWindow(APP);
    const second = h.seedIframeWindow(`${APP}-2`, { appId: APP });
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: first });
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: second });

    h.registry.onTurn(() => [{ kind: 'text', content: 'ANSWER' }]);

    await h.client.deliver({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: first,
      content: 'hello from the first window',
    });

    // Close one of the two. The app is still on this desktop.
    h.session.windowState.handleAction({ type: 'window.close', windowId: APP } as OSAction, '0');
    await settleClose();

    await h.client.deliver({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm2',
      windowId: second,
      content: 'hello from the second window',
    });
    await settleClose();

    expect(h.registry.turns).toHaveLength(2);
    expect(h.registry.turns[1]!.agentId).toBe(h.registry.turns[0]!.agentId);
  }, 15000);

  it('does not leave the app wedged as busy after the close', async () => {
    // The close no longer clears the window queue's is-processing flag itself — it waits
    // for the turn, whose `finally` clears it. That is only correct if the turn always
    // reaches that `finally`; a wait on a flag nobody clears is an app that never accepts
    // another message. So: close mid-turn, let everything settle, then knock again.
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow(APP);
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    const parked = deferred();
    const release = deferred();

    h.registry.onTurn((ctx) =>
      ctx.prompt.includes('THIRD')
        ? [{ kind: 'text', content: 'THIRD-ANSWER' }]
        : [
            {
              kind: 'tool',
              name: 'park',
              run: async () => {
                parked.resolve();
                await release.promise;
                return 'done';
              },
            },
            { kind: 'text', content: 'FIRST-ANSWER' },
          ],
    );

    const first = h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'FIRST do a long thing',
    });
    await parked.promise;

    h.session.windowState.handleAction({ type: 'window.close', windowId: APP } as OSAction, '0');
    release.resolve();
    await first;
    await settleClose();

    const reopened = h.seedIframeWindow(APP);
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: reopened });
    await h.client.deliver({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm3',
      windowId: reopened,
      content: 'THIRD are you there',
    });
    await settleClose();

    expect(responses(h).join('|')).toContain('THIRD-ANSWER');
    expect(h.client.framesOf(ServerEventType.ERROR).map((e) => e.error)).toEqual([]);
  }, 15000);
});
