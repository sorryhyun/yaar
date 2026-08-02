/**
 * S2 — one row per server→client wait, and a tripwire for the next one.
 *
 * S1 proved the app-protocol round trip works. It is one of five. Every entry in
 * `ANSWER_EVENT_TYPES` is the same shape of promise: the server, mid-turn, asks the client
 * a question and parks; the client's answer arrives on the socket the parked turn is
 * holding. Each one is its own chance to build the deadlock again — and four of them had
 * never been answered *over a socket* in any test, only resolved by hand from inside one.
 *
 * So the table iterates the shared list rather than a list of its own. That is the point of
 * moving `ANSWER_EVENT_TYPES` into `@yaar/shared`: a sixth wait added without a row here
 * fails this file, and it fails it *before* it can ship as an app that hangs. A test whose
 * cases are its own private constants can only ever check the waits its author remembered.
 *
 * Each row asserts two independent things, because either alone is fooled:
 *
 *   - **it finishes** (`expectSettlesWithin`) — but a deadlocked turn also finishes, at its
 *     deadline, which under harness deadlines is fast enough to look healthy;
 *   - **it finishes with the answer's own value** — a value the timeout path cannot
 *     produce. A dialog nobody answers is `false`; a prompt nobody answers is
 *     `{dismissed: true}`; an app that never replies yields "App did not respond". So
 *     `true`, or the user's text, or the app's result, can only have come *through the
 *     socket, while the turn was holding it*.
 *
 * And before either: `expectStillPending` — the wait was real. Without it, a row that never
 * entered its wait at all would pass both assertions above.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ANSWER_EVENT_TYPES,
  ClientEventType,
  ServerEventType,
  type AnswerEventType,
  type ApprovalRequestEvent,
  type AppProtocolRequestEvent,
  type UserClipboardReadAction,
  type UserPromptShowAction,
  type WindowCaptureAction,
} from '@yaar/shared';
import { boot, type Harness } from './harness/boot.js';
import { deferred, type Deferred } from './harness/deferred.js';
import { expectSettlesWithin, expectStillPending } from './harness/liveness.js';
import type { ToolRecord, TurnContext } from './harness/scripted-provider.js';
import type {
  ClipboardFeedback,
  RenderingFeedback,
  UserPromptResult,
} from '../../session/action-emitter.js';
import type { PendingOutcome } from '../../session/pending-store.js';

const { handleAppCommand } = await import('../../features/window/app-protocol.js');
const { actionEmitter } = await import('../../session/action-emitter.js');

/**
 * Values that only an answer can produce. Each is chosen so that the wait's *timeout* path
 * yields something else — that is what makes the value assertion load-bearing rather than
 * decorative. See the header.
 */
const ANSWERED = {
  appResult: 'pong-through-the-socket',
  afterReady: 'registered-then-answered',
  imageData: 'IMAGE-DATA-FROM-THE-BROWSER',
  promptText: 'the user typed this',
  clipboardText: 'what the user had copied',
} as const;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

interface RowState {
  /** A seeded iframe app window, by its monitor-scoped key ("0/ai-chat"). */
  windowKey: string;
  /** Resolved by the tool the moment the production wait is registered. See `deferred.ts`. */
  entered: Deferred<void>;
}

/**
 * One server→client wait: how to block on it, how to know it is blocked, how to answer it,
 * and what the answer must be worth.
 */
interface WaitRow<W> {
  /** The `ANSWER_EVENT_TYPES` entry this row covers. The table is checked against that list. */
  answers: AnswerEventType;
  what: string;
  /** Anything the wait needs in place first (a registered app, say). */
  seed?(h: Harness, s: RowState): Promise<void>;
  /** The production call that parks the turn. Runs as a tool step, inside the real turn. */
  block(h: Harness, s: RowState, ctx: TurnContext): Promise<unknown>;
  /** Resolves once the turn is genuinely parked — the question has been asked. */
  witness(h: Harness, s: RowState): Promise<W>;
  /** The client's answer, delivered through the real `message()` handler. */
  answer(h: Harness, s: RowState, asked: W): Promise<void>;
  /** The turn must have seen the answer's value, not merely reached its end. */
  check(tool: ToolRecord): void;
}

/** Keeps each row's witness type inferred while the table stays a single array. */
function row<W>(r: WaitRow<W>): WaitRow<unknown> {
  return r as WaitRow<unknown>;
}

const ROWS: WaitRow<unknown>[] = [
  row<AppProtocolRequestEvent>({
    answers: ClientEventType.APP_PROTOCOL_RESPONSE,
    what: 'an app command, parked on the app’s reply',
    async seed(h, s) {
      await h.client.deliver({
        type: ClientEventType.APP_PROTOCOL_READY,
        windowId: s.windowKey,
      });
    },
    block: (_h, s, ctx) => handleAppCommand(ctx.windowState, s.windowKey, { command: 'ping' }),
    witness: (h) => h.client.waitForFrame(ServerEventType.APP_PROTOCOL_REQUEST),
    answer: (h, _s, req) =>
      h.client.deliver({
        type: ClientEventType.APP_PROTOCOL_RESPONSE,
        requestId: req.requestId,
        windowId: req.windowId,
        response: { kind: 'command', result: ANSWERED.appResult },
      }),
    // The timeout path here is the bug's own signature: "App did not respond within 0s".
    check: (tool) => expect(tool.text).toBe(ANSWERED.appResult),
  }),

  row<void>({
    answers: ClientEventType.APP_PROTOCOL_READY,
    what: 'an app command, parked on the app registering at all',
    // No `seed`: the window is deliberately *not* ready. That wait is the row.
    block(_h, s, ctx) {
      const done = handleAppCommand(ctx.windowState, s.windowKey, { command: 'ping' });
      // `handleAppCommand` runs synchronously into `requireAppReady` → `waitForAppReady`,
      // which registers its listener before the first suspend. So by the time the call
      // hands back its promise, the wait exists. Signalling here is therefore true;
      // signalling earlier would be a lie and later would be a race against the server.
      s.entered.resolve();
      return done;
    },
    witness: (_h, s) => s.entered.promise,
    async answer(h, s) {
      // Registration unblocks the command, which then needs an answer of its own. Both legs
      // ride the same socket the turn is holding — and it is the READY leg that is stuck
      // behind the turn if READY ever stops being an answer event. A row that passed on the
      // command's value alone would be reporting on the wrong wait, so: responder first,
      // then register.
      h.client.onFrame(ServerEventType.APP_PROTOCOL_REQUEST, (req) =>
        h.client.deliver({
          type: ClientEventType.APP_PROTOCOL_RESPONSE,
          requestId: req.requestId,
          windowId: req.windowId,
          response: { kind: 'command', result: ANSWERED.afterReady },
        }),
      );
      await h.client.deliver({
        type: ClientEventType.APP_PROTOCOL_READY,
        windowId: s.windowKey,
      });
    },
    // An app that never registers gives "App did not register with the App Protocol".
    check: (tool) => expect(tool.text).toBe(ANSWERED.afterReady),
  }),

  row<WindowCaptureAction>({
    answers: ClientEventType.RENDERING_FEEDBACK,
    what: 'a window capture, parked on the frontend rendering and reporting back',
    // The window-capture path (`handlers/window.ts` reading an iframe window) as the wait
    // itself: the emitter is the production code, and everything the answer travels
    // through — ToolActionBridge → broadcast → message() → resolveFeedback → PendingStore
    // — is the code under test.
    block: (_h, s) =>
      actionEmitter.emitActionWithFeedback({ type: 'window.capture', windowId: s.windowKey }),
    async witness(h) {
      const frame = await h.client.waitForFrame(ServerEventType.ACTIONS, (f) =>
        f.actions.some((a) => a.type === 'window.capture'),
      );
      const capture = frame.actions.find((a) => a.type === 'window.capture') as WindowCaptureAction;
      // Without a requestId on the wire the frontend has nothing to answer *to*, and the
      // wait can only ever time out. This is exactly how a devtools preview could open a
      // window and never screenshot it.
      expect(capture.requestId).toBeTruthy();
      return capture;
    },
    answer: (h, s, capture) =>
      h.client.deliver({
        type: ClientEventType.RENDERING_FEEDBACK,
        requestId: capture.requestId!,
        windowId: s.windowKey,
        renderer: 'iframe',
        success: true,
        imageData: ANSWERED.imageData,
      }),
    check: (tool) => {
      const outcome = tool.result as PendingOutcome<RenderingFeedback>;
      // `ok: false` is what a timeout looks like — the caller is told nothing rendered.
      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.value.imageData).toBe(ANSWERED.imageData);
    },
  }),

  row<ApprovalRequestEvent>({
    answers: ClientEventType.DIALOG_FEEDBACK,
    what: 'a permission dialog, parked on the user',
    block: (_h, _s, ctx) =>
      actionEmitter.showPermissionDialogToSession(
        ctx.sessionId,
        'Allow this?',
        'The agent would like to run a tool.',
        'loopback.test-tool',
      ),
    witness: (h) => h.client.waitForFrame(ServerEventType.APPROVAL_REQUEST),
    answer: (h, _s, req) =>
      h.client.deliver({
        type: ClientEventType.DIALOG_FEEDBACK,
        dialogId: req.dialogId,
        confirmed: true,
      }),
    check: (tool) => {
      // A dialog nobody answers resolves *false* — deny by default. So `true` is a value
      // only the user's click can produce, and only if it reached a turn still listening.
      expect(tool.result).toBe(true);
    },
  }),

  row<UserPromptShowAction>({
    answers: ClientEventType.USER_PROMPT_RESPONSE,
    what: 'a user prompt, parked on the user’s text',
    block: () =>
      actionEmitter.showUserPrompt({
        title: 'What should I call it?',
        message: 'Name the file.',
        inputField: { placeholder: 'name', type: 'text' },
      }),
    async witness(h) {
      const frame = await h.client.waitForFrame(ServerEventType.ACTIONS, (f) =>
        f.actions.some((a) => a.type === 'user.prompt.show'),
      );
      return frame.actions.find((a) => a.type === 'user.prompt.show') as UserPromptShowAction;
    },
    answer: (h, _s, prompt) =>
      h.client.deliver({
        type: ClientEventType.USER_PROMPT_RESPONSE,
        promptId: prompt.id,
        text: ANSWERED.promptText,
      }),
    check: (tool) => {
      const result = tool.result as UserPromptResult;
      // The unanswered prompt reports `{dismissed: true, timedOut: true}` — "never saw it",
      // deliberately distinct from the user declining. Text can only come from the user.
      expect(result.dismissed).toBeFalsy();
      expect(result.text).toBe(ANSWERED.promptText);
    },
  }),

  row<UserClipboardReadAction>({
    answers: ClientEventType.CLIPBOARD_RESPONSE,
    what: 'a clipboard read, parked on the browser that owns the clipboard',
    block: () =>
      actionEmitter.readUserClipboard({
        maxChars: 100,
        image: false,
        maxImagePx: 0,
        maxImageBytes: 0,
      }),
    async witness(h) {
      const frame = await h.client.waitForFrame(ServerEventType.ACTIONS, (f) =>
        f.actions.some((a) => a.type === 'user.clipboard.read'),
      );
      const read = frame.actions.find(
        (a) => a.type === 'user.clipboard.read',
      ) as UserClipboardReadAction;
      // Without an id on the wire the desktop has nothing to answer *to*, and the wait can
      // only time out — the same defect the capture row guards `requestId` against.
      expect(read.id).toBeTruthy();
      return read;
    },
    answer: (h, _s, read) =>
      h.client.deliver({
        type: ClientEventType.CLIPBOARD_RESPONSE,
        requestId: read.id,
        ok: true,
        text: ANSWERED.clipboardText,
      }),
    check: (tool) => {
      const outcome = tool.result as PendingOutcome<ClipboardFeedback>;
      // Nobody answering yields `ok: false` — the caller is told the desktop said nothing,
      // never that the clipboard was empty. Text can only have come through the socket.
      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.value.text).toBe(ANSWERED.clipboardText);
    },
  }),
];

describe('S2 — every server→client wait is answerable on the socket that is holding it', () => {
  for (const r of ROWS) {
    it(`${r.answers}: ${r.what}`, async () => {
      const h = await boot();
      harness = h;
      const state: RowState = { windowKey: h.seedIframeWindow('ai-chat'), entered: deferred() };
      await r.seed?.(h, state);

      h.registry.onTurn(() => [
        { kind: 'tool', name: r.answers, run: (ctx) => r.block(h, state, ctx) },
      ]);

      const turn = h.client.deliverAsync({
        type: ClientEventType.USER_MESSAGE,
        messageId: 'm1',
        monitorId: '0',
        content: 'do the thing that waits',
      });

      // The question is out, and the turn has not moved: the wait is real. Every assertion
      // after this one is about a promise that is genuinely parked — which is what makes
      // them assertions about the deadlock rather than about a value some mock handed back.
      const asked = await expectSettlesWithin(
        r.witness(h, state),
        1000,
        `the question behind ${r.answers}`,
      );
      await expectStillPending(turn, `the turn waiting on ${r.answers}`);

      // The answer goes in through the real `message()` handler — the same queue the frame
      // that *started* this turn is still sitting at the head of.
      await r.answer(h, state, asked);

      await expectSettlesWithin(turn, 1000, `the turn waiting on ${r.answers}`);

      expect(h.registry.tools).toHaveLength(1);
      r.check(h.registry.tools[0]!);
    });
  }
});

/**
 * The tripwire. The rows above cover today's waits; these two cover tomorrow's.
 *
 * A new server→client wait is easy to add and easy to add *wrongly*: resolve it from
 * `routeMessage` and forget `ANSWER_EVENT_TYPES`, and it works in every unit test (the
 * pending resolves fine when a test calls it directly) and deadlocks in the product (the
 * answer queues behind the turn awaiting it). That is precisely the bug we already shipped
 * once. It cannot be caught by testing the waits we know about, so it is caught structurally.
 */
describe('S2 — the tripwire: the next wait fails this file rather than the product', () => {
  it('every wait that routeMessage resolves is declared in ANSWER_EVENT_TYPES', () => {
    // The frame-answering surface, in dispatch order. It is more than one file since the
    // route table moved out of `LiveSession`: the controller holds the table and most
    // handlers, the coordinator holds the app-window ones (`notifyAppReady` among them).
    // A new file that answers a frame belongs in this list — and if one is added and
    // forgotten, the count guard below is what says so.
    const ANSWERING_SOURCES = [
      '../../session/client-event-controller.ts',
      '../../session/app-window-coordinator.ts',
    ];
    // Joined with a separator that cannot appear mid-chunk, so the last chunk of one file
    // cannot swallow the head of the next and inherit a resolve that is not its own.
    const source = ANSWERING_SOURCES.map((rel) =>
      readFileSync(join(import.meta.dir, rel), 'utf8'),
    ).join('\n/* --- end of source --- */\n');

    // Each chunk starts at a mention of a `ClientEventType` member and runs to the next
    // one. That covers both places a frame is named now that dispatch goes through a table
    // instead of a switch: the route row (`[ClientEventType.X]: ...`), for a frame answered
    // inline, and the handler's signature (`ClientEventOf<typeof ClientEventType.X>`), for
    // one answered in a method. A resolve that lands in neither chunk is attributed to
    // whichever frame precedes it, which is wrong — and wrong loudly, via the count guard
    // below, rather than quietly.
    const chunks = source.split(/ClientEventType\./).slice(1);
    const resolvesAWait = /actionEmitter\.(resolve[A-Z]\w*|notifyAppReady)\s*\(/;

    const waits = new Set<string>();
    for (const chunk of chunks) {
      const name = chunk.match(/^(\w+)/)?.[1];
      if (!name || !resolvesAWait.test(chunk)) continue;
      const eventType = ClientEventType[name as keyof typeof ClientEventType];
      expect(eventType).toBeDefined(); // the scan matched a real member, not a comment
      waits.add(eventType);
    }

    // If this trips, the scan has stopped seeing the code it is scanning — the guard would
    // then be vacuously green, which is worse than absent.
    expect(waits.size).toBe(ANSWER_EVENT_TYPES.length);

    for (const wait of waits) {
      expect(ANSWER_EVENT_TYPES as readonly string[]).toContain(wait);
    }
  });

  it('every answer event has a liveness row above', () => {
    const covered = new Set(ROWS.map((r) => r.answers as string));
    for (const answerEvent of ANSWER_EVENT_TYPES) {
      expect([...covered]).toContain(answerEvent);
    }
    expect(covered.size).toBe(ANSWER_EVENT_TYPES.length);
  });
});
