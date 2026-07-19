/**
 * S7 — a reply that arrives too late is reported, never silently dropped.
 *
 * This is the diagnostic half of the whole story, and it is the reason the original bug
 * survived as long as it did. The app answered. The answer arrived. It arrived one deadline
 * late, the `PendingStore` entry it was for no longer existed, and `resolveAppProtocolResponse`
 * returned `false` into a void — nobody logged it, nobody counted it. So the only trace the
 * system left of a working app answering a working server was a line three layers away
 * saying *"App did not respond"*, which is the one sentence guaranteed to send you looking
 * in the wrong place.
 *
 * A late reply cannot be honoured: the agent has already been told the app said nothing, and
 * that cannot be un-said. But it can be *named*, with the latency that made it useless — and
 * the latency is the finding. A reply 3ms past its deadline is a slow app; a reply arriving
 * exactly one deadline late, every time, from an app that answered instantly, is a queue
 * holding it. Those two are indistinguishable in the agent's transcript and obvious in this
 * log line, which is why the log line exists.
 *
 * Three things must be true, and the third is the subtle one:
 *
 *   1. a reply for an expired request is logged as **late**, with how late;
 *   2. a reply for a request that never existed is logged as **unknown** — different words,
 *      because it is a different fault (a duplicate reply, or a dead session's ghost);
 *   3. the difference between those two is *remembering*, and memory is bounded. The expired
 *      request is held for a grace window and then pruned, after which a reply for it is
 *      merely unknown. A test that only ever looks inside the grace window would pass just
 *      as well if the map grew forever — which is the leak this codebase has already shipped
 *      once (`readyWindows`, §6.5 of the proposal).
 */
import { describe, it, expect, afterEach, beforeEach, setSystemTime } from 'bun:test';
import { ClientEventType, ServerEventType, type AppProtocolResponse } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

const { actionEmitter } = await import('../../session/action-emitter.js');
const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { runWithAgentContext } = await import('../../agents/agent-context.js');

/** Longer than `EXPIRED_APP_REQUEST_GRACE_MS` (5 minutes) in `action-emitter.ts`. */
const PAST_THE_GRACE_WINDOW_MS = 6 * 60_000;

const WINDOW = '0/ai-chat';
const SESSION = 'sess-late-reply';

/**
 * Issue a request as an agent would. `emitAppProtocolRequest` reads its addressee from
 * the agent context — "0/ai-chat" names a place on a desktop, and every session has one,
 * so a request that cannot say *whose* iframe it is asking is not sent at all.
 */
function issue<T>(fn: () => T): T {
  return runWithAgentContext({ agentId: 'agent-late', sessionId: SESSION, monitorId: '0' }, fn);
}

/** The `requestId` the emitter minted, taken off the event exactly as the frontend takes it. */
function captureRequestId(): { get: () => string; stop: () => void } {
  const ids: string[] = [];
  const listener = (data: { requestId: string }) => ids.push(data.requestId);
  actionEmitter.on('app-protocol', listener);
  return {
    get: () => {
      if (ids.length !== 1) throw new Error(`expected one app-protocol request, saw ${ids.length}`);
      return ids[0]!;
    },
    stop: () => actionEmitter.off('app-protocol', listener),
  };
}

/** Everything `console.warn` was told while this test ran. */
let warnings: string[] = [];
let realWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.warn = realWarn;
  setSystemTime(); // undo any clock travel, whether or not the test did any
});

const reply: AppProtocolResponse = { kind: 'command', result: 'I answered, just too late' };

describe('S7 — the emitter says a late reply out loud', () => {
  it('names it as late, with the latency that made it useless', async () => {
    const capture = captureRequestId();
    const pending = issue(() =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'command', command: 'noop' }, 30),
    );
    const requestId = capture.get();
    capture.stop();

    // The deadline passes with nothing on the wire. The agent is told the app is silent.
    const outcome = await expectSettlesWithin(pending, 1000, 'the expiring request');
    expect(outcome.ok).toBe(false);

    // ...and *then* the app answers, 30ms past a 30ms deadline.
    await new Promise((r) => setTimeout(r, 30));
    const resolved = actionEmitter.resolveAppProtocolResponse(requestId, reply);

    // It cannot be honoured — there is nothing left listening for it.
    expect(resolved).toBe(false);

    // But it is not lost. This log line is the difference between "the app is broken" and
    // "something between us is holding the answer", and only one of those is true.
    const late = warnings.find((w) => w.includes('Late reply'));
    expect(late).toBeDefined();
    expect(late!).toContain(requestId);
    expect(late!).toContain(WINDOW);
    expect(late!).toContain('command');
    // The number is the finding, so the line has to carry one.
    expect(late!).toMatch(/arrived after \d+ms, \d+ms past its 30ms deadline/);
  });

  it('a reply nobody asked for is unknown — a different fault, and it says a different thing', () => {
    const resolved = actionEmitter.resolveAppProtocolResponse('req-never-issued', reply);

    expect(resolved).toBe(false);
    const unknown = warnings.find((w) => w.includes('unknown request'));
    expect(unknown).toBeDefined();
    expect(unknown!).toContain('req-never-issued');
    // Not "late": nothing was ever waiting, so there is no latency to report and no app to
    // exonerate. Reporting this as a late reply would invent a request that never existed.
    expect(warnings.some((w) => w.includes('Late reply'))).toBe(false);
  });

  it('remembers an expired request for the grace window, and forgets it after', async () => {
    const first = captureRequestId();
    const expired = issue(() =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'command', command: 'noop' }, 30),
    );
    const staleId = first.get();
    first.stop();
    await expectSettlesWithin(expired, 1000, 'the request that will be forgotten');

    // Six minutes pass with the reply still in flight — an absurdity for an iframe, and the
    // exact scenario the grace window is *not* meant to cover. Only `Date.now()` moves;
    // `setTimeout` still runs on the real clock, so the deadline below expires immediately
    // and the pruning it triggers is the production code's own, at a wall-clock the
    // production code believes.
    setSystemTime(new Date(Date.now() + PAST_THE_GRACE_WINDOW_MS));

    // Pruning is opportunistic: it happens when the *next* request expires. So this second
    // request is not scaffolding, it is the event that does the forgetting.
    const second = captureRequestId();
    const next = issue(() =>
      actionEmitter.emitAppProtocolRequest(WINDOW, { kind: 'query', stateKey: 'noop' }, 30),
    );
    const freshId = second.get();
    second.stop();
    await expectSettlesWithin(next, 1000, 'the request that triggers the prune');

    // The old one is gone: its reply is now a stranger, not a straggler.
    actionEmitter.resolveAppProtocolResponse(staleId, reply);
    expect(warnings.some((w) => w.includes('unknown request') && w.includes(staleId))).toBe(true);
    expect(warnings.some((w) => w.includes('Late reply') && w.includes(staleId))).toBe(false);

    // The recent one is still remembered, so a reply that is merely late still gets named as
    // late. Both halves matter: a map that forgot everything at once would pass the check
    // above and lose every real diagnosis.
    warnings = [];
    actionEmitter.resolveAppProtocolResponse(freshId, { kind: 'query', data: 'late' });
    expect(warnings.some((w) => w.includes('Late reply') && w.includes(freshId))).toBe(true);
  });
});

describe('S7 — a late reply on a live socket is logged, and costs the connection nothing', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it('the turn already gave up, the reply is named late, and the next message still runs', async () => {
    // The app answers, but only after the server's deadline — the production shape of a
    // throttled tab, and, before the fix, of a reply sitting behind the turn in the queue.
    const h = await boot({ deadlines: { appCommandMs: 60, appReadyMs: 300 } });
    harness = h;
    const windowKey = h.seedIframeWindow('ai-chat');
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, async (req) => {
      await new Promise((r) => setTimeout(r, 200)); // past the 60ms deadline
      await h.client.deliver({
        type: ClientEventType.APP_PROTOCOL_RESPONSE,
        requestId: req.requestId,
        windowId: req.windowId,
        response: { kind: 'command', result: 'sorry I am late' },
      });
    });

    h.registry.onTurn((ctx) =>
      ctx.prompt.includes('ask the slow app')
        ? [
            {
              kind: 'tool',
              name: 'command',
              run: () => handleAppCommand(ctx.windowState, windowKey, { command: 'ping' }),
            },
          ]
        : [{ kind: 'text', content: 'still here' }],
    );

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ask the slow app',
    });
    await expectSettlesWithin(turn, 1000, 'the turn that gave up');

    // The agent was told the app was silent — truthfully, from where it stood.
    expect(h.registry.tools[0]!.text).toMatch(/^App did not respond within \d+s\b/);

    // Now let the app's actual answer land on the socket the server is no longer holding.
    await h.client.settleResponders();

    // The one piece of evidence that the app is *not* broken. Without it, this session looks
    // identical to a session where the iframe never answered at all — which is exactly the
    // ambiguity that made the original deadlock take so long to find.
    const late = warnings.find((w) => w.includes('Late reply'));
    expect(late).toBeDefined();
    expect(late!).toContain(windowKey);
    expect(late!).toMatch(/past its 60ms deadline/);

    // And the socket is fine. A reply for a request nobody is waiting for must not throw out
    // of `routeMessage`, or the dead request takes the whole connection with it.
    const after = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: '0',
      content: 'are you still there',
    });
    await expectSettlesWithin(after, 1000, 'the turn after the late reply');
    expect(h.registry.turns).toHaveLength(2);
    expect(h.registry.turns[1]!.prompt).toContain('are you still there');
  });
});
