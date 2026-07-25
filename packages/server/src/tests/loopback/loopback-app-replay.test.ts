/**
 * S6 — replay after a remount is a policy, not a rebroadcast.
 *
 * When an iframe app remounts (a reload, a re-render of the window, a recompiled app), the
 * document that comes back has forgotten everything the agent told it. The server's answer
 * has always been to re-send every command it recorded for that window, which is right for
 * the commands whose whole job is to put the app back where the agent left it (`navigate`,
 * `setDeck`) and wrong — silently, and destructively — for the ones that append or notify.
 * `addMemo` replayed is a second memo. Nothing in the frame told the handler it was a
 * replay, so nothing could dedupe it either.
 *
 * The fix has two halves and this file exercises both against the real stack: the running
 * registration names the commands it refuses to have replayed (`AppProtocolReadyEvent.
 * noReplay`, delivered on every ready), and every command that does go out is stamped
 * `replayed: true`.
 *
 * Why here rather than against a `WindowStateRegistry` in isolation: the policy and the
 * replay are decided by two different frames arriving on one socket, in an order the
 * coordinator depends on — readiness is recorded from the *same* frame that triggers the
 * replay, so the filter must use the policy of the registration that just came up. A unit
 * test would have to assert that ordering by construction, which is the same as assuming
 * it. Here the frames really arrive, through `createWsHandlers().message()`, and the
 * commands being filtered are the ones a real `handleAppCommand` really recorded after a
 * real browser answered them.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { expectSettlesWithin } from './harness/liveness.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');

/** The command this app persists itself: replaying it would append a second memo. */
const ONE_SHOT = 'addMemo';
/** Pure state restoration: replaying it lands in the same place. */
const RESTORABLE = 'setFilter';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** The command requests that reached the browser, in order. */
function commandFrames(h: Harness) {
  return h.client
    .framesOf(ServerEventType.APP_PROTOCOL_REQUEST)
    .map((frame) => frame.request)
    .filter((request) => request.kind === 'command');
}

/**
 * A session with one registered iframe app that has been sent both commands, exactly the
 * way an agent sends them: a turn parked on `handleAppCommand`, a browser answering on the
 * same socket, and the registry recording each one only after its answer came back.
 */
async function bootAppWithTwoCommands(noReplay: string[] | undefined) {
  const h = await boot();
  harness = h;
  const windowKey = h.seedIframeWindow('memo');

  h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, (frame) =>
    h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_RESPONSE,
      requestId: frame.requestId,
      windowId: frame.windowId,
      response: { kind: 'command', result: 'ok' },
    }),
  );

  await h.client.deliver({
    type: ClientEventType.APP_PROTOCOL_READY,
    windowId: windowKey,
    noReplay,
  });

  h.registry.onTurn(() => [
    {
      kind: 'tool',
      name: 'command',
      run: (ctx) =>
        handleAppCommand(ctx.windowState, windowKey, {
          command: RESTORABLE,
          params: { tag: 'work' },
        }),
    },
    {
      kind: 'tool',
      name: 'command',
      run: (ctx) =>
        handleAppCommand(ctx.windowState, windowKey, {
          command: ONE_SHOT,
          params: { text: 'buy milk' },
        }),
    },
  ]);

  await expectSettlesWithin(
    h.client.deliverAsync({
      type: ClientEventType.WINDOW_MESSAGE,
      messageId: 'm1',
      windowId: windowKey,
      content: 'set the filter and add a memo',
    }),
    1000,
    'the two-command turn',
  );

  // Both really ran and both really answered — otherwise nothing was recorded and the
  // replay assertions below would pass against an empty list.
  expect(h.registry.tools.map((tool) => tool.text)).toEqual(['ok', 'ok']);
  expect(commandFrames(h)).toEqual([
    // No `replayed` on a fresh command: the flag has to mean something.
    { kind: 'command', command: RESTORABLE, params: { tag: 'work' } },
    { kind: 'command', command: ONE_SHOT, params: { text: 'buy milk' } },
  ]);

  return { h, windowKey };
}

describe('S6 — command replay honours the running app’s replay policy', () => {
  it('a remount replays only the commands the app did not opt out of, stamped as replays', async () => {
    const { h, windowKey } = await bootAppWithTwoCommands([ONE_SHOT]);
    const beforeRemount = commandFrames(h).length;

    // The remount: a fresh document in the same window, registering again. Not a
    // re-announce — the iframe really did come back empty, which is what makes a replay
    // the right thing to do at all. The policy rides this frame, so the filter about to
    // run is the one the registration that just came up declared.
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      noReplay: [ONE_SHOT],
    });

    const replayed = commandFrames(h).slice(beforeRemount);

    // RED before the fix: `addMemo` is here too, and neither frame says it is a replay —
    // so the app appends a second "buy milk" and has no way to know it should not have.
    expect(replayed).toEqual([
      { kind: 'command', command: RESTORABLE, params: { tag: 'work' }, replayed: true },
    ]);
    expect(replayed.map((request) => request.command)).not.toContain(ONE_SHOT);
  });

  it('the recorded command is left intact, so the next remount filters the same way', async () => {
    const { h, windowKey } = await bootAppWithTwoCommands([ONE_SHOT]);

    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      noReplay: [ONE_SHOT],
    });
    const afterFirst = commandFrames(h).length;

    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      noReplay: [ONE_SHOT],
    });

    // A second remount is not a different situation from the first. If the stamp had been
    // written into the stored request, or the skip had consumed it, this would drift.
    expect(commandFrames(h).slice(afterFirst)).toEqual([
      { kind: 'command', command: RESTORABLE, params: { tag: 'work' }, replayed: true },
    ]);
  });

  it('an app that declares no policy replays everything, exactly as before', async () => {
    const { h, windowKey } = await bootAppWithTwoCommands(undefined);
    const beforeRemount = commandFrames(h).length;

    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    // `replay` is optional and its absence means `'always'`; an app that never heard of the
    // field must not lose a command to it.
    expect(commandFrames(h).slice(beforeRemount)).toEqual([
      { kind: 'command', command: RESTORABLE, params: { tag: 'work' }, replayed: true },
      { kind: 'command', command: ONE_SHOT, params: { text: 'buy milk' }, replayed: true },
    ]);
  });

  it('a re-announce replays nothing at all', async () => {
    const { h, windowKey } = await bootAppWithTwoCommands([ONE_SHOT]);
    const beforeReannounce = commandFrames(h).length;

    // The desktop repeating a registration it already witnessed (server restart, reattach).
    // The iframe never remounted — it still holds everything it was told — so replaying
    // even the "safe" restoration commands would re-run work against live state. The
    // no-replay filter is a *second* line of defence here, not the one that matters:
    // guard the first one, because this slice's change runs right next to it.
    await h.client.deliver({
      type: ClientEventType.APP_PROTOCOL_READY,
      windowId: windowKey,
      reannounce: true,
      noReplay: [ONE_SHOT],
    });

    expect(commandFrames(h)).toHaveLength(beforeReannounce);
  });
});
