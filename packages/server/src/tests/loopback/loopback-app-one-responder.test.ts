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
 *
 * A user acting in the window — a window message, an app interaction — moves it to the tab
 * they acted in, so the turn they started commands the copy they touched. That is why the
 * ranking tests below send their message from a `bystander`: a tab with no registration for
 * the window, whose message says nothing about which copy should answer.
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

/**
 * A tab on the session that has not registered the window — its iframe never said it can be
 * commanded — so a message it sends leaves the choice of responder to the server's ranking.
 */
async function connectBystander(h: Harness) {
  return h.connect('0');
}

/**
 * The user sends the window a message (or the app an interaction) from `from`, and the turn
 * it starts runs one app command. Returns the command's tool result text.
 */
async function runCommand(
  h: Harness,
  windowKey: string,
  command: string,
  messageId: string,
  { from = h.client, via = 'window' }: { from?: FakeClient; via?: 'window' | 'app' } = {},
) {
  h.registry.onTurn(() => [
    {
      kind: 'tool',
      name: 'command',
      run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command }),
    },
  ]);
  await expectSettlesWithin(
    from.deliverAsync(
      via === 'window'
        ? {
            type: ClientEventType.WINDOW_MESSAGE,
            messageId,
            windowId: windowKey,
            content: `run ${command}`,
          }
        : {
            type: ClientEventType.APP_INTERACTION,
            messageId,
            windowId: windowKey,
            content: `<app_interaction>run ${command}</app_interaction>`,
          },
    ),
    1000,
    `the ${command} turn`,
  );
  return h.registry.tools.at(-1)?.text;
}

const ACTED_NOTE = 'the user acted in this window from another open tab';

describe('S7 — one app protocol request, one responder', () => {
  it('a command reaches only one of two registered tabs — the newest', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    const from = await connectBystander(h);

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1', { from });

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
    const from = await connectBystander(h);

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1', { from });

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
    const bystander = await connectBystander(h);

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command: 'refresh' }),
      },
    ]);
    const turn = bystander.deliverAsync({
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
    const bystander = await connectBystander(h);

    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'command',
        run: (ctx) => handleAppCommand(ctx.windowState, windowKey, { command: 'createIssue' }),
      },
    ]);
    const turn = bystander.deliverAsync({
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
    const from = await connectBystander(h);
    await runCommand(h, windowKey, 'project/cloneApp', 'm1', { from });

    // The first tab re-announces and is now the newest registration. Its copy of the
    // iframe never ran `project/cloneApp`, so moving the next request there is the bug:
    // devtools cloned a project in one copy and was then asked to deploy it from the other.
    await first.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      reannounce: true,
    });
    const answeredBy = await runCommand(h, windowKey, 'build/deploy', 'm2', { from });

    expect(commandFrames(first)).toHaveLength(0);
    expect(commandFrames(second).map((r) => r.command)).toEqual([
      'project/cloneApp',
      'build/deploy',
    ]);
    expect(answeredBy).toBe('second');
  });

  it('a pinned tab that goes to the background hands over once, and says so', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    const from = await connectBystander(h);
    await runCommand(h, windowKey, 'project/cloneApp', 'm1', { from });
    expect(commandFrames(second)).toHaveLength(1);

    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });
    const switched = await runCommand(h, windowKey, 'build/compile', 'm2', { from });

    expect(commandFrames(first).map((r) => r.command)).toEqual(['build/compile']);
    expect(switched).toContain('first');
    expect(switched).toContain('different open copy of this app window');

    // The phone comes back. The window stays where it is now — switching back would be a
    // second jump between copies — and the notice is not repeated.
    await second.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });
    const after = await runCommand(h, windowKey, 'build/deploy', 'm3', { from });

    expect(commandFrames(first).map((r) => r.command)).toEqual(['build/compile', 'build/deploy']);
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
    const from = await connectBystander(h);

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1', { from });

    expect(commandFrames(second)).toHaveLength(0);
    expect(answeredBy).toBe('first');
  });
  it("an app interaction from another tab moves the window to that tab's copy, and says so once", async () => {
    // RED before: the pin stayed on `second`, so the command the interaction's turn ran
    // landed on a copy that never saw the interaction — "No intervention is pending" there,
    // and a timeout in the copy the user actually answered.
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'project/open', 'm1', { from: second });
    expect(commandFrames(second)).toHaveLength(1);

    const moved = await runCommand(h, windowKey, 'answerIntervention', 'm2', {
      from: first,
      via: 'app',
    });

    expect(commandFrames(first).map((r) => r.command)).toEqual(['answerIntervention']);
    expect(commandFrames(second)).toHaveLength(1);
    expect(moved).toContain('first');
    expect(moved).toContain(ACTED_NOTE);

    const after = await runCommand(h, windowKey, 'refresh', 'm3', { from: first, via: 'app' });
    expect(after).toBe('first');
  });

  it("a window message from another tab moves the window to that tab's copy, and says so once", async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'project/open', 'm1', { from: second });

    const moved = await runCommand(h, windowKey, 'build/compile', 'm2', { from: first });

    expect(commandFrames(first).map((r) => r.command)).toEqual(['build/compile']);
    expect(commandFrames(second)).toHaveLength(1);
    expect(moved).toContain('first');
    expect(moved).toContain(ACTED_NOTE);

    expect(await runCommand(h, windowKey, 'build/deploy', 'm3', { from: first })).toBe('first');
  });

  it('the first request goes to the tab that acted, not the newest registration', async () => {
    // With no pin yet, ranking alone would pick `second` (registered last) — the wrong copy
    // exactly when the older tab is the one the user acted in.
    const { h, windowKey, first, second } = await bootTwoTabs();

    const answeredBy = await runCommand(h, windowKey, 'createIssue', 'm1', {
      from: first,
      via: 'app',
    });

    expect(commandFrames(second)).toHaveLength(0);
    // No earlier copy to differ from, so nothing to announce.
    expect(answeredBy).toBe('first');
  });

  it('an interaction from the companion does not move the window', async () => {
    // App code runs in every copy, so the companion "interacting" is app code, not a user.
    const { h, windowKey, first, second } = await bootTwoTabs();
    const companion = await h.connect('0', { companion: true });
    answerAs(companion, 'companion');
    await companion.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    await runCommand(h, windowKey, 'project/open', 'm1', { from: second });

    const answeredBy = await runCommand(h, windowKey, 'refresh', 'm2', {
      from: companion,
      via: 'app',
    });

    expect(answeredBy).toBe('second');
    expect(commandFrames(companion)).toHaveLength(0);
    expect(commandFrames(first)).toHaveLength(0);
  });

  it('an interaction from a backgrounded tab does not move the window', async () => {
    // It could not run the command — moving there would only turn it into a timeout.
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'project/open', 'm1', { from: second });
    await first.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });

    const answeredBy = await runCommand(h, windowKey, 'refresh', 'm2', { from: first });

    expect(answeredBy).toBe('second');
    expect(commandFrames(first)).toHaveLength(0);
  });

  it('an interaction from a tab running with nobody watching does not move the window', async () => {
    // The Android app out of sight keeps its page visible; nobody can have tapped it.
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'project/open', 'm1', { from: second });
    await first.deliver({
      type: ClientEventType.CLIENT_PRESENCE,
      state: 'visible',
      unattended: true,
    });

    const answeredBy = await runCommand(h, windowKey, 'refresh', 'm2', {
      from: first,
      via: 'app',
    });

    expect(answeredBy).toBe('second');
    expect(commandFrames(first)).toHaveLength(0);
  });

  it('a message from a tab that has not registered the window does not move it', async () => {
    const { h, windowKey, first, second } = await bootTwoTabs();
    await runCommand(h, windowKey, 'project/open', 'm1', { from: second });
    const bystander = await connectBystander(h);

    const answeredBy = await runCommand(h, windowKey, 'refresh', 'm2', { from: bystander });

    expect(answeredBy).toBe('second');
    expect(commandFrames(first)).toHaveLength(0);
  });
});

/**
 * The companion desktop is the fallback responder, not the first pick.
 *
 * It is the tab that never backgrounds, which once made it the steadiest pin. It is also
 * the copy nobody is looking at: with a phone attached, the agent's commands ran there and
 * the phone showed nothing happening. So a user's tab in front answers, the companion
 * covers for it while it cannot run script, and the window moves back once it returns.
 */
describe('S7d — the tab the user is looking at answers, the companion covers for it', () => {
  /** A phone and the companion desktop, both registered; the companion registered last. */
  async function bootPhoneAndCompanion() {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow('github');
    const phone = h.client;
    const companion = await h.connect('0', { companion: true });
    answerAs(phone, 'phone');
    answerAs(companion, 'companion');
    await phone.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    await companion.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    return { h, windowKey, phone, companion };
  }

  it('a visible phone answers, even though the companion registered later and never backgrounds', async () => {
    const { h, windowKey, phone, companion } = await bootPhoneAndCompanion();
    // The phone has backgrounded before — which used to rank it below the companion.
    await phone.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });
    await phone.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });
    const from = await connectBystander(h);

    const answeredBy = await runCommand(h, windowKey, 'openFile', 'm1', { from });

    expect(commandFrames(companion)).toHaveLength(0);
    expect(answeredBy).toBe('phone');
  });

  it('the companion covers while the phone is away, and the window moves back when it returns', async () => {
    const { h, windowKey, phone, companion } = await bootPhoneAndCompanion();
    await phone.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'hidden' });
    // Not from the phone: its own message would move the window there and say "acted",
    // and this is about the move the server makes by itself once the phone is back.
    const from = await connectBystander(h);

    const covered = await runCommand(h, windowKey, 'build/compile', 'm1', { from });
    expect(covered).toContain('companion');
    expect(commandFrames(companion).map((r) => r.command)).toEqual(['build/compile']);

    await phone.deliver({ type: ClientEventType.CLIENT_PRESENCE, state: 'visible' });
    const back = await runCommand(h, windowKey, 'build/deploy', 'm2', { from });

    expect(commandFrames(phone).map((r) => r.command)).toEqual(['build/deploy']);
    expect(back).toContain('phone');
    // The move is a jump between copies like any other, so the agent is told.
    expect(back).toContain('different open copy of this app window');
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

  /**
   * `from` matters once a window is pinned: a message is the user acting in the window, so
   * sent from another registered tab it would move the pin these tests are about.
   */
  async function capture(h: Harness, windowKey: string, from: FakeClient = h.client) {
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'capture',
        run: async () =>
          actionEmitter.emitActionWithFeedback({ type: 'window.capture', windowId: windowKey }),
      },
    ]);
    await expectSettlesWithin(
      from.deliverAsync({
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

  /** Two tabs with the window registered, pinned to `second` by a command it answered. */
  async function bootPinned() {
    const h = await boot({
      deadlines: {
        renderFeedbackMs: 1500,
        captureNotMountedGraceMs: 300,
        capturePreferredGraceMs: 800,
      },
    });
    harness = h;
    const windowKey = h.seedIframeWindow('devtools-preview');
    const first = h.client;
    const second = await h.connect('0');
    answerAs(first, 'first');
    answerAs(second, 'second');
    await first.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    await second.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });
    // Opened from `second`'s own copy: the user acted there, so the agent's command ran there.
    expect(await runCommand(h, windowKey, 'openSheet', 'm1', { from: second })).toBe('second');
    return { h, windowKey, first, second };
  }

  it("the copy the agent's commands ran in wins over a faster copy that never saw them", async () => {
    const { h, windowKey, first, second } = await bootPinned();
    // RED before the fix: the untouched copy answered first and its picture was returned —
    // the same stale screenshot every time, however the pinned copy's DOM changed.
    answerCapture(first, { success: true, imageData: 'dW50b3VjaGVk' });
    answerCapture(second, { success: true, imageData: 'c2hlZXRvcGVu' }, 100);

    const outcome = await capture(h, windowKey, second);

    expect(outcome.value?.imageData).toBe('c2hlZXRvcGVu');
    expect((outcome.value as { captureDegraded?: string[] }).captureDegraded).toBeUndefined();
  });

  it("another copy's image stands in when the pinned copy cannot paint — and says so", async () => {
    const { h, windowKey, first, second } = await bootPinned();
    answerCapture(second, { success: false, captureFailure: 'not-mounted' });
    answerCapture(first, { success: true, imageData: 'dW50b3VjaGVk' }, 50);

    const outcome = (await capture(h, windowKey, second)) as {
      value?: { imageData?: string; captureDegraded?: string[] };
    };

    expect(outcome.value?.imageData).toBe('dW50b3VjaGVk');
    expect(outcome.value?.captureDegraded?.some((n) => n.startsWith('other-copy:'))).toBe(true);
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

describe('S7c — a window the user opens or closes in one tab reaches the others', () => {
  function windowActions(client: FakeClient, type: string) {
    return client
      .framesOf(ServerEventType.ACTIONS)
      .flatMap((frame) => frame.actions)
      .filter((action) => action.type === type) as Array<{ windowId: string }>;
  }

  it('the other tab is told, with an iframe token; the tab that did it is not', async () => {
    const h = await boot();
    harness = h;
    const phone = h.client;
    const companion = await h.connect('0');

    await expectSettlesWithin(
      phone.deliverAsync({
        type: ClientEventType.USER_INTERACTION,
        interactions: [
          {
            type: 'window.create',
            windowId: 'configurations',
            windowTitle: 'Configurations',
            bounds: { x: 0, y: 52, w: 640, h: 480 },
            content: { renderer: 'iframe', data: 'yaar://apps/configurations/dist/index.html' },
            appId: 'configurations',
            monitorId: '0',
            timestamp: Date.now(),
          },
        ],
      }),
      1000,
      'the create',
    );

    // Before: the companion never heard of it, and a capture sent there answered
    // "not on this desktop" for the window on the phone's screen.
    const created = windowActions(companion, 'window.create') as Array<{
      windowId: string;
      iframeToken?: string;
    }>;
    expect(created.map((a) => a.windowId)).toEqual(['0/configurations']);
    expect(created[0]!.iframeToken).toBeTruthy();
    expect(windowActions(phone, 'window.create')).toHaveLength(0);

    await expectSettlesWithin(
      phone.deliverAsync({
        type: ClientEventType.USER_INTERACTION,
        interactions: [
          { type: 'window.close', windowId: '0/configurations', timestamp: Date.now() },
        ],
      }),
      1000,
      'the close',
    );
    expect(windowActions(companion, 'window.close').map((a) => a.windowId)).toEqual([
      '0/configurations',
    ]);
    expect(windowActions(phone, 'window.close')).toHaveLength(0);
  });
});
