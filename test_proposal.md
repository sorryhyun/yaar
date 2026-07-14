# Test Proposal: Which Tests Are Required

This answers `test_request.md` against the actual code and the actual test suite. It names
every test we must have, the harness they need, the small production seams that harness
requires, and the existing tests that must be deleted or rewritten because they test copies,
mocks, or their own constants.

> **Status: P0 is shipped and its gate passes.** The seams (§1), the harness (§2) and S1
> (§3.1) are in `packages/server/src/tests/loopback/`, and the mutation check is green:
> deleting the answer-frame bypass turns S1 red in **644ms**, with the bug's own signature
> ("App did not respond" from an app that answered). P1–P3 are untouched. Two things in
> this document were **wrong about reality** and are corrected in place — the harness
> directory (§2) and the liveness helpers (§2.1); §6 records what building it turned up,
> including a live order-dependent failure in the existing suite.

## 0. Findings: why the 460 tests missed the deadlock (verified, not assumed)

An audit of every routing/session/protocol test confirms the diagnosis in `test_request.md`:

1. **No test crosses the WebSocket seam.** The only test that uses the real
   `createWsHandlers().message()` (`ws-head-of-line.test.ts`) mocks the session hub — its
   "session" is a stub that records event types. The tests that use a real `LiveSession`
   (`message-delivery.test.ts`, `monitor-identity.test.ts`) call `routeMessage()` directly,
   bypassing the socket queue entirely. The seam where the bug lived — `ws.data.queue`
   holding `routeMessage`'s await — is inside no test's blast radius.
2. **No test has ever run a real agent turn.** Every ContextPool/LiveSession test mocks
   `agents/agent-session.js`; the fake provider's `query()` is a no-op mock that no test
   iterates. `AgentSession` has never been constructed in a test. So "routeMessage awaits
   the whole turn" always looked instantaneous, and a turn that *waits on the client* has
   never existed in test.
3. **The five server→client waits have no client.** `PendingStore` ×4
   (`APP_PROTOCOL_RESPONSE`, `RENDERING_FEEDBACK`, `DIALOG_FEEDBACK`, `USER_PROMPT_RESPONSE`)
   plus `waitForAppReady` (`APP_PROTOCOL_READY`, a separate Set + EventEmitter) are tested
   only by resolving them from inside the test — never by a reply arriving *on the socket
   the server is holding*. The reentrancy had zero coverage.
4. **One test file tests a hand-written copy of production code.**
   `action-emitter-app-protocol.test.ts` defines a `TestableAppProtocolEmitter` that
   re-implements ActionEmitter's app-protocol logic to dodge AsyncLocalStorage — and has
   already drifted (it still models the old `resolve(null)` shape, not `PendingOutcome`).
   Green forever, regardless of what production does.

Two structural facts constrain the design:

- **No provider DI seam.** `ContextPool` calls the global `acquireWarmProvider()`
  (`context-pool.ts:178,225,834`); every test injects via Bun's process-global
  `mock.module('../providers/factory.js')`, which leaks across test files.
- **No fake timers.** Bun offers only `setSystemTime` (Date), not `setTimeout` faking.
  `PendingStore`, `waitForAppReady`, and dialog expiry all use real `setTimeout`. "Fake
  clock" from the request is not available; deadlines must instead be *injectable* so tests
  run them at tens of milliseconds.

## 1. Required production seams (small, and each is a fix in its own right)

These are the only production changes this proposal needs. Without them the harness cannot
make a deadlock fail fast, and the "any future wait gets a row" guarantee has no anchor.

### 1.1 `ANSWER_EVENTS` moves to `@yaar/shared` as the single source of truth ✅

Today the set lives privately in `websocket/server.ts:72-78`. The same knowledge exists
implicitly in three other places: the `routeMessage` cases that resolve pendings
(`live-session.ts:732-834`), the frontend's direct-send replies (`iframe-bridge.ts`), and the
future author's head. Export `ANSWER_EVENT_TYPES` from `packages/shared/src/events.ts` next
to `ClientEventType`, import it in `websocket/server.ts`, and make the scenario table
(§3.2) iterate over it. Then adding a sixth wait forces the author through the shared list,
and the table test fails until the new wait has a row.

### 1.2 Injectable deadlines: `packages/server/src/config.ts` grows a `deadlines` object ✅

The hardcoded constants that a liveness test must shrink:

| Constant | Where | Production value |
|---|---|---|
| `QUERY_TIMEOUT_MS` | `features/window/app-protocol.ts:21` | 5 000 |
| `COMMAND_TIMEOUT_MS` / min-clamp `1_000` | `app-protocol.ts:29,215` | 30 000 / 1 000 |
| `waitForAppReady` default | `action-emitter.ts:581` + caller `app-protocol.ts:121` | 5 000 |
| dialog / prompt defaults | `action-emitter.ts:381,502` | 60 000 / max |

Collect them into one exported mutable-for-test object (or a `setDeadlinesForTest()` with
restore), read at call time. The acceptance criterion — *deadlock goes red in under one
second* — is impossible without this: the command path clamps caller timeouts to ≥1s, and
the query/ready paths accept no caller timeout at all.

### 1.3 A provider seam on `ContextPool` ✅

Add an optional `acquireProvider?: () => Promise<AITransport | null>` to the `ContextPool`
constructor options, defaulting to the global `acquireWarmProvider`. This replaces the
process-global `mock.module('../providers/factory.js')` that every pool test currently
performs and never restores — cross-file mock leakage is itself a source of sandbagging
(tests passing because an earlier file's mock is still installed). Existing tests migrate
opportunistically; the harness uses the seam from day one.

## 2. The loopback harness — `packages/server/src/tests/loopback/harness/` ✅ shipped

Real code end to end, exactly two fakes, exactly as the request specifies.

**It lives in its own directory and runs in its own Bun process, and that is not a
filing decision.** `mock.module` is process-global, has no teardown, and — the fact that
settles the layout — **`mock.restore()` cannot undo it once the real module has already
been loaded**, which by the time any test runs it has. Five files in `src/tests` replace
`AgentSession` with a stub whose `handleMessage` resolves instantly. Sharing a process with
them, the harness is hollow: the turn "runs" without running, nothing can wait on the
client, and every test here passes while proving nothing — this bug's blindness, wearing a
green tick. So `package.json` runs three processes:

```
bun test src/tests --path-ignore-patterns='**/loopback/**'   # unit
bun test src/tests/loopback                                  # the harness — no foreign mocks
bun test src/integration
```

**No `mock.module` in the harness at all** — the "environment shims" this document
originally budgeted for (§2, old text: profiles/logging/storage stubs) turned out to be
unnecessary *and* unaffordable, since they leak forward exactly like everyone else's. Each
is a real seam instead: the provider via `ContextPool.acquireProvider` (§1.3), the session
logger via the `sessionLogger` option that already existed (which is also what stops
`ContextPool.initialize` minting a `session_logs/` dir per test), the deadlines via
`setDeadlinesForTest` (§1.2), the config dir via `YAAR_CONFIG` so the reload cache lands in
a temp dir. Everything else — the apps on disk, `memory.md`, the environment section — is
read for real: it is cheap, it already `.catch()`es to a default, and a fake is one more
thing that can lie.

**Real:** `createWsHandlers` (open/message/close), `SessionHub`, `LiveSession`,
`ContextPool`, `AgentPool`, `AgentSession`, `actionEmitter`, `PendingStore`,
`BroadcastCenter`, `WindowStateRegistry`, the app-protocol handlers
(`handleAppQuery`/`handleAppCommand`).

**Fake #1 — `fake-client.ts`: the socket pair that can answer.**
An in-memory object satisfying the `ServerWebSocket<WsData>` surface the handlers touch
(`data`, `send`, `readyState`). It records every outbound frame (typed, in order), and
exposes:

- `deliver(event)` — a client frame, sent through the *real* `handlers.message()` (this is
  the whole point: replies travel the same queue the bug lived in);
- `onFrame(type, responder)` — a scripted browser: e.g. on `APP_PROTOCOL_REQUEST`,
  automatically `deliver` an `APP_PROTOCOL_RESPONSE` with the same `requestId`, after an
  optional delay. This is what models "the client answers on the socket the server is
  holding";
- `waitForFrame(type)` — *added while building S1.* A test that holds an answer back must
  first know the question was asked, and it cannot get that by flushing a fixed number of
  event-loop turns: a real turn does real work before it reaches its tool (a system prompt
  to assemble, an app profile to read off disk), so "flush once and look" races the server
  instead of observing it. Wait for the frame;
- `close()` / `connect()` — drives `handlers.close()` and a fresh `handlers.open()` with the
  same `sessionId`, for the outbox/resend scenarios (P1).

**Fake #2 — `scripted-provider.ts`: an `AITransport` whose turn is a script.**
Implements the real interface (`providers/types.ts:62-101`). Its `query()` is an async
generator over declarative steps:

```ts
scriptTurn([
  { kind: 'text', content: 'ok, sending the command' },
  { kind: 'tool',
    run: (ctx) => handleAppCommand(ctx.windowState, '0/ai-chat', { command: 'ping' }) },
  { kind: 'text', content: (result) => `app said ${result}` },
]);
```

The critical fidelity point: in production the Claude CLI executes MCP tools itself and the
provider stream **does not advance until the tool's HTTP call returns**. The scripted
provider reproduces that topology by `await`ing the real handler (in-process, wrapped in
`runWithAgentContext` with the turn's agentId/monitorId/sessionId) between yields. So the
turn promise genuinely blocks on `PendingStore`, which is genuinely resolved only by a frame
arriving through `handlers.message()`. Nothing between the two fakes is a mock.

**`boot.ts`** wires it: fresh `sessionId`, `createWsHandlers`, one `FakeClient` opened,
`ContextPool` given the scripted provider via the §1.3 seam, the logger double via
`sessionLogger`, deadlines shrunk via §1.2, `YAAR_CONFIG` pointed at a temp dir, plus
`seedIframeWindow()` (a real `windowState.handleAction(window.create)`, so the window is
registered exactly as an agent's action registers it) and a `dispose()` that clears the
session's pendings, closes the clients, removes the session from the hub, resets the
BroadcastCenter and restores both deadlines and env.

**The named risk did not bite.** `AgentSession` had never been constructed in a test; booting
it for real cost exactly one thing — a `SessionLogger` double with the *whole* method surface
(a partial one throws inside the turn, which reads as the turn failing, i.e. as the bug under
test). Profiles, memory and the environment section all run for real off the repo's own
`apps/`.

### 2.1 Liveness assertions — `tests/loopback/harness/liveness.ts`

```ts
expectSettlesWithin(promise, budgetMs)  // race vs real timer; failure names the budget
expectStillPending(promise)             // flush micro+macrotask, assert unsettled — returns void
expectConcurrent(blocked, probe)        // probe must settle while blocked is pending
```

With §1.2 deadlines at 150ms, a deadlock fails in ~600ms of wall clock, never hangs CI.
Budget rule (enforced in review): **no harness test awaits a possibly-deadlocked promise
bare** — every await of a turn or a wait goes through `expectSettlesWithin` with a budget
≤ 1 000ms.

**`expectStillPending` returns `void`, deliberately.** Handing the promise back is the
natural shape and it is a trap: an `async` function *awaits* a promise it returns, so the
helper whose entire job is "do not wait for this" waits for it — silently, and for exactly
as long as the deadlock it was hired to detect. The first draft did this and the S1 pending
assertion sat there for a full deadline before passing for the wrong reason. Keep using the
promise you passed in.

## 3. The required tests

### 3.1 `loopback-app-protocol.test.ts` — Scenario 1, the one test that mattered ✅

Arrange: iframe window seeded in `windowState`; client `deliver`s `APP_PROTOCOL_READY`
(exercising the ready path, not shortcutting it); `onFrame(APP_PROTOCOL_REQUEST)` responder
answers with the matching `requestId`.

Act: `deliver` a message whose scripted turn calls the real `command` handler.

Assert:
- `expectSettlesWithin(turn, 500ms)` — **this line is red under the deadlock**;
- the tool step's result is the app's answer, not `"App did not respond"`;
- the responder observed exactly one `APP_PROTOCOL_REQUEST`, carrying `timeoutMs`.

**Mutation acceptance (re-run by hand on any change to `websocket/server.ts`):** delete the
`isAnswerEvent(event.type)` bypass in `message()` → this test must fail in < 1s. If it
doesn't, the harness is lying and must be fixed before anything else is built on it.
**Verified:** red in 644ms, with the bug's own signature — the tool step receives *"App did
not respond within 0s"* from an app that answered at once. Green again on restore.

### 3.2 `loopback-answer-waits.test.ts` — Scenario 2, one row per server→client wait

Table-driven over the shared `ANSWER_EVENT_TYPES` (§1.1). Each row provides: a scripted
turn step that blocks on that wait, and the client frame that answers it.

| Row | Turn blocks in | Client answers with |
|---|---|---|
| `APP_PROTOCOL_RESPONSE` | `handleAppCommand` / `handleAppQuery` | `APP_PROTOCOL_RESPONSE` (same `requestId`) |
| `APP_PROTOCOL_READY` | `requireAppReady` on a not-yet-registered window | `APP_PROTOCOL_READY`, then the command reply |
| `RENDERING_FEEDBACK` | `emitActionWithFeedback` (window capture path) | `RENDERING_FEEDBACK` (same `requestId`) |
| `DIALOG_FEEDBACK` | `showPermissionDialogToSession` | `DIALOG_FEEDBACK` (same `dialogId`) |
| `USER_PROMPT_RESPONSE` | `showUserPrompt` | `USER_PROMPT_RESPONSE` (same `promptId`) |

Per row: `expectStillPending(turn)` before the answer (the wait is real), then answer
through `deliver()`, then `expectSettlesWithin(turn, budget)` and assert the turn saw the
*answer's value* (the dialog's `confirmed`, the prompt's text — not just "it finished").

Plus one static guard in the same file: every `ClientEventType` whose `routeMessage` case
calls a `PendingStore.resolve*` or `notifyAppReady` must be in `ANSWER_EVENT_TYPES`. The
table iterates the shared list, so **a future wait added without a row fails this file** —
that is the "deadlock waiting to happen" tripwire the request asks for.

### 3.3 `loopback-ordering.test.ts` — Scenario 3, the fix didn't trade one bug for another

- Turn from frame A held open (scripted step parks on a test-controlled gate);
  `deliver(RESYNC)`; `expectStillPending(snapshotFrame)` — RESYNC must **not** overtake.
  Release the gate; snapshot arrives and reflects frame A's effects.
- `USER_INTERACTION` (window.create) followed immediately by `RESYNC`: the `SNAPSHOT` frame
  must contain the window (the original reason `ws.data.queue` exists).
- Two ordinary frames + one answer frame interleaved: the answer overtakes, the two
  ordinary frames keep their mutual order.

### 3.4 `loopback-message-loss.test.ts` — Scenario 4, the guard rail for un-awaiting

- Send M1…M5 (M1's turn briefly held): assert 5 turns, exactly once each, in order — the
  scripted provider records the prompts it was handed, which *is* "the user's message got
  handled", not `expect(mock).toHaveBeenCalled()`.
- Each accepted message produced its ack; duplicate `messageId` re-delivered mid-flight →
  re-acked (`agentId: 'duplicate'`), no second turn.
- `disconnect()` while M3 queued → `reconnect()` same `sessionId` → outbox resend of M3 →
  exactly one M3 turn total; new messages on the new connection still flow.

This file is what makes it *safe* to ever stop awaiting the whole turn in `routeOne` — if
that refactor drops or reorders a message, this is the red light.

### 3.5 `loopback-dead-client.test.ts` — Scenario 5, a dead client doesn't wedge the server

Responder deliberately silent; deadlines at ~50ms.

- `expectStillPending(turn)` just before the deadline; turn settles at the deadline
  (`expectSettlesWithin(deadline + slack)`);
- the tool step received the *truthful* message (`App did not respond within …`, or for the
  prompt row `{dismissed: true, timedOut: true}` — "never saw it", not "declined");
- the **next** `USER_MESSAGE` on the same socket completes normally — the queue survived.

### 3.6 `loopback-slow-app.test.ts` — Scenario 6, slow is not broken

Server deadline 300ms; responder answers at 150ms — slower than "instant" (the regime the
old frontend 5s relay timer punished) but inside the server's deadline. The turn gets the
real answer, no timeout string anywhere. (The frontend half of this scenario is F-3 below —
the relay must no longer own a clock.)

### 3.7 `late-reply.test.ts` — Scenario 7, late is reported, never silent

Runs against the real `actionEmitter` (no full loopback needed) plus one loopback variant:

- deadline 30ms, reply at 60ms: turn already ended with the timeout message; `console.warn`
  spy captured `[AppProtocol] Late reply … arrived after Xms, Yms past its deadline`
  (`action-emitter.ts:664`) — the latency is in the log;
- reply for a never-issued `requestId`: the "unknown request" warn branch;
- reply within the 5-minute grace after expiry vs. after pruning: remembered vs. unknown.

### 3.8 Frontend counterparts — `packages/frontend/src/tests/store/app-protocol-relay.test.ts`

The acceptance criterion says reverting *either* half of the fix must go red. The server
harness plays the client itself, so it cannot see a frontend regression; the frontend half
needs its own fast tests (extending the already-touched `app-protocol.test.ts`):

- **F-1 (mutation target for the second half):** on `APP_PROTOCOL_REQUEST` → iframe reply,
  the store calls `sendEvent` with `APP_PROTOCOL_RESPONSE` **synchronously/directly**, not
  via the Zustand pending queue. Reverting `sendAppProtocolResponse` to queueing goes red
  here in milliseconds.
- **F-2:** socket down → the reply lands in `pendingAppProtocolResponses` (fallback kept)
  and is drained on reconnect.
- **F-3:** the relay **never fabricates a timeout response**. Let its
  `timeoutMs + LISTENER_GRACE_MS` timer fire: no `APP_PROTOCOL_RESPONSE` frame is produced,
  the listener is merely unhooked. And the timer is armed with the *server-provided*
  `timeoutMs`, not a private constant.
- **F-4:** `yaar:app-ready` is a direct send; `resendAppProtocolReady` on reattach sends
  `reannounce: true` and skips unmounted windows.

### 3.9 Optional (P3): one real end-to-end smoke

The only test that exercises both halves at once with zero fakes: launch the real server
(`make claude-dev` topology, scripted provider substituted via env), drive a real Chromium
at the real frontend, open a trivial protocol app, issue one command, assert the round trip
beats the deadline. Expensive and flaky-prone — run nightly or pre-release, not per-commit.
The per-commit guarantee is S1 + F-1 in combination.

## 4. Tests to delete, rewrite, or demote

- **Delete** `TestableAppProtocolEmitter` and rewrite
  `action-emitter-app-protocol.test.ts` against the real `actionEmitter`
  (`app-protocol-resolve.test.ts` already proves this is possible; `runWithAgentContext`
  handles the AsyncLocalStorage objection). A test of a hand-copy is worse than no test —
  it is green *because* it can't see production.
- **Demote** `ws-head-of-line.test.ts` to what it is: a fast unit test of queue *policy*
  (keep it — it's cheap and precise) — but it is not the deadlock's regression test and its
  header comment should say the loopback S1 is. Its fake session means it would stay green
  if `routeMessage` itself regressed.
- **Audit and replace** every `expect(mockHandleMessage).toHaveBeenCalled()`-style assertion
  in routing tests with an assertion on what the scripted provider actually received, as
  the harness makes that possible (`message-delivery.test.ts` turn-count assertions migrate
  naturally).
- **Rule, enforced in review:** a test that mocks `SessionHub`, `LiveSession`, or
  `ContextPool` may not claim to test message routing; a test may not assert a timeout
  constant its own mock defined; a new `PendingStore` use without a §3.2 table row does not
  merge.
- **Rule, added by P0:** a `mock.module` in `src/tests` **must stub the whole surface of
  what it replaces**, because the next file to run inherits it and cannot give it back. And
  **nothing under `src/tests/loopback/` may call `mock.module` at all.** See §6.1.

## 5. Build order

| Phase | Work | Yields | Status |
|---|---|---|---|
| **P0** | Seams §1.1–1.3 → harness §2 (fake client, scripted provider, boot/dispose, liveness helpers) → **S1** → run the mutation check | The deadlock class is covered; acceptance criterion met | ✅ **done** — gate passes (red in 644ms) |
| **P1** | S2 table (all five waits + tripwire guard), S3 ordering, S4 message loss | Every current wait covered; queue fix proven both directions; un-awaiting the turn becomes a safe future refactor | open |
| **P2** | S5 dead client, S6 slow app, S7 late reply, F-1…F-4 frontend | Failure modes and the frontend half covered | open |
| **P3** | §4 deletions/rewrites; optional §3.9 e2e smoke | Sandbagging tests removed; no green-by-copy remains | open |

P0 was the gate: if the mutation check (revert the `ANSWER_EVENTS` bypass → S1 red in < 1s)
did not pass, stop and make the harness real before writing any further scenario — a harness
that can't detect the bug we already had will not detect the next one. It passes, so P1 may
proceed on top of it.

## 6. What building P0 turned up

### 6.1 The suite was already order-dependent, and passing on luck

`ws-head-of-line.test.ts` replaces `session-hub.js` with a hub that has a `get()` and
nothing else. `mock.module` is process-global with no teardown, so that *is* the hub every
file running after it receives — and the moment one of them builds a real `AgentPool`
(`agent-cleanup`, `multi-monitor`, `monitor-identity`, …) it dies on
`getSessionHub().registerAgent is not a function`. **21 tests**, live, armed, and invisible
only because Bun happened to order that file last. Adding *any* new test file can reshuffle
that order; adding S1 did, and the mine went off.

A leaking mock cannot be made not to leak — `mock.restore()` is powerless once the real
module has loaded — so it was made *harmless*: that stub now carries the full `SessionHub`
surface, no-ops except the one method the file actually fakes. This is the same class of
defect as §0.4 (a test that is green because it cannot see production), one layer down: a
suite that is green because of the order it happened to run in.

### 6.2 The helper that would have lied

The first `expectStillPending` returned the promise it was probing. An `async` function
awaits a promise it returns — so the helper written to prove "this has *not* finished" quietly
waited for it to finish, for exactly one deadline, and then reported success. It was caught
because S1's timings were absurd (a 150ms "instant" assertion), not because anything failed.
Worth naming: the liveness helpers are themselves load-bearing, and a bug in them is a
green test that proves nothing — precisely what this whole document exists to stop. See §2.1.

### 6.3 What the harness cost, in the end

Two fakes, no module mocks, and one `SessionLogger` double. The feared entanglement of
`AgentSession` (§2, "known risk") did not materialize: profiles, memory, and the environment
section all run for real off the repo's own `apps/`. The one sharp edge is that a *partial*
logger double throws inside the turn, which surfaces as the turn failing — i.e. it looks
exactly like the bug under test. Stub it whole.
