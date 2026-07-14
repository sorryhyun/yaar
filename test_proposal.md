# Test Proposal: Which Tests Are Required

This answers `test_request.md` against the actual code and the actual test suite. It names
every test we must have, the harness they need, the small production seams that harness
requires, and the existing tests that must be deleted or rewritten because they test copies,
mocks, or their own constants.

> **Status: P0–P3 are shipped.** The seams (§1), the harness (§2) and every scenario S1–S7
> live in `packages/server/src/tests/loopback/` — **31 tests, ~1.7s** in their own Bun
> process — with the frontend half (F-1…F-4) in
> `packages/frontend/src/tests/store/app-protocol.test.ts`. The §4 deletions are done: the
> hand-written `TestableAppProtocolEmitter` is gone and its file now tests the real
> `actionEmitter` (§6.6). Whole gate: **438 server tests, 67 frontend, typecheck and lint
> clean.**
>
> Every scenario has been shown to go **red** against a deliberate mutation of the code it
> guards — that is the only evidence a test is worth anything, and §6.8 records the four
> mutations and which rows each one killed. The most useful thing that came out of it: **S6
> is a second, independent detector of the original deadlock** (delete the answer-frame
> bypass and all three slow-app rows go red), while S5 and S7 correctly stay green, because
> they are about timeouts and the deadlock is not.
>
> The only thing deliberately **not** built is §3.9, the real-Chromium e2e smoke — the
> reasoning is in §3.9 and it is a recommendation, not an omission.
>
> **Five things in this document were wrong about reality** and are corrected in place: the
> harness directory (§2), the liveness helpers (§2.1), §3.2's assumption that liveness alone
> could carry a row (§6.4), §3.8's assumption that the frontend had none of F-1…F-4 (§6.7),
> and §4's claim about `toHaveBeenCalled()` (§6.7). §6 records what building it turned up,
> including a live order-dependent failure in the existing suite (§6.1), a **cross-session
> leak in production** (§6.5), and a second cross-file leak — this one in the *frontend*
> tests — that the new drain test tripped over on its first full-suite run (§6.7).

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

### 3.2 `loopback-answer-waits.test.ts` — Scenario 2, one row per server→client wait ✅

Table-driven over the shared `ANSWER_EVENT_TYPES` (§1.1). Each row provides: a scripted
turn step that blocks on that wait, and the client frame that answers it.

| Row | Turn blocks in | Client answers with | Starved, it reports |
|---|---|---|---|
| `APP_PROTOCOL_RESPONSE` | `handleAppCommand` / `handleAppQuery` | `APP_PROTOCOL_RESPONSE` (same `requestId`) | "App did not respond within 0s" |
| `APP_PROTOCOL_READY` | `requireAppReady` on a not-yet-registered window | `APP_PROTOCOL_READY`, then the command reply | "App did not register with the App Protocol" |
| `RENDERING_FEEDBACK` | `emitActionWithFeedback` (window capture path) | `RENDERING_FEEDBACK` (same `requestId`) | `ok: false` — nothing rendered |
| `DIALOG_FEEDBACK` | `showPermissionDialogToSession` | `DIALOG_FEEDBACK` (same `dialogId`) | `false` — denied by default |
| `USER_PROMPT_RESPONSE` | `showUserPrompt` | `USER_PROMPT_RESPONSE` (same `promptId`) | `{dismissed: true}` |

Per row: `expectStillPending(turn)` before the answer (the wait is real), then answer
through `deliver()`, then `expectSettlesWithin(turn, budget)` and assert the turn saw the
*answer's value* (the dialog's `confirmed`, the prompt's text — not just "it finished").

**The fourth column is why the value assertion is the load-bearing one**, and the document
was wrong to imply liveness could carry a row alone. Every one of these waits *ends* at its
deadline whether or not the answer arrives — under harness deadlines (150ms) that is fast
enough to look healthy, so `expectSettlesWithin` passes on a deadlocked turn. What cannot
survive the deadlock is the *value*: each row is answered with something the timeout path
cannot produce (a dialog nobody answers is `false`, not `true`). Confirmed by the mutation
check: with the bypass deleted, all five rows go red on the value, none on the budget.

Plus one static guard in the same file: every `ClientEventType` whose `routeMessage` case
calls a `PendingStore.resolve*` or `notifyAppReady` must be in `ANSWER_EVENT_TYPES`. The
table iterates the shared list, so **a future wait added without a row fails this file** —
that is the "deadlock waiting to happen" tripwire the request asks for. It scans
`live-session.ts` for `actionEmitter.resolve*`/`notifyAppReady` inside a `case
ClientEventType.X:` body, and asserts the count it finds equals `ANSWER_EVENT_TYPES.length`
— so a scan that has stopped seeing the code it scans fails too, rather than going
vacuously green.

### 3.3 `loopback-ordering.test.ts` — Scenario 3, the fix didn't trade one bug for another ✅

- Turn from frame A held open (scripted step parks on a test-controlled gate);
  `deliver(RESYNC)`; `expectStillPending(snapshotFrame)` — RESYNC must **not** overtake.
  Release the gate; snapshot arrives and reflects frame A's effects.
- `USER_INTERACTION` (window.create) followed immediately by `RESYNC`: the `SNAPSHOT` frame
  must contain the window (the original reason `ws.data.queue` exists).
- Two ordinary frames + one answer frame interleaved: the answer overtakes, the two
  ordinary frames keep their mutual order.

### 3.4 `loopback-message-loss.test.ts` — Scenario 4, the guard rail for un-awaiting ✅

- Send M1…M5 (M1's turn briefly held): assert 5 turns, exactly once each, in order — the
  scripted provider records the prompts it was handed, which *is* "the user's message got
  handled", not `expect(mock).toHaveBeenCalled()`.
- Each accepted message produced its ack; duplicate `messageId` re-delivered mid-flight →
  re-acked (`agentId: 'duplicate'`), no second turn.
- `disconnect()` while M3 queued → `reconnect()` same `sessionId` → outbox resend of M3 →
  exactly one M3 turn total; new messages on the new connection still flow.

This file is what makes it *safe* to ever stop awaiting the whole turn in `routeOne` — if
that refactor drops or reorders a message, this is the red light.

### 3.5 `loopback-dead-client.test.ts` — Scenario 5, a dead client doesn't wedge the server ✅

Built as the **mirror of the S2 table**: the same five waits, and no responder anywhere in
the file. That absence *is* the dead client. Deadlines at 80ms (50 proved too tight to
distinguish from `expectStillPending`'s own macrotask flush on a loaded CI box).

Per row: `expectStillPending(turn)` once the question is on the wire, then the turn settles
on its own inside its budget, then — the row's real assertion — the tool received the
*truthful* message. Each is chosen to be **unmistakable for an answer**: an app that never
registers and an app that registers and then says nothing get *different* sentences (one is
worth retrying, the other is not); a starved capture is `ok: false, reason: 'timeout'`, not a
rendered window; a dialog is `false`; a prompt is `{dismissed: true, timedOut: true}` — "never
saw it", deliberately distinct from "declined". Plus: the **next** `USER_MESSAGE` on the same
socket runs normally — a dead client costs one turn, not the connection.

One note on the assertions: the command timeout is matched by *shape*
(`/^App did not respond within \d+s\b/` + "retry with a larger timeoutMs"), not by re-typing
production's format string into the test. A test that spells the sentence out is asserting a
constant it declared itself, and would go on passing if the message were reworded into
something useless — the §4 rule, applied to §4's own file.

### 3.6 `loopback-slow-app.test.ts` — Scenario 6, slow is not broken ✅

Server deadline 300ms; responder answers at 150ms — slower than "instant" (the regime the
old frontend 5s relay timer punished) but inside the server's deadline. The turn gets the
real answer, and **no timeout string is anywhere near it**
(`expect(text).not.toMatch(/did not respond|did not register|timeout/i)`). Two assertions
beyond that: the round trip really *waited* (`elapsed >= 150ms` — otherwise the test would
still pass if the server answered itself the instant it asked, which is the exact shape of a
second clock speaking for an app that is still thinking), and the deadline the server put on
the wire is the one it is actually keeping (a relay cannot honour a deadline it was never
told). A third row proves a caller's own `timeoutMs` survives, against a *default* short
enough to have timed the command out.

**This file turned out to be a second, independent detector of the original deadlock** —
delete the answer-frame bypass and all three rows go red, because a reply queued behind the
turn is exactly a reply that misses its deadline. S1 and S6 now fail for the same bug by two
different routes.

### 3.7 `loopback-late-reply.test.ts` — Scenario 7, late is reported, never silent ✅

Real `actionEmitter` for the first three, one full-loopback variant for the fourth (it lives
in `loopback/` rather than `src/tests/` so that no other file's `mock.module` can reach it):

- deadline 30ms, reply at 60ms: the turn already ended with the timeout message, and the
  `console.warn` spy captured `[AppProtocol] Late reply … arrived after Xms, Yms past its
  30ms deadline`. **The latency is the finding** — a reply 3ms late is a slow app; a reply
  arriving *exactly one deadline* late, every time, from an app that answered instantly, is a
  queue holding it. Those two are indistinguishable in the agent's transcript and obvious in
  this log line, which is the entire reason the log line exists;
- reply for a never-issued `requestId` → the "unknown request" branch, and explicitly *not*
  the late one (nothing was waiting, so there is no latency to report and no app to
  exonerate);
- **remembered vs. pruned**: the expired request is held for a 5-minute grace window and then
  forgotten. Tested with `setSystemTime` (Bun can move `Date` even though it cannot fake
  `setTimeout`, and the prune reads `Date.now()`), so the same reply is *late* inside the
  window and *unknown* after it. A test that only ever looked inside the window would pass
  just as well if the map grew forever — which is the leak this codebase has already shipped
  once (§6.5);
- the loopback variant: the late reply lands on a live socket the server is no longer
  holding, is logged as late, and **costs the connection nothing** — the next `USER_MESSAGE`
  still runs.

### 3.8 Frontend counterparts — `packages/frontend/src/tests/store/app-protocol.test.ts` ✅

The acceptance criterion says reverting *either* half of the fix must go red. The server
harness plays the client itself, so it cannot see a frontend regression; the frontend half
needs its own fast tests.

**Three of the four already existed** — written alongside the fix itself, in
`app-protocol.test.ts` rather than the new `app-protocol-relay.test.ts` this document
invented. P2's frontend work was therefore one leg, not four. Naming what was already there
(rather than adding a second file that would have shadowed it) is the point of §4's rule
about tests that test copies:

- **F-1 (mutation target for the second half):** ✅ *"sends the reply straight down the
  socket, never through the pending queue"*. Reverting `sendAppProtocolResponse` to queueing
  goes red here in milliseconds.
- **F-2:** ✅ fallback existed (*"falls back to the pending queue only when the socket is
  down"*); the **drain half was missing and is new** — *"drains the queued reply when the
  socket comes back"*. A queue that fills and never empties is not a fallback, it is a leak
  that also loses the reply. Verified red against a drainer that skips the app-protocol queue.
- **F-3:** ✅ *"manufactures no response when the app stays silent — the server owns the
  deadline"* and *"outlives the server deadline before unhooking"* (the timer is armed with
  the **server-provided** `timeoutMs`, not a private constant).
- **F-4:** ✅ `yaar:app-ready` is a direct send (unflagged), and `resendAppProtocolReady`
  re-announces with `reannounce: true` and skips unmounted windows.

### 3.9 Optional (P3): one real end-to-end smoke — **not built, deliberately**

Everything else in this document is built. This one is a recommendation against, and it is
worth stating the reasoning rather than leaving it as an open checkbox someone ticks later
out of tidiness.

What it would add over what now exists: nothing that is *load-bearing*. Its unique claim is
"both halves, zero fakes, one process" — but S1 already proves the server half against a
client that answers on the real socket, F-1 proves the frontend half against a real store and
a real `postMessage` relay, and the two mutation checks (delete the server bypass → S1+S6
red; revert the relay to queueing → F-1 red) are precisely the acceptance criterion this
scenario was invented to satisfy. What it would add instead is a real Chromium, a real
provider process, and a real port — i.e. three new ways to be red for reasons that have
nothing to do with the app protocol, on a test whose whole value is being trusted when it is
red. A flaky guard rail gets muted, and a muted guard rail is worse than an absent one,
because the suite still looks like it covers this.

If it is ever built, it belongs on a nightly, and it should assert **latency**, not
correctness — the one thing the loopback cannot see is a real browser being slow (a throttled
background tab, a 60Hz raf, a real postMessage hop), and that is a *number* worth watching
over time, not a boolean worth blocking a commit on.

## 4. Tests to delete, rewrite, or demote ✅

- **Deleted.** `TestableAppProtocolEmitter` is gone; `action-emitter-app-protocol.test.ts`
  now tests the real `actionEmitter` (17 tests). The AsyncLocalStorage objection was never
  real — `runWithAgentContext` supplies the context, exactly as the MCP HTTP handler does in
  production. See §6.6: the copy was not merely stale, it *was* the §6.5 bug, and it could
  never have found it.
- **Demoted.** `ws-head-of-line.test.ts` keeps its tests (cheap, precise, a real statement of
  queue *policy*) and its header now says plainly what it is not: its session is a stub, so it
  would stay green if `routeMessage` regressed, and it stayed green through the entire life of
  the bug it appears to be about. The regression test is the loopback S1, and the header names
  it.
- **Audited — and the claim above was wrong.** There is no
  `expect(mockHandleMessage).toHaveBeenCalled()` anywhere in the routing tests. What exists is
  `handleMessage.mock.calls.length` (`message-delivery.test.ts`), which is a *count*, and a
  count is strictly better than `toHaveBeenCalled()` — it catches a doubled message. It still
  cannot catch a dropped or reordered one, because the stub it counts resolves instantly and
  there is no turn to drop or reorder. So it is kept (it is the fast check for the duplicate-
  `messageId` case) and **annotated with what it cannot see**, pointing at loopback S4, which
  counts what the real provider was actually handed. Rewriting it to use the harness would
  have bought nothing S4 does not already prove.
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
| **P1** | S2 table (all five waits + tripwire guard), S3 ordering, S4 message loss | Every current wait covered; queue fix proven both directions; un-awaiting the turn becomes a safe future refactor | ✅ **done** — 16 loopback tests; mutation reds all 5 rows, leaves the queue rows green |
| **P2** | S5 dead client, S6 slow app, S7 late reply, F-2 frontend drain (F-1/F-3/F-4 already existed — §6.7) | Failure modes and the frontend half covered | ✅ **done** — 31 loopback tests; S6 reds under the deadlock mutation too |
| **P3** | §4 deletions/rewrites; §3.9 e2e smoke **recommended against** (§3.9) | Sandbagging tests removed; no green-by-copy remains | ✅ **done** — the hand-copy is gone and its replacement reds 6× under a re-introduced §6.5 |

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

P1 added exactly two things to it: a `deferred()` gate (so a test can park a turn where it
wants it, and be *told* when the turn reaches its wait rather than guessing with a timer),
and an optional predicate on `waitForFrame` (two of the five waits ask their question inside
an `ACTIONS` frame, and "the first ACTIONS frame" is not reliably the question).

### 6.4 The row that could not be carried by liveness

S2's five rows were specified as "block, answer, assert it finished". Four of them would
have passed *without the fix*. A starved wait does not hang — it ends at its deadline, and
the harness deadline is 150ms, which is indistinguishable from healthy at a 1 000ms budget.
The liveness assertion is real but it is not the discriminator; the discriminator is that
each row is answered with a value its timeout path cannot invent (`true` from a dialog that
denies by default, the user's own text from a prompt that reports `{dismissed: true}`).
This is §0's finding restated one level up: a deadlock *produces an output*, so any
assertion that accepts an output accepts the deadlock. See the fourth column in §3.2.

### 6.5 A production bug, found by the second test that used the harness — and fixed ✅

The `APP_PROTOCOL_READY` row failed on arrival — the command it was supposed to unblock
timed out. The cause was not the test. `ActionEmitter.readyWindows` was a process-global
`Set` keyed by window key (`"0/ai-chat"`), with **no session in the key and no removal,
ever**. The first row to register that app left the key in the set; every session
afterwards — a different `LiveSession`, a different browser, a different user — found
`waitForAppReady` returning `true` for an iframe that had never spoken, and
`requireAppReady` stopped being a wait.

In the product that meant a new session's first `command` to a freshly-opened app could be
sent before that app's iframe had registered, covered only by the command's own deadline —
surfacing as "App did not respond", the exact symptom this whole document is about, from a
second and entirely unrelated cause. The set also never forgot a closed window, so a
desktop open for a day accumulated one entry per window it had ever shown.

**Fixed.** Readiness is now a `Map<sessionId, Set<windowKey>>`; `notifyAppReady`,
`isAppReady` and `waitForAppReady` all take the session, and the internal `'app-ready'`
event carries `{sessionId, windowId}` so a registration in session A cannot wake a waiter in
session B. Entries are dropped when the session goes (`clearPendingForSession`, reached from
`SessionHub.remove`) and when the window closes (`forgetAppReady`, on `LiveSession`'s
window-close callback — reopening a window under the same key mounts a *new* document, and a
surviving registration would tell its first command the app was already listening: the same
defect at a smaller radius). A caller with no resolvable session now **fails closed** — an
`undefined` session matches no `'app-ready'` event, so the wait times out rather than
falsely proceeding, which is the safe direction for a check whose whole job is to wait.

The proof is `loopback-app-ready-scope.test.ts` (S5): register an app, throw the session
away, boot a second session, and assert the wait comes back. It asserts that **no
`APP_PROTOCOL_REQUEST` is on the wire while the turn is parked** — under the leak the
request is already sent, which is the defect made visible *before* any deadline expires and
without relying on liveness (a starved wait ends too, at its deadline). Verified red on the
old code, green on the new.

`resetReadyWindowsForTest()` — the test-only seam P1 added to paper over this — is **gone**,
which is the tell that the fix is real: the harness no longer needs to scrub global state
between tests, because there is no longer global state to scrub.

Worth naming for the same reason as §6.1: the state that broke the test was global,
unowned, and invisible to every unit test, because a unit test never has a second session.

### 6.6 The hand-copy was not stale — it *was* the bug

`action-emitter-app-protocol.test.ts` defined a `TestableAppProtocolEmitter`, a
re-implementation of the emitter's app-protocol methods, written "to avoid AsyncLocalStorage
and other server dependencies", and asserted against that. Ten tests, green forever, and
§0.4 already knew they were worthless. What was not appreciated until they were deleted is
*how* worthless:

- the copy modelled readiness as **one process-wide `Set<windowId>` with no session in the
  key** — which is precisely the production bug §6.5 found. The copy could not have caught
  it. The copy *was* it, faithfully, in a file whose job was to catch it;
- it still resolved a timed-out request to `null`, a shape production had abandoned for
  `PendingOutcome` — so it was simultaneously green about behaviour production no longer had;
- it imported the production emitter **zero times**. Not "a little decoupled": there was no
  path from any assertion in that file to any line of shipped code.

The replacement tests the real emitter, and most of it is about the thing the copy could not
express at all — that readiness is scoped to a session, that a closed window forgets, that a
wait which cannot name its session **fails closed**. The proof it is real: re-introduce the
§6.5 leak (make `isAppReady` search every session's set) and **6 of the 17 go red**. The old
file, under the same mutation, cannot go red — it never sees the code.

This is the strongest available argument for the §4 rule. A test of a copy does not merely
fail to catch bugs; it *reproduces* them, and then reports that they are not there.

### 6.7 Two more things this document was wrong about, and a leak in the frontend tests

**§3.8 assumed the frontend had none of F-1…F-4.** Three of the four already existed, written
alongside the fix, in `app-protocol.test.ts` — the file this document proposed to *extend*
while also proposing a new `app-protocol-relay.test.ts` to hold the same tests. Building the
second file would have produced two files asserting the same contract, which is how a suite
starts telling itself things twice and believing them twice. The real gap was one leg: the
queued reply was proven to *enter* the fallback queue and never proven to *leave* it. That is
now F-2's second test.

**§4 misquoted the routing tests.** They do not assert `toHaveBeenCalled()`; they count
`mock.calls.length`. The criticism survives the correction (a count against an instant stub
cannot see a dropped or reordered message) but the quote did not, and it was reproduced
verbatim in the S4 file's header, where it has been fixed. A document that mis-describes the
code it is auditing is doing a smaller version of what it is auditing the code for.

**And the new drain test found a leak — in the frontend suite this time.** It passed alone
and failed in the full run, reading *two* frames where it expected one. The second frame was
another file's: the Zustand store is a module singleton shared by every test file in the Bun
process, `drainPendingQueues` empties all six outbound queues at once, and each test file
resets only the slice it happens to care about — so `feedback-slice.test.ts` left an item in
`pendingFeedback`, and the drain test flushed it and counted it as its own. Same family as
§6.1 (a suite green because of the order it ran in), a different runtime, and found the same
way: by a new test changing the shape of the process and setting off a mine that was already
armed. Fixed on both sides — the file now resets every queue it will look at, and the
assertion filters to the frames it is actually about.

### 6.8 The mutations, and which rows died

No test in this document is trusted because it is green. Each was made to go **red** against
a deliberate break in the code it claims to guard, and the *pattern* of reds is as
informative as the reds:

| Mutation | Goes red | Stays green — correctly |
|---|---|---|
| Delete the `isAnswerEvent` bypass (**the original deadlock**) | **S1** (2/3), **S6** (3/3) | S5, S7 — they are about timeouts, and the deadlock does not change what a timeout does |
| `handleAppCommand` ignores the caller's `timeoutMs` | S6's caller-timeout row (1/3) | S6's other rows — they do not pass one |
| A late reply is dropped in silence (no expired-request memory) | **S7** (3/4) | S7's unknown-request row — a reply nobody asked for was never late |
| An unanswered prompt loses `timedOut` | S5's prompt row (1/6) | S5's other rows — a different wait, a different truth |
| Readiness forgets the session (**re-introduce §6.5**) | 6/17 of the rewritten emitter tests | — |
| The drainer skips the app-protocol queue | F-2's drain test | — |

The first row is the one worth keeping. **S6 was not designed to catch the deadlock** — it
was designed to prove that a merely-slow app is not reported as a broken one. It catches the
deadlock anyway, because under the deadlock a reply *is* late, which is what makes the two
bugs the same bug seen from two ends. That is the sign the harness is measuring the system
rather than the test author's expectations of it: it found a connection that was not put
there on purpose.
