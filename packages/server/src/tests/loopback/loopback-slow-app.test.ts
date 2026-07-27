/**
 * S6 — slow is not broken.
 *
 * The regime this file defends is the one the old code punished hardest, and the one no
 * test had. An app that answers in 150ms against a 300ms server deadline is *healthy* — it
 * compiled something, it hit the disk, the tab was in the background for a moment. What it
 * is not is a timeout, and the agent must not be told it was one.
 *
 * It kept being told exactly that. Not because the server gave up (the server was still
 * waiting), but because a *second* clock existed on the frontend leg — a private
 * `LISTENER_GRACE`-less relay timer that produced its own "Timeout waiting for app response"
 * string, and, being the leg exposed to Chrome's hidden-tab throttling, was routinely the
 * one that fired late and answered on the app's behalf. Two clocks, one deadline, and the
 * wrong one won. The relay no longer owns a clock (see the frontend's F-3 in
 * `app-protocol.test.ts` — "manufactures no response when the app stays silent"); the
 * server's deadline is the only one. This is the server half of that: given a real deadline
 * and a slow-but-inside-it reply, the answer must arrive intact.
 *
 * So the interesting assertion here is not that the turn finished — S1 says that, and a
 * turn that *times out* also finishes. It is:
 *
 *   - the turn got the app's actual value, and no timeout string is anywhere near it;
 *   - it waited: the round trip took at least as long as the app took to answer, which is
 *     what proves the reply is the app's and not something the server invented while the
 *     app was still thinking;
 *   - and the deadline the server put on the wire is the one it is actually keeping — the
 *     relay cannot honour a deadline it was never told, and a number that disagrees with
 *     the server's own `PendingStore` entry is how a second clock gets built again.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

const { handleAppCommand, handleAppQuery, handleAppEval } =
  await import('../../features/window/app-protocol.js');

/** The server is prepared to wait this long. */
const SERVER_DEADLINE = 300;
/** The app takes this long — slower than instant, comfortably inside the deadline. */
const APP_LATENCY = 150;

const SLOW_ANSWER = 'the-app-thought-about-it-and-answered';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** Answer app-protocol requests after a real delay, the way a busy iframe does. */
function answerSlowly(h: Harness, result: unknown): void {
  h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, async (req) => {
    await new Promise((r) => setTimeout(r, APP_LATENCY));
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: req.requestId,
      windowId: req.windowId,
      response:
        req.request.kind === 'query'
          ? { kind: 'query', data: result }
          : req.request.kind === 'eval'
            ? { kind: 'eval', value: String(result) }
            : { kind: 'command', result },
    });
  });
}

async function bootWithReadyApp(): Promise<{ h: Harness; windowKey: string }> {
  const h = await boot({
    deadlines: {
      appCommandMs: SERVER_DEADLINE,
      appQueryMs: SERVER_DEADLINE,
      appReadyMs: SERVER_DEADLINE,
    },
  });
  harness = h;
  const windowKey = h.seedIframeWindow('ai-chat');
  await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
  return { h, windowKey };
}

describe('S6 — an app that is merely slow is heard, not timed out', () => {
  it('a command answered inside the deadline reaches the agent as the app’s own value', async () => {
    const { h, windowKey } = await bootWithReadyApp();
    answerSlowly(h, SLOW_ANSWER);

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command: 'compile' }),
      },
    ]);

    const started = Date.now();
    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ask the slow app to compile',
    });
    await expectSettlesWithin(turn, 2000, 'the turn waiting on a slow app');
    const elapsed = Date.now() - started;

    const tool = h.registry.tools[0]!;
    expect(tool.text).toBe(SLOW_ANSWER);
    // The failure this rules out does not look like a crash; it looks like a plausible
    // sentence. Anything that mentions responding, registering, or timing out is the
    // server (or a relay) speaking where the app should have.
    expect(tool.text).not.toMatch(/did not respond|did not register|timeout/i);
    expect((tool.result as { isError?: boolean }).isError).toBeFalsy();

    // It actually waited for the app. Without this the test would still pass if the server
    // answered itself the instant it asked — which is precisely the shape of the bug where
    // a second clock speaks for an app that is still thinking.
    expect(elapsed).toBeGreaterThanOrEqual(APP_LATENCY);
    // ...and it did not sit around until its own deadline: the reply ended the wait, not
    // the clock. (Generous, because CI. The point is the order of magnitude, not the ms.)
    expect(elapsed).toBeLessThan(SERVER_DEADLINE * 3);
  });

  it('tells the client how long it will wait, and waits exactly that long', async () => {
    const { h, windowKey } = await bootWithReadyApp();
    answerSlowly(h, SLOW_ANSWER);

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'query',
        run: (ctx) => handleAppQuery(ctx.windowState, windowKey, { stateKey: 'items' }),
      },
    ]);

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'read the slow app’s state',
    });
    await expectSettlesWithin(turn, 2000, 'the turn waiting on a slow app');

    const request = h.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST)[0]!;
    // The relay's listener lives for `timeoutMs + grace`, so this number is what stops the
    // frontend hanging up on an app the server is still waiting for. A request that carries
    // no deadline (or the wrong one) forces the relay to invent a clock — which is the bug.
    expect(request.timeoutMs).toBe(SERVER_DEADLINE);
    expect(h.registry.tools[0]!.text).toBe(SLOW_ANSWER);
  });

  it('a caller’s own timeout is honoured, and the app gets the whole of it', async () => {
    // The default deadline here is *shorter* than the app takes to answer — so a server
    // that ignored the caller's number would time this command out, and the row would go
    // red on the timeout string. The caller's number is the only thing that can save it.
    const h = await boot({ deadlines: { appCommandMs: 50, appReadyMs: 300 } });
    harness = h;
    const windowKey = h.seedIframeWindow('ai-chat');
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    answerSlowly(h, SLOW_ANSWER);

    // A command that knows it is slow (devtools' compile/deploy is the real one) asks for
    // longer than the default, and must get it.
    const CALLER_TIMEOUT = 1_000;
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) =>
          handleAppCommand(ctx.windowState, windowKey, {
            command: 'deploy',
            timeoutMs: CALLER_TIMEOUT,
          }),
      },
    ]);

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'deploy, and take your time',
    });
    await expectSettlesWithin(turn, 3000, 'the turn waiting on a long command');

    expect(h.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST)[0]!.timeoutMs).toBe(
      CALLER_TIMEOUT,
    );
    expect(h.registry.tools[0]!.text).toBe(SLOW_ANSWER);
  });

  it('an eval that awaits gets the caller’s deadline too, not the query one', async () => {
    // The eval leg used to be pinned to the app-*query* deadline with no way to raise it,
    // on the theory that reading a preview is instant. But an eval awaits a promise it is
    // handed, and `new Promise(r => setTimeout(r, 9000))` is a legitimate question to ask a
    // preview — so every expression that waited on a render, a fetch or a sleep came back as
    // "App did not respond to the eval request (timeout)", indistinguishable from a preview
    // that had actually died and unfixable from the call site.
    const h = await boot({ deadlines: { appQueryMs: 50, appReadyMs: 300 } });
    harness = h;
    // Only a devtools preview may be evaluated at all (`isPreviewWindow`), so the window has
    // to be one — id and principal both.
    const windowKey = h.seedIframeWindow('devtools-preview-p1', { appId: 'preview--p1' });
    answerSlowly(h, SLOW_ANSWER);

    const CALLER_TIMEOUT = 1_000;
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'eval',
        run: (ctx) =>
          handleAppEval(ctx.windowState, windowKey, {
            expression: 'new Promise(r => setTimeout(() => r(1), 150))',
            timeoutMs: CALLER_TIMEOUT,
          }),
      },
    ]);

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ask the preview something that takes a moment',
    });
    await expectSettlesWithin(turn, 3000, 'the turn waiting on a slow eval');

    expect(h.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST)[0]!.timeoutMs).toBe(
      CALLER_TIMEOUT,
    );
    expect(h.registry.tools[0]!.text).toBe(SLOW_ANSWER);
    expect(h.registry.tools[0]!.text).not.toMatch(/did not respond|did not answer|timeout/i);
  });

  it('an eval with no timeout of its own still gets the query deadline', async () => {
    // The default is not being raised for everyone: eval is mostly used for instant
    // structural questions, and those must not sit on a 30s clock when the preview is gone.
    const h = await boot({ deadlines: { appQueryMs: SERVER_DEADLINE, appReadyMs: 300 } });
    harness = h;
    const windowKey = h.seedIframeWindow('devtools-preview-p1', { appId: 'preview--p1' });
    answerSlowly(h, SLOW_ANSWER);

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'eval',
        run: (ctx) => handleAppEval(ctx.windowState, windowKey, { expression: 'document.title' }),
      },
    ]);

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ask the preview for its title',
    });
    await expectSettlesWithin(turn, 2000, 'the turn waiting on an eval');

    expect(h.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST)[0]!.timeoutMs).toBe(
      SERVER_DEADLINE,
    );
    expect(h.registry.tools[0]!.text).toBe(SLOW_ANSWER);
  });
});
