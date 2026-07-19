/**
 * The socket's message queue must not hold an answer behind the frame that is waiting for it.
 *
 * `WsData.queue` serializes a connection's frames so a buffered `window.create` lands before
 * the `RESYNC` behind it. But `routeOne` awaits `routeMessage`, and `routeMessage` awaits the
 * whole agent turn (`handleTask` → `handleAppTask` → `runAgentTurn`). So while a turn runs,
 * the frame that started it sits at the head of the queue holding everything behind it.
 *
 * That closed a cycle. An app-agent turn calls the app-protocol `command` tool and waits for
 * an `APP_PROTOCOL_RESPONSE` — which arrives on the *same socket* and queues behind the frame
 * that started the turn. The turn cannot finish until the reply is read; the reply cannot be
 * read until the turn finishes. The only thing that broke it was the request's own deadline,
 * so every reply landed exactly one deadline late and the agent was told "App did not respond"
 * about an app that had answered instantly.
 *
 * The rule these tests encode: **frames that answer a pending server-side wait overtake the
 * queue; everything else keeps its order.**
 *
 * **This is a unit test of queue *policy*, and it is not the deadlock's regression test.**
 * Worth being blunt about, because it looks like one. Its session is a stub that records
 * event types: no `LiveSession`, no `ContextPool`, no turn. So it would stay green if
 * `routeMessage` itself regressed, and it stayed green through the entire life of the bug it
 * appears to be about — the bug was never in this queue, it was in the composition of this
 * queue with a turn that waits for a frame *behind* the one it is holding. Nothing that mocks
 * one side of that seam can see it.
 *
 * The regression test is `tests/loopback/loopback-app-protocol.test.ts` (S1), which runs the
 * real stack and answers on the real socket. Keep this file — it is cheap and it pins the
 * policy precisely — but if you are changing the answer-frame bypass, that is the file that
 * has to go red.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Only `message()` is exercised, and it reaches exactly one collaborator: the session hub.
//
// The stub below replaces `session-hub.js` for the whole Bun process — `mock.module` has no
// file scope, no teardown, and `mock.restore()` cannot undo it once the real module has been
// loaded, which by then it has. So this is not a local decision: it is the hub that every
// file running after this one gets. A stub with only `get()` on it therefore hands the next
// file `getSessionHub().registerAgent is not a function` the moment that file builds a real
// AgentPool — which is a live landmine in this suite, disarmed only by Bun happening to run
// this file last. It went off the first time a new test file changed that order.
//
// A leaking mock cannot be made not to leak, so it is made harmless instead: the full hub
// surface, no-ops except the one method this file actually needs to fake.

/** Frames the session actually got to see, in the order it saw them. */
let routed: string[] = [];
/** Held open to stand in for an agent turn that has not finished. */
let releaseTurn: () => void = () => {};

const fakeSession = {
  routeMessage: async (event: { type: string }) => {
    routed.push(event.type);
    // USER_MESSAGE is the frame whose routeMessage awaits an entire agent turn.
    if (event.type === 'USER_MESSAGE') {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    }
  },
};

const fakeHub = {
  // The one method this file is actually about.
  get: () => fakeSession,
  // The rest of the surface, so that leaking this stub into the next file is inert rather
  // than fatal. See the note above.
  getDefault: () => undefined,
  getOrCreate: () => fakeSession,
  attach: () => ({ session: fakeSession, recoveryMode: 'created' }),
  waitFor: async () => fakeSession,
  remove: async () => {},
  registerAgent: () => {},
  unregisterAgent: () => {},
  scheduleEviction: () => {},
  cancelEviction: () => {},
  findSessionByAgent: () => undefined,
  findMonitorForAgent: () => undefined,
  findWindowForAgent: () => undefined,
  findRoleForAgent: () => undefined,
};

mock.module('../session/session-hub.js', () => ({
  getSessionHub: () => fakeHub,
  initSessionHub: () => fakeHub,
}));

const { createWsHandlers } = await import('../websocket/server.js');

// ── Helpers ────────────────────────────────────────────────────────────────

type WsLike = ServerWebSocket<{
  kind: 'frontend' | 'bridge';
  connectionId: string;
  sessionId: string | null;
  monitorId: string | null;
  queue?: Promise<void>;
}>;

function createWs(): WsLike {
  return {
    data: {
      kind: 'frontend',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      monitorId: '0',
    },
    send: () => {},
    readyState: 1,
  } as unknown as WsLike;
}

const handlers = createWsHandlers({ restoreActions: [], contextMessages: [] });

function send(ws: WsLike, event: Record<string, unknown>) {
  return handlers.message(ws, JSON.stringify(event));
}

/** Let every already-queued microtask run, without advancing any real timer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WebSocket head-of-line blocking', () => {
  beforeEach(() => {
    routed = [];
    releaseTurn = () => {};
  });

  it('lets an APP_PROTOCOL_RESPONSE overtake the agent turn that is waiting for it', async () => {
    const ws = createWs();

    // A frame whose turn will not finish until the app answers.
    send(ws, { type: 'USER_MESSAGE', messageId: 'm1', content: 'hi', monitorId: '0' });
    await settle();
    expect(routed).toEqual(['USER_MESSAGE']); // turn is in flight, holding the queue

    // The app's answer, arriving on the same socket.
    send(ws, {
      type: 'APP_PROTOCOL_RESPONSE',
      requestId: 'req-1',
      windowId: '0/ai-chat',
      response: { kind: 'command', result: { ok: true } },
    });
    await settle();

    // This is the whole bug: before the fix the reply sat behind the unfinished turn, so
    // the turn could only end by timing out — and it timed out *on this very reply*.
    expect(routed).toEqual(['USER_MESSAGE', 'APP_PROTOCOL_RESPONSE']);

    releaseTurn();
    await settle();
  });

  it('lets every answer frame overtake, not just the app-protocol one', async () => {
    const ws = createWs();
    send(ws, { type: 'USER_MESSAGE', messageId: 'm1', content: 'hi', monitorId: '0' });
    await settle();

    // Each of these resolves a PendingStore entry (or a waitForAppReady) that a running turn
    // may be blocked on — a rendering capture, a permission dialog, a prompt, a registration.
    send(ws, { type: 'RENDERING_FEEDBACK', requestId: 'r1', windowId: 'w', success: true });
    send(ws, { type: 'DIALOG_FEEDBACK', dialogId: 'd1', confirmed: true });
    send(ws, { type: 'USER_PROMPT_RESPONSE', promptId: 'p1', text: 'yes' });
    send(ws, { type: 'APP_PROTOCOL_READY', windowId: '0/ai-chat' });
    await settle();

    expect(routed).toEqual([
      'USER_MESSAGE',
      'RENDERING_FEEDBACK',
      'DIALOG_FEEDBACK',
      'USER_PROMPT_RESPONSE',
      'APP_PROTOCOL_READY',
    ]);

    releaseTurn();
    await settle();
  });

  it('lets control frames overtake a turn they have no ordering relationship with', async () => {
    const ws = createWs();
    send(ws, { type: 'USER_MESSAGE', messageId: 'm1', content: 'hi', monitorId: '0' });
    await settle();

    // None of these enter ContextPool's queues — they touch the monitor list, this
    // connection's subscription, or an agent's cancel signal. Behind the turn they were
    // useless: the `+` button appeared dead for the length of the model's reply, and an
    // INTERRUPT could not arrive until the turn it cancels had already finished.
    send(ws, { type: 'ADD_MONITOR' });
    send(ws, { type: 'SUBSCRIBE_MONITOR', monitorId: '1' });
    send(ws, { type: 'INTERRUPT' });
    send(ws, { type: 'REMOVE_MONITOR', monitorId: '1' });
    await settle();

    expect(routed).toEqual([
      'USER_MESSAGE',
      'ADD_MONITOR',
      'SUBSCRIBE_MONITOR',
      'INTERRUPT',
      'REMOVE_MONITOR',
    ]);

    releaseTurn();
    await settle();
  });

  it('still serializes ordinary frames — RESYNC does not overtake the work before it', async () => {
    const ws = createWs();

    send(ws, { type: 'USER_MESSAGE', messageId: 'm1', content: 'hi', monitorId: '0' });
    send(ws, { type: 'RESYNC' });
    await settle();

    // The ordering guarantee the queue exists for: a snapshot must not be built while the
    // frame in front of it is still being applied, or it reports a world that is out of date.
    expect(routed).toEqual(['USER_MESSAGE']);

    releaseTurn();
    await settle();
    expect(routed).toEqual(['USER_MESSAGE', 'RESYNC']);
  });
});
