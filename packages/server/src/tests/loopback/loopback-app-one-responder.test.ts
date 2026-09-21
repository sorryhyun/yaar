/**
 * S7 — an app protocol request has exactly one responder, however many desktops are open.
 *
 * Every connected desktop mounts every window, so two tabs on one session means two copies
 * of the same iframe behind one window key. The request used to be broadcast to the whole
 * session, and each tab relayed it into its own copy — so one `app_command` ran the handler
 * once per tab. The first reply won and the rest were logged as "reply for unknown
 * request", but the side effects had already happened: a phone plus the desktop's own
 * auto-opened Chrome filed the same GitHub issue three times in the same second.
 *
 * The request now goes to one connection that registered the window: a visible one if
 * there is one, the newest registration within that. A remount's replay goes only to the
 * tab that remounted. If the chosen tab disconnects before answering, the request moves to
 * another registered tab, unless it is a `replay: 'never'` command the gone tab may have
 * already run.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import type { WindowCaptureAction } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import type { FakeClient } from './harness/fake-client.js';
import { deferred } from './harness/deferred.js';
import { expectSettlesWithin, expectStillPending, flush } from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { actionEmitter } = await import('../../session/action-emitter.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function commandFrames(client: FakeClient) {
  return client
    .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
    .map((frame) => frame.request)
    .filter((request) => request.kind === 'command');
}

/** Answer every request this tab receives, tagged with which tab answered. */
function answerAs(client: FakeClient, name: string) {
  client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, (frame) =>
    client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: frame.requestId,
      windowId: frame.windowId,
      response: { kind: 'command', result: name },
    }),
  );
}

/** Two tabs on one session, both showing — and both registered — the same app window. */
async function bootTwoTabs() {
  const h = await boot();
  harness = h;
  const windowKey = h.seedIframeWindow('github');
  const first = h.client;
  const second = await h.connect('0');
  answerAs(first, 'first');
  answerAs(second, 'second');
  await first.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
  await second.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
  return { h, windowKey, first, second };
}

async function runCommand(h: Harness, windowKey: string, command: string, messageId: string) {
  h.registry.onTurn(() => [
    {
      kind: 'tool',
      name: 'command',
      run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command }),
    },
  ]);
  await expectSettlesWithin(
    h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId,
      windowId: windowKey,
      content: `run ${command}`,
    }),
    1000,
    `the ${command} turn`,
  );
  return h.registry.tools.at(-1)?.text;
}

describe('S7 — one app protocol request, one responder', () => {
  it('a command reaches only one of two registered tabs — the newest', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1');

    // RED before the fix: both tabs got the frame, so the handler ran twice.
    expect(commandFrames(first)).toHaveLength(0);
    expect(commandFrames(second)).toEqual([{ kind: 'command', command: 'createIssue' }]);
    expect(answeredBy).toBe('second');
  });

  it('a backgrounded tab is passed over for a visible one', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    // The newer registration is a phone that went to the background: it cannot run script,
    // so asking it is a timeout now and a duplicate the moment it wakes.
    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });
    await first.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1');

    expect(commandFrames(second)).toHaveLength(0);
    expect(commandFrames(first)).toHaveLength(1);
    expect(answeredBy).toBe('first');
  });

  it('a tab that disconnected is no longer asked', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    await second.close();

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1');

    expect(commandFrames(first)).toHaveLength(1);
    expect(answeredBy).toBe('first');
  });

  it('a remount replays only to the tab that remounted', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'setFilter', 'm1');
    const firstBefore = commandFrames(first).length;
    const secondBefore = commandFrames(second).length;

    // The first tab's iframe reloads and registers afresh. Its copy lost its state; the
    // second tab's copy did not, and re-sending to it would re-apply what it already ran.
    await first.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    expect(commandFrames(first).slice(firstBefore)).toEqual([
      { kind: 'command', command: 'setFilter', replayed: true },
    ]);
    expect(commandFrames(second)).toHaveLength(secondBefore);
  });

  it('a responder that disconnects mid-request is replaced by another registered tab', async () => {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow('github');
    const first = h.client;
    answerAs(first, 'first');
    await first.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    // The newer tab registers, receives the request, and dies before it can answer — a
    // phone whose socket drops mid-command.
    const second = await h.connect('0');
    const reached = deferred();
    second.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, () => reached.resolve());
    await second.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command: 'refresh' }),
      },
    ]);
    const turn = h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'refresh',
    });
    await expectSettlesWithin(reached.promise, 1000, 'the request reaching the second tab');
    expect(commandFrames(first)).toHaveLength(0);

    await second.close();

    // Without the hand-off this waits out the whole deadline and reports "did not respond".
    await expectSettlesWithin(turn, 1000, 'the turn, answered by the remaining tab');
    expect(commandFrames(first)).toEqual([{ kind: 'command', command: 'refresh' }]);
    // Answered by a copy of the window that never saw the earlier requests — said so.
    expect(h.registry.tools.at(-1)?.text).toContain('first');
    expect(h.registry.tools.at(-1)?.text).toContain('the tab that was answering disconnected');
  });

  it('a one-shot command is not re-sent when its responder disconnects', async () => {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow('github');
    const first = h.client;
    answerAs(first, 'first');
    await first.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      noReplay: ['createIssue'],
    });
    const second = await h.connect('0');
    const reached = deferred();
    second.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, () => reached.resolve());
    await second.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      noReplay: ['createIssue'],
    });

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command: 'createIssue' }),
      },
    ]);
    const turn = h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'file it',
    });
    await expectSettlesWithin(reached.promise, 1000, 'the request reaching the second tab');

    await second.close();
    await flush();

    // The gone tab may have filed the issue and lost only the reply. Asking the first tab
    // too would file it again, so the request is left to its deadline instead.
    expect(commandFrames(first)).toHaveLength(0);
    await expectStillPending(turn, 'the one-shot command, left to its deadline');
  });
  it('a window keeps its responder across requests when another tab re-registers', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'cloneApp', 'm1');

    // The first tab re-announces and is now the newest registration. Its copy of the
    // iframe never ran `cloneApp`, so moving the next request there is the bug: devtools
    // cloned a project in one copy and was then asked to deploy it from the other.
    await first.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      reannounce: true,
    });
    const answeredBy = await runCommand(h, windowKey, 'deploy', 'm2');

    expect(commandFrames(first)).toHaveLength(0);
    expect(commandFrames(second).map((r) => r.command)).toEqual(['cloneApp', 'deploy']);
    expect(answeredBy).toBe('second');
  });

  it('a pinned tab that goes to the background hands over once, and says so', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'cloneApp', 'm1');
    expect(commandFrames(second)).toHaveLength(1);

    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });
    const switched = await runCommand(h, windowKey, 'compile', 'm2');

    expect(commandFrames(first).map((r) => r.command)).toEqual(['compile']);
    expect(switched).toContain('first');
    expect(switched).toContain('different open copy of this app window');

    // The phone comes back. The window stays where it is now — switching back would be a
    // second jump between copies — and the notice is not repeated.
    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });
    const after = await runCommand(h, windowKey, 'deploy', 'm3');

    expect(commandFrames(first).map((r) => r.command)).toEqual(['compile', 'deploy']);
    expect(commandFrames(second)).toHaveLength(1);
    expect(after).toBe('first');
  });

  it('a tab that has been away is not the first pick for a new window', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    // The newer tab is a phone that has backgrounded before and is visible again; the
    // older one is an always-visible desktop. Pinning to the phone buys a switch the next
    // time it backgrounds.
    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });
    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });
    await first.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1');

    expect(commandFrames(second)).toHaveLength(0);
    expect(answeredBy).toBe('first');
  });
});

describe('S7b — a capture is not decided by the tab that does not have the window', () => {
  /** Answer every window.capture this tab receives with `feedback`, after `delayMs`. */
  function answerCapture(
    client: FakeClient,
    feedback: { success: boolean; imageData?: string; captureFailure?: string; error?: string },
    delayMs = 0,
  ) {
    client.onFrame(ServerEventType.ACTIONS, async (frame) => {
      for (const action of frame.actions) {
        if (action.type !== 'window.capture') continue;
        const { requestId, windowId } = action as WindowCaptureAction;
        if (!requestId) continue;
        if (delayMs) await Bun.sleep(delayMs);
        await client.deliver({
          type: ClientEventType.RENDERING_FEEDBACK,
          requestId,
          windowId,
          renderer: 'capture',
          ...feedback,
        });
      }
    });
  }

  async function capture(h: Harness, windowKey: string) {
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'capture',
        run: async () =>
          actionEmitter.emitActionWithFeedback({ type: 'window.capture', windowId: windowKey }),
      },
    ]);
    await expectSettlesWithin(
      h.client.deliverAsync({
        type: ClientEventType.WINDOW_MESSAGE,
        messageId: `cap-${Date.now()}`,
        windowId: windowKey,
        content: 'look',
      }),
      4000,
      'the capture turn',
    );
    return h.registry.tools.at(-1)?.result as {
      ok: boolean;
      value?: { success: boolean; imageData?: string; captureFailure?: string };
    };
  }

  it("a fast not-mounted failure from one tab does not beat another tab's image", async () => {
    // Room for the tab that has the window to rasterize (100ms) inside the grace.
    const h = await boot({ deadlines: { renderFeedbackMs: 1000, captureNotMountedGraceMs: 500 } });
    harness = h;
    const windowKey = h.seedIframeWindow('memo');
    const other = await h.connect('0');
    // The tab without the window answers in milliseconds; the one with it is rasterizing.
    answerCapture(h.client, {
      success: false,
      captureFailure: 'not-mounted',
      error: 'Window element not found in DOM.',
    });
    answerCapture(other, { success: true, imageData: 'cGl4ZWxz' }, 100);

    const outcome = await capture(h, windowKey);

    expect(outcome.ok).toBe(true);
    expect(outcome.value?.success).toBe(true);
    expect(outcome.value?.imageData).toBe('cGl4ZWxz');
  });

  it('when every tab lacks the window, the failure stands at once — no waiting out the grace', async () => {
    // A grace far longer than the capture takes: if the failure waited it out, the turn
    // would miss the settle bound below.
    const h = await boot({ deadlines: { renderFeedbackMs: 6000, captureNotMountedGraceMs: 5000 } });
    harness = h;
    const windowKey = h.seedIframeWindow('memo');
    const other = await h.connect('0');
    answerCapture(h.client, { success: false, captureFailure: 'not-mounted' });
    answerCapture(other, { success: false, captureFailure: 'not-mounted' });

    const startedAt = Date.now();
    const outcome = await capture(h, windowKey);

    expect(outcome.ok).toBe(true);
    expect(outcome.value?.captureFailure).toBe('not-mounted');
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
