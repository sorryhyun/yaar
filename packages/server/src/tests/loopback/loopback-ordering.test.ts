/**
 * S3 — the fix did not trade one bug for another.
 *
 * The deadlock was fixed by letting answer frames overtake the connection queue. That is a
 * hole punched in an ordering guarantee that exists for a reason: `ws.data.queue` is what
 * makes a `RESYNC` arriving behind a `USER_INTERACTION` see the window that interaction
 * created. Punch the hole too wide — bypass for everything, or bypass by accident — and
 * the bug becomes "the desktop resynced to a state from before the thing I just did", which
 * is quieter than a deadlock and worse to debug.
 *
 * So this file asserts the queue from both sides:
 *
 *   - an *ordinary* frame may not overtake a turn in flight, however long that turn takes;
 *   - an *answer* frame must, even when ordinary frames are queued ahead of it;
 *   - and the ordinary frames keep their mutual order across the overtaking.
 *
 * The gate is what makes these questions askable at all. A turn parked inside a tool step
 * holds the head of the queue open for as long as the test likes, so "did this frame wait?"
 * is a fact the test controls rather than a race it hopes to win.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType, type OSAction, type WindowContent } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred } from './harness/deferred.js';
import { expectSettlesWithin, expectStillPending } from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** A window's content, in the shape both the registry and a USER_INTERACTION carry. */
function iframeContent(appId: string): WindowContent {
  return { renderer: 'iframe', data: { url: `/apps/${appId}/index.html` } } as WindowContent;
}

/** Does the snapshot contain this window? Snapshots name windows by monitor-scoped key. */
function snapshotHasWindow(actions: OSAction[], rawId: string, monitorId = '0'): boolean {
  return actions.some(
    (a) =>
      a.type === 'window.create' &&
      (a.windowId === rawId || a.windowId === `${monitorId}/${rawId}`),
  );
}

describe('S3 — an ordinary frame still waits its turn', () => {
  it('RESYNC does not overtake a running turn, and the snapshot it gets reflects that turn', async () => {
    const h = await boot();
    harness = h;

    const entered = deferred<void>();
    const gate = deferred<void>();

    // A turn that parks where the test wants it, then does something a snapshot can see.
    h.registry.onTurn(() => [
      {
        kind: 'tool',
        name: 'held',
        run: async (ctx) => {
          entered.resolve();
          await gate.promise;
          ctx.windowState.handleAction(
            {
              type: 'window.create',
              windowId: 'made-by-the-turn',
              title: 'Made by the turn',
              bounds: { x: 0, y: 0, w: 400, h: 300 },
              content: iframeContent('memo'),
            } as OSAction,
            '0',
          );
          return 'done';
        },
      },
    ]);

    const turn = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'open a window, slowly',
    });
    await expectSettlesWithin(entered.promise, 1000, 'the turn reaching its tool');

    const snapshot = h.client.waitForFrame(ServerEventType.SNAPSHOT);
    const resync = h.client.deliverAsync({ type: ClientEventType.RESYNC });

    // RESYNC is not an answer — nothing is waiting for it, so it has no business jumping
    // the queue. If it did, the client would be told the desktop's state as of *before* the
    // window it is about to be given, and would render a desktop missing it.
    await expectStillPending(snapshot, 'the SNAPSHOT');

    gate.resolve();
    await expectSettlesWithin(turn, 1000, 'the held turn');
    await expectSettlesWithin(resync, 1000, 'the RESYNC');

    const snap = await expectSettlesWithin(snapshot, 1000, 'the SNAPSHOT');
    expect(snapshotHasWindow(snap.actions, 'made-by-the-turn')).toBe(true);
  });

  it('a USER_INTERACTION followed by RESYNC is answered with a snapshot containing that window', async () => {
    const h = await boot();
    harness = h;

    // The original reason ws.data.queue exists: the user opens a window and the client
    // immediately asks for the authoritative state. Answer with a snapshot that has not
    // heard of the window yet and the window disappears out from under them.
    const interaction = h.client.deliverAsync({
      type: ClientEventType.USER_INTERACTION,
      interactions: [
        {
          type: 'window.create',
          windowId: 'opened-by-the-user',
          windowTitle: 'Opened by the user',
          bounds: { x: 10, y: 10, w: 400, h: 300 },
          content: iframeContent('memo'),
          monitorId: '0',
          timestamp: Date.now(),
        },
      ],
    });
    const resync = h.client.deliverAsync({ type: ClientEventType.RESYNC });

    await expectSettlesWithin(
      Promise.all([interaction, resync]),
      1000,
      'the interaction and the resync',
    );

    const snap = h.client.framesOf(ServerEventType.SNAPSHOT)[0];
    expect(snap).toBeDefined();
    expect(snapshotHasWindow(snap!.actions, 'opened-by-the-user')).toBe(true);
  });
});

describe('S3 — an answer frame overtakes, and the frames it passed keep their order', () => {
  it('the app’s reply passes two queued messages, which then run in the order they arrived', async () => {
    const h = await boot();
    harness = h;
    const windowKey = h.seedIframeWindow('ai-chat');
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    // Only the first message calls the app; the others are ordinary work. The script reads
    // each turn's own prompt, which is also what proves later which turn ran when.
    h.registry.onTurn((ctx) =>
      ctx.prompt.includes('ping the app')
        ? [
            {
              kind: 'tool',
              name: 'command',
              run: () => handleAppCommand(ctx.windowState, windowKey, { command: 'ping' }),
            },
          ]
        : [{ kind: 'text', content: 'ok' }],
    );

    const asked = h.client.waitForFrame(ServerEventType.APP_PROTOCOL_REQUEST);
    const first = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ping the app',
    });

    // The turn is parked on the app, holding the head of the queue.
    const request = await expectSettlesWithin(asked, 1000, 'the APP_PROTOCOL_REQUEST');

    // Two ordinary frames pile up behind it...
    const second = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: '0',
      content: 'second message',
    });
    const third = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm3',
      monitorId: '0',
      content: 'third message',
    });
    await expectStillPending(first, 'the app-command turn');

    // ...and the answer arrives last of the three, yet must be read first: it is what the
    // frame at the head of the queue is waiting for. This is the whole bypass, under the
    // most adversarial arrangement — two frames deep, behind a turn that cannot end
    // without it.
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: request.requestId,
      windowId: request.windowId,
      response: { kind: 'command', result: 'pong' },
    });

    await expectSettlesWithin(
      Promise.all([first, second, third]),
      2000,
      'the three queued messages',
    );

    expect(h.registry.tools[0]!.text).toBe('pong');

    // The bypass is for answers only. The two ordinary frames kept their mutual order, and
    // both ran after the turn they were queued behind.
    const prompts = h.registry.turns.map((t) => t.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('ping the app');
    expect(prompts[1]).toContain('second message');
    expect(prompts[2]).toContain('third message');
    // A later message cannot appear in an earlier turn's prompt — context only flows
    // forward, so this is what pins the order rather than merely being consistent with it.
    expect(prompts[0]).not.toContain('second message');
    expect(prompts[1]).not.toContain('third message');
  });
});
