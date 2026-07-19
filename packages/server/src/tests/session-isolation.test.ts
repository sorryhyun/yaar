/**
 * Phase 0A — a frontend-directed event belongs to exactly one session.
 *
 * The `actionEmitter` is a process-global singleton and every `LiveSession` listens to it,
 * so "who is this for?" has to be answered by the envelope. Two channels used not to
 * answer it, and both had the same shape of bug: the payload carried no `sessionId`, every
 * session heard every emit, and every session acted on it as if it were its own.
 *
 * What that cost, concretely — none of it visible with one browser open, all of it real
 * with two (`REMOTE=1`, a phone and a laptop on the same YAAR):
 *
 *   - **`action`** — `LiveSession.handleEmittedAction()` applied every action to its own
 *     `WindowStateRegistry`, woke its own `yaar://windows` subscribers, and billed
 *     `event.monitorId` to its **own** monitor's budget. Monitor IDs are session-local and
 *     every session has a monitor `0`, so session B's rate limit paid for session A's work.
 *   - **`app-protocol`** — the pending entry was created against the caller's session, but
 *     the request went out unaddressed, so every session relayed it to its own iframes. A
 *     window key ("0/ai-chat") names a *place* on a desktop and two browsers looking at the
 *     same YAAR have the same places, so two different iframes could both be asked and both
 *     answer. The first answer won the one global pending entry — possibly the wrong app's.
 *
 * These tests are written against the delivery boundary (`LiveSession`), not the emitter's
 * internals, because that is where the damage was done: the emitter was always *told* which
 * session it was acting for. It just did not pass it on.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import { actionEmitter } from '../session/action-emitter.js';
import { LiveSession } from '../session/live-session.js';
import { getBroadcastCenter } from '../session/broadcast-center.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId, YaarWebSocket } from '../session/types.js';

const WINDOW = '0/ai-chat';

function fakeSocket(sink: ServerEvent[]): YaarWebSocket {
  return {
    readyState: 1, // WS_OPEN
    send: (data: string) => sink.push(JSON.parse(data) as ServerEvent),
  } as unknown as YaarWebSocket;
}

/** Run as an agent on `sessionId` would — the context every emit resolves its target from. */
function asAgent<T>(sessionId: SessionId, fn: () => T): T {
  return runWithAgentContext({ agentId: `agent-${sessionId}`, sessionId, monitorId: '0' }, fn);
}

/**
 * Two live sessions, each with one connected tab, as two browsers pointed at one YAAR.
 *
 * They deliberately share a monitor id (`0`) and a window key: that overlap is not an edge
 * case to be avoided in the fixture, it is the whole subject. Every session has a monitor
 * `0`, and window keys are derived from the app id, so two desktops showing the same app
 * agree on the key by construction.
 */
function twoSessions() {
  const a = { id: 'sess-iso-a' as SessionId, events: [] as ServerEvent[] };
  const b = { id: 'sess-iso-b' as SessionId, events: [] as ServerEvent[] };
  const bc = getBroadcastCenter();

  const sessionA = new LiveSession(a.id);
  const sessionB = new LiveSession(b.id);
  bc.subscribe('conn-iso-a', fakeSocket(a.events), a.id);
  bc.subscribe('conn-iso-b', fakeSocket(b.events), b.id);

  return {
    a,
    b,
    sessionA,
    sessionB,
    async dispose() {
      bc.unsubscribe('conn-iso-a');
      bc.unsubscribe('conn-iso-b');
      await sessionA.cleanup();
      await sessionB.cleanup();
    },
  };
}

/** Give the emit and the broadcast a turn of the loop to land. */
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let fixture: Awaited<ReturnType<typeof twoSessions>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

describe('0A — an app protocol request reaches only the session that made it', () => {
  it('relays the request to the originating frontend and to no other', async () => {
    const f = (fixture = twoSessions());

    const pending = asAgent(f.a.id, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'manifest' }, 40),
    );
    await settle();

    const asked = (events: ServerEvent[]) =>
      events.filter((e) => e.type === ServerEventType.APP_PROTOCOL_REQUEST);

    expect(asked(f.a.events)).toHaveLength(1);
    // The window key is identical on both desktops. Before the envelope carried a session,
    // B's iframe was asked a question that was never meant for it.
    expect(asked(f.b.events)).toHaveLength(0);

    await pending; // let it expire rather than leaving a timer running into the next test
  });

  it('will not let the other session answer on the originator’s behalf', async () => {
    const f = (fixture = twoSessions());

    const pending = asAgent(f.a.id, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'manifest' }, 5_000),
    );
    await settle();

    const request = f.a.events.find((e) => e.type === ServerEventType.APP_PROTOCOL_REQUEST) as
      | { requestId: string }
      | undefined;
    expect(request).toBeDefined();

    // B never saw the request, so it has no id to answer with. The nearest thing it *could*
    // do is guess — and a guess must not settle A's wait. (A stolen id would have: the
    // pending store is keyed by request id alone, and ids are minted process-wide.)
    expect(f.b.events.some((e) => e.type === ServerEventType.APP_PROTOCOL_REQUEST)).toBe(false);

    // The real answer, from the session that was actually asked, still works.
    const resolved = actionEmitter.resolveAppProtocolResponse(request!.requestId, {
      kind: 'manifest',
      manifest: { appId: 'ai-chat', name: 'AI Chat' },
    } as never);
    expect(resolved).toBe(true);

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
  });
});

describe('0A — an action changes only its own session', () => {
  const createWindow: OSAction = {
    type: 'window.create',
    windowId: 'ai-chat',
    title: 'AI Chat',
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    content: { renderer: 'markdown', data: 'hi' },
  } as OSAction;

  it('tracks the window in the emitting session’s registry and not the other’s', async () => {
    const f = (fixture = twoSessions());

    asAgent(f.a.id, () => actionEmitter.emitAction(createWindow));
    await settle();

    expect(f.sessionA.windowState.hasWindow(WINDOW)).toBe(true);
    // B's registry used to grow a window for an app nobody on B's desktop had opened —
    // and, since the key exists, B's next lookup of "ai-chat" resolved to it.
    expect(f.sessionB.windowState.hasWindow(WINDOW)).toBe(false);
  });

  it('bills the monitor budget to the emitting session', async () => {
    const f = (fixture = twoSessions());

    const billed: { session: SessionId; monitorId: string }[] = [];
    for (const [session, live] of [
      [f.a.id, f.sessionA],
      [f.b.id, f.sessionB],
    ] as const) {
      // The pool is created lazily on first message; stub the methods the action path and
      // teardown reach for, so the billing is observable without booting a provider.
      (live as unknown as { pool: unknown }).pool = {
        recordMonitorAction: (monitorId: string) => billed.push({ session, monitorId }),
        notifyWindowSubscribers: () => {},
        getSessionLogger: () => null,
        cleanup: async () => {},
      };
    }

    asAgent(f.a.id, () => actionEmitter.emitAction(createWindow));
    await settle();

    // Exactly one bill, to the session that did the work. Monitor `0` exists on both, which
    // is precisely why the unaddressed version charged both: `event.monitorId` was matched
    // against each session's own monitors, and every session has a `0`.
    expect(billed).toEqual([{ session: f.a.id, monitorId: '0' }]);
  });
});
