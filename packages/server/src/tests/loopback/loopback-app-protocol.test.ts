/**
 * S1 — the app-protocol round trip, end to end. The one test that mattered.
 *
 * An app-agent turn calls the `command` tool. The tool sends an `APP_PROTOCOL_REQUEST` out
 * over the socket and parks on a `PendingStore` entry. The browser answers on that same
 * socket. The turn reads the answer and finishes.
 *
 * Every piece of that is real here: the frame goes through `createWsHandlers().message()`
 * into `LiveSession.routeMessage`, which awaits `ContextPool.handleTask`, which awaits an
 * `AgentSession` turn, whose provider stream is parked on `handleAppCommand` →
 * `actionEmitter.emitAppProtocolRequest` → `PendingStore`. The reply comes back in through
 * the same `message()` handler. Only the browser and the model are fakes.
 *
 * Which means the cycle is real too. `routeMessage` awaits the whole turn, and
 * `ws.data.queue` serializes a connection's frames — so the frame that *started* the turn
 * sits at the head of the queue holding the reply that would *end* it. The turn cannot
 * finish until the reply is read; the reply cannot be read until the turn finishes. That
 * is broken only by the request's own deadline, which is why every app command came back
 * "App did not respond" about an app that had answered in milliseconds.
 *
 * MUTATION CHECK — re-run by hand on any change to `websocket/server.ts`:
 *   delete the `isAnswerEvent(event.type)` bypass in `message()` (so answers queue behind
 *   the frame they answer) and this file must go red in under a second. If it does not,
 *   the harness is lying and must be fixed before anything is built on it.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin, expectStillPending } from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** A booted session with one registered iframe app, and a browser that answers commands. */
async function bootAppSession(opts: { answerWith?: unknown; delayMs?: number } = {}) {
  const h = await boot();
  harness = h;
  const windowKey = h.seedIframeWindow('memo');
  const appState: Record<string, unknown> = {
    memos: [],
  };

  // The app registers with the protocol the way a real iframe does — a frame on the wire,
  // not a direct call to `notifyAppReady`. `requireAppReady` is a wait like any other.
  await h.client.deliver({
    type: ClientEventType.APP_PROTOCOL_READY,
    windowId: windowKey,
  });

  // The browser: sees the request, answers it with the same requestId, on the same socket.
  h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, async (frame) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const response =
      frame.request.kind === 'query'
        ? { kind: 'query' as const, data: appState[frame.request.stateKey] }
        : { kind: 'command' as const, result: opts.answerWith ?? 'pong' };
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: frame.requestId,
      windowId: frame.windowId,
      response,
    });
  });

  return {
    h,
    windowKey,
    setState(stateKey: string, value: unknown) {
      appState[stateKey] = value;
    },
  };
}

/** A turn whose single tool step is the real `command` handler against the real registry. */
function scriptCommandTurn(h: Harness, windowKey: string, command = 'ping') {
  h.registry.onTurn(() => [
    { kind: 'text', content: 'sending the command' },
    {
      kind: 'tool',
      name: 'command',
      run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command }),
    },
    { kind: 'text', content: (ctx) => `app said: ${JSON.stringify(ctx.results[0])}` },
  ]);
}

describe('S1 — an app command completes while the client answers on the same socket', () => {
  it("the turn finishes well inside its deadline, and the agent gets the app's answer", async () => {
    const { h, windowKey } = await bootAppSession({ answerWith: 'pong' });
    scriptCommandTurn(h, windowKey);

    const turn = h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'ping the app',
    });

    // Red under the deadlock. The command deadline is 150ms here, so a deadlocked turn
    // still *ends* — at its deadline, with a lie — which is precisely why a value-only
    // assertion could never see this bug and a liveness one alone would not either. Both,
    // then: it must finish quickly, AND it must finish with the app's answer.
    await expectSettlesWithin(turn, 500, 'the app-command turn');

    expect(h.registry.tools).toHaveLength(1);
    const tool = h.registry.tools[0]!;
    expect(tool.name).toBe('command');
    expect(tool.text).toBe('pong');
    expect(tool.text).not.toContain('App did not respond');
  });

  it('asks the app exactly once, and tells it how long the server will wait', async () => {
    const { h, windowKey } = await bootAppSession();
    scriptCommandTurn(h, windowKey);

    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.WINDOW_MESSAGE,
        messageId: 'm1',
        windowId: windowKey,
        content: 'ping the app',
      }),
      500,
      'the app-command turn',
    );

    const requests = h.client
      .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
      .filter((frame) => frame.request.kind === 'command');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request).toEqual({ kind: 'command', command: 'ping', params: undefined });
    // The frontend relays the postMessage leg and must not run a clock of its own — this
    // deadline is the only one. A missing `timeoutMs` is how a private 5s relay timer came
    // to punish every command slower than "instant".
    expect(requests[0]!.timeoutMs).toBe(150);
  });

  it('the reply is what ends the wait — until it arrives, the turn is genuinely parked', async () => {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow('ai-chat');
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    scriptCommandTurn(h, windowKey);

    // A browser that says nothing until this test tells it to.
    const asked = h.client.waitForFrame(ServerEventType.APP_PROTOCOL_REQUEST);

    const turn = h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'ping the app',
    });

    // The question was asked, and the turn is parked on it — the wait is real, not a value
    // some mock handed back. This is the assertion that says the round trip in the tests
    // above went *through* the wait rather than around it.
    const request = await expectSettlesWithin(asked, 500, 'the APP_PROTOCOL_REQUEST');
    await expectStillPending(turn, 'the app-command turn');

    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: request.requestId,
      windowId: request.windowId,
      response: { kind: 'command', result: 'late but real' },
    });

    await expectSettlesWithin(turn, 500, 'the app-command turn');
    expect(h.registry.tools[0]!.text).toBe('late but real');
  });

  it('reports whether declared app state changed after the previous handoff', async () => {
    const { h, windowKey, setState } = await bootAppSession();
    h.registry.onTurn(() => [{ kind: 'text', content: 'done' }]);

    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.WINDOW_MESSAGE,
        messageId: 'm1',
        windowId: windowKey,
        content: 'first invocation',
      }),
      500,
      'the first app turn and its handoff snapshot',
    );
    expect(h.registry.turns[0]!.prompt).not.toContain('<app_state_since_handoff');

    setState('memos', [{ id: 'user-1', title: 'Edited after handoff' }]);

    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.WINDOW_MESSAGE,
        messageId: 'm2',
        windowId: windowKey,
        content: 'second invocation',
      }),
      500,
      'the changed-state app turn',
    );
    expect(h.registry.turns[1]!.prompt).toContain('<app_state_since_handoff changed="true" />');

    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.WINDOW_MESSAGE,
        messageId: 'm3',
        windowId: windowKey,
        content: 'third invocation',
      }),
      500,
      'the unchanged-state app turn',
    );
    expect(h.registry.turns[2]!.prompt).toContain('<app_state_since_handoff changed="false" />');
  });

  it('sendInteraction invokes the app agent when it is idle', async () => {
    const { h, windowKey } = await bootAppSession();
    h.registry.onTurn(() => [{ kind: 'text', content: 'handled interaction' }]);

    await h.client.deliver({
      type: ClientEventType.APP_INTERACTION,
      messageId: 'activity-1',
      windowId: windowKey,
      content: '<app_interaction>User changed status to done</app_interaction>',
    });

    expect(h.registry.turns).toHaveLength(1);
    expect(h.registry.turns[0]!.prompt).toContain('User changed status to done');
  });
});
