# Test Request

We have ~460 tests. They did not catch a deadlock that made every app command fail. This
is what they need to be able to catch, and what to build so they can.

## The bug they missed

Two correct changes composed into a broken system:

1. `live-session.ts` awaits the **entire agent turn** inside `routeMessage` (since Feb —
   harmless, because Bun ran `message()` concurrently).
2. `websocket/server.ts` added `ws.data.queue` to **serialize a connection's frames** (today,
   for RESYNC ordering — correct on its own).

Together: an app-agent turn calls the `command` tool and waits for `APP_PROTOCOL_RESPONSE`.
That reply arrives **on the same socket** and queues behind the frame that started the turn.
The turn can't finish until the reply is read; the reply can't be read until the turn
finishes. Head-of-line deadlock, broken only by the request's own deadline — so every reply
landed exactly one deadline late and the agent was told *"App did not respond"* about an app
that had answered in milliseconds.

Neither unit is wrong. **The bug lives in the seam**, and every test we own mocks the seam.

## Why 460 tests were useless here

- **Nothing crosses the WebSocket boundary.** No test drives `createWsHandlers().message()`
  against a real `LiveSession`. Socket tests mock the session; session tests never see a socket.
- **Nothing tests liveness, only values.** Every assertion is "given input, expect output".
  None is "this must *finish*", "this must finish *while that is still running*", or "this
  must not wait for that". A deadlock is invisible to a test that only checks return values —
  it looks like a timeout, and no test asserts a deadline it didn't itself mock.
- **The client is never a participant.** Five server waits (`PendingStore` ×4, plus
  `waitForAppReady`) block a turn until *the browser answers*. No test models a client that
  answers, so the reentrancy — server waits on client, client replies on the same socket the
  server is holding — has no coverage at all.
- **Mocks hide the real timing.** `handleTask` is mocked to resolve instantly, so "routeMessage
  awaits the whole turn" never *looks* like it awaits anything.

## What to build

### 1. A loopback integration harness (the missing foundation)

Real `createWsHandlers` + real `LiveSession` + real `ContextPool` + real `actionEmitter`, with
exactly two fakes:

- **A fake socket pair.** In-memory, records frames both ways; lets a test *reply* to a
  server request like a browser would (same socket, correct `requestId`).
- **A scriptable fake provider.** An `AITransport` whose turn is a script: "call this tool,
  then say this". Lets a test produce a turn that genuinely waits on the client.

Everything between them must be the real code. That harness is what would have caught this in
one test.

### 2. Liveness assertions, not just value assertions

Add and use these shapes:

- `expectSettlesWithin(promise, ms)` — with a **fake clock**, so a deadlock fails in
  milliseconds instead of hanging CI for 30s.
- `expectStillPending(promise)` — proves ordering is *enforced* where we claim it is.
- `expectConcurrent(a, b)` — proves B is served **while** A is in flight.

### 3. Scenarios (each one is a test we do not have)

1. **App-protocol round trip, end to end.** App agent turn → `command` → `APP_PROTOCOL_REQUEST`
   on the wire → harness replies on the same socket → turn completes. Must finish well inside
   the deadline. *(Fails on the deadlock. This is the one test that mattered.)*
2. **Every server→client wait, table-driven.** One row per pending wait
   (`APP_PROTOCOL_RESPONSE`, `APP_PROTOCOL_READY`, `RENDERING_FEEDBACK`, `DIALOG_FEEDBACK`,
   `USER_PROMPT_RESPONSE`): a turn blocks on it, the client answers on the same socket, the
   turn proceeds. Any future wait added to `PendingStore` gets a row — a wait the client can
   only answer through a socket the server is holding is a deadlock waiting to happen.
3. **Ordering still holds.** A `RESYNC` behind a state-mutating frame must not overtake it
   (the reason `ws.data.queue` exists). Proving the fix didn't trade one bug for another.
4. **No message loss under load.** N user messages in, N handled, exactly once, in order —
   including across a disconnect + reconnect + outbox resend. **This is the guard rail for
   un-awaiting the turn**: if the socket stops awaiting the turn, this test is what proves
   nothing was dropped.
5. **A dead client doesn't wedge the server.** Client never replies → the turn ends at its
   deadline, the agent is told the truth, the next message on that socket still works.
6. **A slow app is not a broken app.** A reply that takes longer than the *frontend's* patience
   but less than the server's deadline must still land. (The old relay's private 5s timer
   turned every slow command into "the app is broken".)
7. **Late reply is reported, never silently dropped.** An answer arriving after its deadline
   must log with its latency. Silence here is what made this bug take days.

### 4. Stop doing these

- Mocking `ContextPool` in anything that claims to test message routing.
- Asserting `expect(mock).toHaveBeenCalled()` where the real question is "did the user's
  message actually get handled".
- Writing a timeout constant into a test's own mock and then asserting the mock's value.

## Acceptance

Revert either half of the fix (the socket's answer-frame bypass, or the frontend's direct
reply send) and scenario 1 must go **red in under a second**. If it doesn't, the harness isn't
real enough.
