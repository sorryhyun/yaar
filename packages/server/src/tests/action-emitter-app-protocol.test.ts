/**
 * ActionEmitter's App Protocol surface — readiness, and the request/response round trip.
 *
 * **This file used to test a copy.** It defined a `TestableAppProtocolEmitter`, a
 * hand-written re-implementation of these methods, "to avoid AsyncLocalStorage and other
 * server dependencies" — and then asserted against it. Ten green tests that could not see
 * production at all, and it showed: the copy modelled readiness as one process-wide
 * `Set<windowId>` with no session in the key, which is *exactly* the bug the real emitter
 * turned out to have (a second session inherited the first's registrations and sent commands
 * into an iframe that had never registered). The copy could not catch it — the copy *was*
 * it. Nor could it catch the drift the other way: production had already moved from
 * `resolve(null)` to a `PendingOutcome`, and the copy still resolved null, forever green.
 *
 * A test of a hand-copy is worse than no test. It is green *because* it cannot see the code,
 * and it spends the reviewer's confidence anyway.
 *
 * So this tests the real `actionEmitter`. The AsyncLocalStorage objection was never real —
 * `runWithAgentContext` supplies the context, which is how the MCP HTTP handler supplies it
 * in production. What the copy could not express at all, and what most of this file now is:
 * **readiness is scoped to a session**, and a wait that cannot name its session fails closed.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { actionEmitter } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId } from '../session/types.js';
import type { AppProtocolResponse } from '@yaar/shared';

const WINDOW = '0/ai-chat';
const OTHER_WINDOW = '0/notes';

let counter = 0;
/** A session id no other test has used, so nothing here can pass on someone else's state. */
function freshSession(): SessionId {
  return `ses-app-protocol-${++counter}-${process.pid}` as SessionId;
}

/** Run as an agent would — the context `emitAppProtocolRequest` reads its session from. */
function asAgent<T>(sessionId: SessionId, fn: () => T): T {
  return runWithAgentContext({ agentId: 'test-agent', sessionId, monitorId: '0' }, fn);
}

/** The requests the emitter put on the wire, as the frontend would see them. */
function captureRequests(): {
  ids: string[];
  frames: { windowId?: string; timeoutMs?: number }[];
  stop: () => void;
} {
  const ids: string[] = [];
  const frames: { windowId?: string; timeoutMs?: number }[] = [];
  const listener = (data: { requestId: string; timeoutMs?: number }) => {
    ids.push(data.requestId);
    frames.push(data);
  };
  actionEmitter.on('app-protocol', listener);
  return { ids, frames, stop: () => actionEmitter.off('app-protocol', listener) };
}

let session: SessionId;

beforeEach(() => {
  session = freshSession();
});

describe('app readiness is a fact about one session, not about the process', () => {
  it('an unregistered window is not ready', () => {
    expect(actionEmitter.isAppReady(session, WINDOW)).toBe(false);
  });

  it('registering one window says nothing about another', () => {
    actionEmitter.notifyAppReady(session, WINDOW);

    expect(actionEmitter.isAppReady(session, WINDOW)).toBe(true);
    expect(actionEmitter.isAppReady(session, OTHER_WINDOW)).toBe(false);
  });

  it('registering in one session says nothing about another session', () => {
    const otherSession = freshSession();
    actionEmitter.notifyAppReady(session, WINDOW);

    // The bug, as a unit test. The window key ("0/ai-chat") names a place on a desktop, and
    // *every* session has a monitor 0 — so keyed by that alone, the first session to open an
    // app made that key ready for everyone, forever. A second browser then found an app
    // "already listening" that had never spoken, and its first command went into an iframe
    // that was not there yet, reaching the agent as "App did not respond".
    expect(actionEmitter.isAppReady(otherSession, WINDOW)).toBe(false);
  });

  it('a closed window takes its registration with it', () => {
    actionEmitter.notifyAppReady(session, WINDOW);
    actionEmitter.forgetAppReady(session, WINDOW);

    // Reopening a window under the same key mounts a *new* document. A registration that
    // survived the close would tell that document's first command the app was already
    // listening — the same defect as above, at a smaller radius.
    expect(actionEmitter.isAppReady(session, WINDOW)).toBe(false);
  });

  it('a session that goes away takes all of its registrations with it', () => {
    actionEmitter.notifyAppReady(session, WINDOW);
    actionEmitter.notifyAppReady(session, OTHER_WINDOW);

    actionEmitter.clearPendingForSession(session);

    expect(actionEmitter.isAppReady(session, WINDOW)).toBe(false);
    expect(actionEmitter.isAppReady(session, OTHER_WINDOW)).toBe(false);
  });
});

describe('waitForAppReady', () => {
  it('returns at once for an app that has already registered', async () => {
    actionEmitter.notifyAppReady(session, WINDOW);

    expect(await actionEmitter.waitForAppReady(session, WINDOW, 50)).toBe(true);
  });

  it('returns when the app registers while it is waiting', async () => {
    const waiting = actionEmitter.waitForAppReady(session, WINDOW, 500);
    // Registration arrives after the wait has been entered — the ordinary case, and the one
    // the loopback S2 row proves end to end over a real socket.
    setTimeout(() => actionEmitter.notifyAppReady(session, WINDOW), 10);

    expect(await waiting).toBe(true);
  });

  it('gives up at its deadline when the app never registers', async () => {
    expect(await actionEmitter.waitForAppReady(session, WINDOW, 30)).toBe(false);
  });

  it('is not woken by a different window registering', async () => {
    const waiting = actionEmitter.waitForAppReady(session, WINDOW, 60);
    actionEmitter.notifyAppReady(session, OTHER_WINDOW);

    expect(await waiting).toBe(false);
  });

  it('is not woken by the same window registering in a different session', async () => {
    const otherSession = freshSession();
    const waiting = actionEmitter.waitForAppReady(session, WINDOW, 60);

    // Another browser, another desktop, the same window key. It is not this waiter's app.
    actionEmitter.notifyAppReady(otherSession, WINDOW);

    expect(await waiting).toBe(false);
  });

  it('fails closed when the caller cannot name a session', async () => {
    // An `undefined` session matches no 'app-ready' event, so this wait can only ever time
    // out — deliberately. The safe direction for a check whose entire job is to wait is to
    // keep waiting: proceeding would send a command into an iframe nobody has vouched for.
    actionEmitter.notifyAppReady(session, WINDOW);

    expect(await actionEmitter.waitForAppReady(undefined, WINDOW, 30)).toBe(false);
  });
});

describe('an app protocol request, and the answer to it', () => {
  it('goes out with a requestId, the window, the request, and the deadline it will keep', async () => {
    const captured = captureRequests();
    const pending = asAgent(session, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'query', stateKey: 'items' }, 40),
    );

    expect(captured.ids).toHaveLength(1);
    expect(captured.frames[0]).toMatchObject({
      windowId: WINDOW,
      request: { kind: 'query', stateKey: 'items' },
      // The frontend relay's listener lives for this plus a grace period. Without it on the
      // wire the relay has to invent a clock of its own — which is how a second, throttled
      // timer ended up answering on apps' behalf.
      timeoutMs: 40,
    });
    captured.stop();

    await pending; // let it expire rather than leaving a timer running into the next test
  });

  it('settles with the app’s answer when the response comes back', async () => {
    const captured = captureRequests();
    const pending = asAgent(session, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'manifest' }, 500),
    );
    const requestId = captured.ids[0]!;
    captured.stop();

    const response = {
      kind: 'manifest',
      manifest: { appId: 'ai-chat', name: 'AI Chat' },
    } as AppProtocolResponse;
    expect(actionEmitter.resolveAppProtocolResponse(requestId, response)).toBe(true);

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toEqual(response);
  });

  it('reports a timeout as a timeout — never as an answer', async () => {
    const pending = asAgent(session, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'command', command: 'ping' }, 30),
    );

    const outcome = await pending;
    // The old copy asserted this resolved `null`, and production had already stopped doing
    // that. A `null` answer and a missing answer are the same value, which is how a window
    // that never rendered got announced to the agent as rendered. There is no default now:
    // the outcome names which of the three things happened.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('timeout');
  });

  it('reports a cancelled request as cancelled — the session died, the app did not', async () => {
    const pending = asAgent(session, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'command', command: 'ping' }, 5_000),
    );

    // The browser closed. Everything this session was waiting on unblocks *now*, rather than
    // each at its own deadline — and it unblocks with a reason that is not "the app is slow".
    actionEmitter.clearPendingForSession(session);

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('cancelled');
  });

  it('will not resolve a request it never issued', () => {
    expect(
      actionEmitter.resolveAppProtocolResponse('req-never-issued', {
        kind: 'command',
        result: 'hello',
      } as AppProtocolResponse),
    ).toBe(false);
  });

  it('mints a distinct requestId per request, so two in flight cannot answer each other', async () => {
    const captured = captureRequests();
    const first = asAgent(session, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'manifest' }, 1_000),
    );
    const second = asAgent(session, () =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'manifest' }, 1_000),
    );
    const [firstId, secondId] = captured.ids;
    captured.stop();

    expect(firstId).not.toBe(secondId);

    // And each id addresses the request it belongs to: answering the second leaves the first
    // still waiting. A reused id would settle both, and one app's answer would be read as
    // another's.
    actionEmitter.resolveAppProtocolResponse(secondId!, {
      kind: 'manifest',
      manifest: { appId: 'second' },
    } as AppProtocolResponse);
    const secondOutcome = await second;
    expect(secondOutcome.ok && secondOutcome.value).toMatchObject({
      manifest: { appId: 'second' },
    });

    actionEmitter.resolveAppProtocolResponse(firstId!, {
      kind: 'manifest',
      manifest: { appId: 'first' },
    } as AppProtocolResponse);
    const firstOutcome = await first;
    expect(firstOutcome.ok && firstOutcome.value).toMatchObject({ manifest: { appId: 'first' } });
  });
});
