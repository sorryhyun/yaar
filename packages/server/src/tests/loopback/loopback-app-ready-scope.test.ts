/**
 * S5 — app-protocol readiness belongs to a session, not to the process.
 *
 * `requireAppReady` is a wait: before the first command reaches an iframe, the iframe must
 * have said it is listening. Readiness was recorded in a process-global `Set` keyed by the
 * monitor-scoped window key ("0/ai-chat") — and every session has a monitor 0. So the first
 * session to open an app made that key ready *forever*, for everybody: the next browser to
 * connect got `waitForAppReady() === true` for a document that had never registered, the
 * wait stopped being a wait, and the command went out into an iframe that was not yet
 * listening. The agent read that as "App did not respond".
 *
 * This file is that second browser. It boots a session, registers the app, throws the
 * session away, boots another one, and asks for the wait back.
 *
 * Two assertions, and the first is the one that fails on the old code:
 *
 *   - **nothing was asked yet.** While the turn is parked on readiness, no
 *     `APP_PROTOCOL_REQUEST` has gone out. Under the leak the request is already on the
 *     wire — sent to an iframe that has not registered — which is precisely the defect,
 *     and it is visible *before* any deadline expires.
 *   - **the answer is the second session's.** The turn ends carrying a value only an app
 *     that registered *here* and then replied could have produced. A starved wait also
 *     ends, at its deadline, saying "App did not respond" — so liveness alone would be
 *     fooled, and this is what tells the two apart.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred } from './harness/deferred.js';
import { expectSettlesWithin, expectStillPending } from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { actionEmitter } = await import('../../session/action-emitter.js');

/** A value only an app that registered in *this* session and answered can produce. */
const ANSWERED_HERE = 'the-second-session-app-answered';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe('S5 — a second session does not inherit the first session’s app registration', () => {
  it('still waits for its own APP_PROTOCOL_READY, and gets its own app’s answer', async () => {
    // ── Session one: an app opens, registers, and the session goes away. ──────────────
    const first = await boot();
    harness = first;
    const firstKey = first.seedIframeWindow('ai-chat');
    await first.client.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: firstKey,
    });
    const firstSessionId = first.sessionId;
    expect(actionEmitter.isAppReady(firstSessionId, firstKey)).toBe(true);

    await first.dispose();
    harness = undefined;
    // Session teardown takes its registrations with it. Left behind, they are a claim about
    // a browser that has closed — and the key they are filed under is one the next browser
    // will use for a different document.
    expect(actionEmitter.isAppReady(firstSessionId, firstKey)).toBe(false);

    // ── Session two: same app, same monitor, same window key. Different browser. ──────
    const second = await boot();
    harness = second;
    const key = second.seedIframeWindow('ai-chat');
    expect(key).toBe(firstKey); // the collision is the point — the keys really are equal
    expect(second.sessionId).not.toBe(firstSessionId);

    // The turn signals the moment the production wait is registered: `handleAppCommand`
    // runs synchronously into `requireAppReady` → `waitForAppReady`, so by the time the
    // call hands back its promise the wait exists (see deferred.ts).
    const entered = deferred();
    second.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) => {
          const done = handleAppCommand(ctx.windowState, key, { command: 'ping' });
          entered.resolve();
          return done;
        },
      },
    ]);

    const turn = second.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: key,
      content: 'ping the app',
    });

    await expectSettlesWithin(entered.promise, 1000, 'the command reaching requireAppReady');
    await expectStillPending(turn, 'the turn waiting for this session’s app to register');

    // RED before the fix: the first session's registration had already answered this wait,
    // so the request is on the wire, addressed to an iframe that has never spoken.
    expect(second.client.framesOf(ServerEventType.APP_PROTOCOL_REQUEST)).toHaveLength(0);

    // Now the app in *this* session registers — and answers.
    second.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, (req) =>
      second.client.deliver({
        type: ClientEventType.APP_PROTOCOL_RESPONSE,
        requestId: req.requestId,
        windowId: req.windowId,
        response: { kind: 'command', result: ANSWERED_HERE },
      }),
    );
    await second.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: key });

    await expectSettlesWithin(turn, 1000, 'the app-command turn in the second session');

    expect(second.registry.tools).toHaveLength(1);
    const tool = second.registry.tools[0]!;
    expect(tool.text).toBe(ANSWERED_HERE);
    expect(tool.text).not.toContain('App did not');
  });

  it('a window that closes takes its registration with it', async () => {
    const h = await boot();
    harness = h;
    const key = h.seedIframeWindow('ai-chat');

    // The close hook that drops readiness is wired in `LiveSession.ensureInitialized`
    // (`setOnWindowClose`), which a connection only kicks off in the background. Run one
    // real turn first, which awaits it — otherwise this test races the pool's warm-up and
    // would pass or fail on timing rather than on the hook.
    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.USER_MESSAGE,
        messageId: 'warmup',
        monitorId: '0',
        content: 'hello',
      }),
      2000,
      'the warm-up turn',
    );

    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: key });
    expect(actionEmitter.isAppReady(h.sessionId, key)).toBe(true);

    // The same key, reopened, is a *new* iframe: it has registered nothing. A registration
    // that outlived the window it described would tell the next document's first command
    // that the app is already listening.
    h.session.windowState.handleAction({ type: 'window.close', windowId: 'ai-chat' }, '0');
    expect(actionEmitter.isAppReady(h.sessionId, key)).toBe(false);
  });
});
