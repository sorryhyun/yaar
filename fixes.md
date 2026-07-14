# Fixes

Successor to `problems.md` — same three issues, now with root-cause analysis and concrete fixes.
The app-protocol round trip today: 9 hops, 3 independent 5s timers, 2 holding queues. The layers
have reasons (server owns the timeout, only the frontend holds the iframe `contentWindow`,
BroadcastCenter for multi-tab); the bugs live in what each layer *added* — its own timer, its own
queue, its own silent-drop path.

## 1. App-protocol replies arrive after their own deadline

**Measured:** `emitAppProtocolRequest` at T+0.0s (`timeoutMs=5000`); `APP_PROTOCOL_RESPONSE`
reaches `routeOne` at T+10.9s → `resolved=false` → agent told "App did not respond (timeout)".

**Root cause analysis.** The original suspect — "`drainPendingQueues` only runs on a store-change
subscription" — is not quite it: `addPendingAppProtocolResponse` *is* a store change, and Zustand
fires subscribers synchronously, so an open socket drains in the same tick. The ~11s hold is one of
two things:

- **Frontend relay timer fired late.** If the reply postMessage never reached the desktop's
  handler (wrong iframe after remount — the source-mismatch guard at `iframe-bridge.ts:204`
  silently rejects it — or the app wasn't listening), the frontend's own 5s timer
  (`iframe-bridge.ts:186`) produces the response. A 5s `setTimeout` firing at ~11s is exactly
  Chrome's hidden-tab timer throttling, and the desktop tab is routinely backgrounded when YAAR is
  driven from a separate Chromium.
- **Socket wasn't OPEN when the reply arrived.** `drainPendingQueues` early-returns silently
  (`usePendingEventDrainer.ts:45`); the reply then sits in the Zustand queue until the next store
  change after reattach. Plausible around the server-restart testing in §2.

**Discriminator (do first):** log the response *payload* at `routeOne`, not just the type. If the
late arrival says `"Timeout waiting for app response (5s)"` it's the throttled frontend timer; if
it's real app data, it's the queue hold.

**Fix (removes the whole class either way):**

- **Send `APP_PROTOCOL_RESPONSE` directly over the socket**, bypassing the pending-queue +
  subscription machinery — precedent already in-tree: `yaar:app-ready` was switched to a direct
  `sendEvent` "to eliminate the subscription-drain latency" (`iframe-bridge.ts:299`). An RPC reply
  to a server already running a deadline gains nothing from being buffered; an 11s-late reply is a
  corpse. Fall back to the queue only if the direct send fails (or drop — the server times out and
  says so either way).
- **Delete the frontend relay timer** (or keep it only as a `console.debug` breadcrumb). The
  server's `PendingStore` deadline is the single source of truth; the frontend timer only
  manufactures a second, indistinguishable "timeout" string and is the piece most exposed to
  background-tab throttling.
- **When a late reply hits an expired `PendingStore` entry, log it with its latency** instead of
  silently returning `resolved=false` — this bug was invisible precisely because the drop was
  silent.

## 2. Readiness lost on server restart, never re-announced

**Root cause (confirmed):** `appProtocol` readiness lives only in the server's
`WindowStateRegistry`, fed by a handshake the iframe performs exactly once, at `app.register()`.
The session layer survives restarts and reconnects; the handshake doesn't. Restart the server with
the tab open → `appProtocol=undefined` → every `app_query`/`app_command` fails with "App did not
register with the App Protocol (timeout)" forever. Tab reload fixes it (confirmed).

**Fix:** on `SESSION_ATTACHED` / resync, the frontend re-sends `APP_PROTOCOL_READY` for every
mounted app iframe (it knows which windows are iframe apps — no need to round-trip into the
iframes; the desktop witnessed their registration). Wire it next to the existing attach-time
`flushPending` in `useAgentConnection`. Server side needs no change: `setAppProtocol` +
`notifyAppReady` are idempotent.

## 3. `browser-user` 403'd from its own endpoint

**Root cause (confirmed):** `POST /api/bridge` checks `requireBundle(principal, 'yaar-web')`, but
`apps/browser-user/app.json` declared no `bundles` — it hand-writes `fetch('/api/bridge')` instead
of importing the SDK, so the compiler never inferred one. Broken since `ad819208`.

**Fix:** already in the working tree, uncommitted — `"bundles": ["yaar-web"]` in
`apps/browser-user/app.json` plus the explanatory comment in `src/bridge.ts`. Commit it.

**Deeper smell (follow-up):** `bundles` means two unrelated things — "may this source *import*
the gated SDK" (compiler gate) and "may this app *call* the SDK's endpoints" (server capability,
`requireBundle`). An app that hand-writes the fetch needs the second without the first. Long-term:
separate capability declaration from compiler hint.

## Cross-cutting: silence is the default failure mode

Every hop converts failure into a silent return or a generic timeout: `drainPendingQueues`'s
socket check, the relay's "element not found" (returned to the agent, never logged locally), the
spoofing guard's rejection, the expired-entry drop. Individually defensive, collectively deadly —
any breakage anywhere surfaces as an indistinguishable timeout three layers away, which is why
diagnosing this took file-based `dbg()` archaeology.

**Fix:** permanent, cheap `console.debug('[AppProtocol] ...')` breadcrumbs at the four relay
moments — request received, postMessage sent, reply received, reply sent — plus the server-side
late-reply log from §1. Then remove the temporary `dbg()` traces (`action-emitter.ts`,
`app-protocol.ts`, `live-session.ts`, `websocket/server.ts`).
