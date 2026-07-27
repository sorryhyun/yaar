/**
 * S5 — a client that never answers does not wedge the server.
 *
 * S2 is this file's mirror: there, every server→client wait is answered on the socket that
 * is holding it, and the turn must come back with the answer's own value. Here nobody
 * answers at all — the browser is closed, the tab is frozen, the iframe crashed on load —
 * and the same five waits must each end *by themselves*, say something true about why, and
 * leave the connection able to carry the next message.
 *
 * Three separate claims, and skipping any one of them is how a wedged server passes:
 *
 *   1. **The wait is real** (`expectStillPending`) — a wait that was never entered also
 *      "ends at its deadline", and would satisfy everything below without waiting for
 *      anything.
 *   2. **It ends on its own** (`expectSettlesWithin`) — nothing else is coming. If a
 *      deadline is the only thing that can end a wait, the deadline had better fire, and
 *      the turn had better survive it rather than throwing out of the tool.
 *   3. **It ends truthfully** — this is the one that has teeth. Every value below is chosen
 *      because it is *distinguishable from an answer*: "App did not respond to the command"
 *      is not an app's reply, `ok: false` is not a rendered window, `false` is not consent,
 *      `{dismissed: true, timedOut: true}` is not a user declining. The bug this whole suite
 *      exists for was a wait that ended at its deadline and was reported as the app being
 *      broken; the fix is not that waits never time out — it is that a timeout is *named* as
 *      one, at the call site, so nobody downstream mistakes silence for an answer.
 *
 * And then the fourth thing, which is the actual "wedge" in the title: after all that, the
 * *next* `USER_MESSAGE` on the same socket must run. A dead client costs one turn, not the
 * connection.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { ClientEventType, ServerEventType } from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred, type Deferred } from './harness/deferred.js';
import { expectSettlesWithin, expectStillPending } from './harness/liveness.js';
import type { ToolRecord, TurnContext } from './harness/scripted-provider.js';
import type { RenderingFeedback, UserPromptResult } from '../../session/action-emitter.js';
import type { PendingOutcome } from '../../session/pending-store.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { actionEmitter } = await import('../../session/action-emitter.js');

/**
 * Every deadline in this file. Short, because the test's whole subject is what happens when
 * one passes — it must pass while the test is watching. Long enough that the flush inside
 * `expectStillPending` (a macrotask, ~1ms) cannot be mistaken for it.
 */
const DEAD = 80;

/** The budget a starved wait must finish inside — its own deadline, plus room for CI. */
const SETTLE_BUDGET = 800;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

interface RowState {
  windowKey: string;
  /** Resolved by the tool once the production wait is registered. See `deferred.ts`. */
  entered: Deferred<void>;
}

/**
 * The command path's timeout, as the agent reads it.
 *
 * Asserted by shape, not by re-typing production's format string here: a test that spells
 * out the exact sentence is asserting a constant it declared itself, and would go on passing
 * if the message were reworded into something useless. What has to hold is what the sentence
 * *does* — it names the app as silent (so this can never be mistaken for an answer), reports
 * the deadline it waited, and tells the caller the one thing that might help. Note the
 * deadline reads "0s" under harness deadlines; production's floor is 1s.
 */
function expectCommandTimedOut(tool: ToolRecord): void {
  expect(tool.text).toMatch(/^App did not respond within \d+s\b/);
  expect(tool.text).toContain('retry with a larger timeoutMs');
  expect((tool.result as { isError?: boolean }).isError).toBe(true);
}

/** One server→client wait, starved. */
interface DeadRow {
  what: string;
  /** Anything the wait needs in place first. */
  seed?(h: Harness, s: RowState): Promise<void>;
  /** The production call that parks the turn on a client that will never speak. */
  block(h: Harness, s: RowState, ctx: TurnContext): Promise<unknown>;
  /** Resolves once the turn is genuinely parked — no timer-guessing. */
  witness(h: Harness, s: RowState): Promise<unknown>;
  /** What the tool must have been told. Must be unmistakable for an answer. */
  starved(tool: ToolRecord): void;
}

const ROWS: DeadRow[] = [
  {
    what: 'an app command to an app that is registered but not listening',
    // Registered, so the command gets past `requireAppReady` and parks on the *reply* —
    // which is the wait this row is about. Without the seed it would park one wait earlier.
    seed: (h, s) =>
      h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: s.windowKey }),
    block: (_h, s, ctx) => handleAppCommand(ctx.windowState, s.windowKey, { command: 'ping' }),
    witness: (h) => h.client.waitForFrame(ServerEventType.APP_PROTOCOL_REQUEST),
    starved: (tool) => {
      // The sentence the whole suite began with. It is *correct* here — this app really did
      // not respond — and it was a lie in S1, where the app answered at once and the queue
      // held the answer. Same string, two causes; only the timing told them apart.
      expectCommandTimedOut(tool);
    },
  },

  {
    what: 'an app command to an app that never registers at all',
    // No seed: the iframe never registered — it crashed on load, or it is not
    // a protocol app. The command never even gets asked.
    block(_h, s, ctx) {
      const done = handleAppCommand(ctx.windowState, s.windowKey, { command: 'ping' });
      // `handleAppCommand` runs synchronously into `requireAppReady` → `waitForAppReady`,
      // which registers its listener before the first suspend: by the time the call hands
      // back its promise, the wait exists.
      s.entered.resolve();
      return done;
    },
    witness: (_h, s) => s.entered.promise,
    starved: (tool) => {
      // A *different* sentence from the row above, and that is the point: the agent is told
      // which of the two silences it hit — an app that is not listening, or an app that is
      // listening and did not answer. One is worth retrying; the other is not.
      expect(tool.text).toBe('App did not register with the App Protocol (timeout).');
      expect((tool.result as { isError?: boolean }).isError).toBe(true);
    },
  },

  {
    what: 'a window capture the frontend never reports on',
    block: (_h, s) =>
      actionEmitter.emitActionWithFeedback({ type: 'window.capture', windowId: s.windowKey }),
    witness: (h) =>
      h.client.waitForFrame(ServerEventType.ACTIONS, (f) =>
        f.actions.some((a) => a.type === 'window.capture'),
      ),
    starved: (tool) => {
      const outcome = tool.result as PendingOutcome<RenderingFeedback>;
      expect(outcome.ok).toBe(false);
      // Not merely "not ok" — *why* not ok. This map used to resolve to a caller-supplied
      // `null` on expiry, and its call site read `if (feedback && !feedback.success)`, so a
      // window whose iframe never reported back was announced to the agent as rendered.
      // A timeout that cannot be told apart from an answer is how that shipped.
      expect(outcome.ok === false && outcome.reason).toBe('timeout');
    },
  },

  {
    what: 'a permission dialog nobody clicks',
    block: (_h, _s, ctx) =>
      actionEmitter.showPermissionDialogToSession(
        ctx.sessionId,
        'Allow this?',
        'The agent would like to run a tool.',
        'loopback.dead-client-tool',
      ),
    witness: (h) => h.client.waitForFrame(ServerEventType.APPROVAL_REQUEST),
    starved: (tool) => {
      // Deny by default. The safe direction, and an explicit one: nobody said yes.
      expect(tool.result).toBe(false);
    },
  },

  {
    what: 'a user prompt nobody answers',
    block: () =>
      actionEmitter.showUserPrompt({
        title: 'What should I call it?',
        message: 'Name the file.',
        inputField: { placeholder: 'name', type: 'text' },
      }),
    witness: (h) =>
      h.client.waitForFrame(ServerEventType.ACTIONS, (f) =>
        f.actions.some((a) => a.type === 'user.prompt.show'),
      ),
    starved: (tool) => {
      const result = tool.result as UserPromptResult;
      expect(result.dismissed).toBe(true);
      // `timedOut` is what separates "the user closed this" from "the user never saw it".
      // Without it the agent reads a frozen tab as a refusal and gives up on a question the
      // user would have answered.
      expect(result.timedOut).toBe(true);
      expect(result.text).toBeUndefined();
    },
  },
];

describe('S5 — a wait nobody answers ends at its deadline, and says so', () => {
  for (const r of ROWS) {
    it(r.what, async () => {
      const h = await boot({
        deadlines: {
          appQueryMs: DEAD,
          appCommandMs: DEAD,
          appReadyMs: DEAD,
          dialogMs: DEAD,
          userPromptMs: DEAD,
          renderFeedbackMs: DEAD,
        },
      });
      harness = h;
      const state: RowState = { windowKey: h.seedIframeWindow('ai-chat'), entered: deferred() };
      await r.seed?.(h, state);

      // No `onFrame` responder anywhere in this file. That absence *is* the dead client:
      // the server asks, and nothing on the other end of the socket is listening.
      h.registry.onTurn(() => [
        { kind: 'tool', name: 'starved', run: (ctx) => r.block(h, state, ctx) },
      ]);

      const turn = h.client.deliverAsync({
        type: ClientEventType.USER_MESSAGE,
        messageId: 'm1',
        monitorId: '0',
        content: 'do the thing that waits',
      });

      await expectSettlesWithin(
        r.witness(h, state),
        SETTLE_BUDGET,
        `the question behind ${r.what}`,
      );
      // The wait is real: it has not ended, and nothing is going to end it but the clock.
      await expectStillPending(turn, `the turn waiting on ${r.what}`);

      // Nothing is delivered here. The deadline is the only thing that can move this turn,
      // and it must — a wait that never ends is a turn that never ends is a connection that
      // never moves.
      await expectSettlesWithin(turn, SETTLE_BUDGET, `the starved turn (${r.what})`);

      expect(h.registry.tools).toHaveLength(1);
      r.starved(h.registry.tools[0]!);
    });
  }
});

describe('S5 — the connection outlives the wait that starved on it', () => {
  it('the next USER_MESSAGE runs normally after a turn timed out on a silent app', async () => {
    const h = await boot({ deadlines: { appCommandMs: DEAD, appReadyMs: DEAD } });
    harness = h;
    const windowKey = h.seedIframeWindow('ai-chat');
    await h.client.deliver({ type: ClientEventType.APP_PROTOCOL_READY, windowId: windowKey });

    // First turn asks a dead app. Second turn does nothing but exist — it is the probe.
    h.registry.onTurn((ctx) =>
      ctx.prompt.includes('ask the dead app')
        ? [
            {
              kind: 'tool',
              name: 'starved',
              run: () => handleAppCommand(ctx.windowState, windowKey, { command: 'ping' }),
            },
          ]
        : [{ kind: 'text', content: 'the connection still works' }],
    );

    const first = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm1',
      monitorId: '0',
      content: 'ask the dead app',
    });
    await expectSettlesWithin(first, SETTLE_BUDGET, 'the starved turn');

    const second = h.client.deliverAsync({
      type: ClientEventType.USER_MESSAGE,
      messageId: 'm2',
      monitorId: '0',
      content: 'are you still there',
    });
    await expectSettlesWithin(second, SETTLE_BUDGET, 'the turn after the starved one');

    // Two turns, in order, the second one carrying the second message: the timeout consumed
    // one turn and nothing else. A server that treated a dead client as a dead *connection*
    // would still be sitting on the first frame, and this second prompt would never arrive.
    expect(h.registry.turns).toHaveLength(2);
    expect(h.registry.turns[1]!.prompt).toContain('are you still there');
    expect(h.registry.tools).toHaveLength(1);
    expectCommandTimedOut(h.registry.tools[0]!);
  });
});
