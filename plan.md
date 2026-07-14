# Recovery, Routing, Deadlines, and Access — Fix Plan

Date: 2026-07-13
Supersedes: `report.md` (deleted; its diagnosis and slice log are carried forward here)

## Status

| Slice | Covers | State |
| --- | --- | --- |
| Slice 0 | F-8, F-9, part of F-3 | **Landed** |
| Slice 1 | F-4 — attachment handshake | **Landed** (`feat(recovery): make session attachment a step of its own`) |
| Slice 2 | F-19, F-20, F-21 — access chokepoint | **Landed** |
| Slice 3 | F-7, F-10, F-11…F-14 — monitor identity | **Landed** |
| Slice 4 | F-15, F-16, F-17 — deadline semantics | **Landed** |
| Slice 5 | F-2, F-18 — failure surfacing and delivery | **Landed** |
| Slice 6 | F-1 — authoritative resync | **Landed** |
| Slice 7 | F-5, F-6 — provider and app-protocol continuity | Open |
| Slice 8 | F-3 remainder, F-22 — timing policy and timer hygiene | Open |
| Slice 9 | F-23 — app iframes get an origin of their own | Open (**new**, uncovered by Slice 2) |

**Landed in Slice 0:** `SessionHub.remove()` deregisters in a `finally` (F-9); frontend socket callbacks bail unless they belong to the currently registered socket (F-8); the reconnect budget resets on attachment rather than transport open (F-3, partial).

**Landed in Slice 1:** the WebSocket join answers with a distinct `SESSION_ATTACHED` event carrying `sessionId`, `sessionEpoch`, `connectionId`, and `recoveryMode` (`attached` | `restored` | `replaced` | `created`). `CONNECTION_STATUS` is demoted to provider status only. The frontend's `isConnected` now requires attachment, not just an open transport. `latestEventCursor` was deliberately omitted — there is no retained event log to cursor into (F-1), and a cursor the server cannot honor would be a false promise.

**Landed in Slice 2:** `http/access.ts` is now the single chokepoint. A request resolves to a `Principal` (`host` | `app`) and every route that reaches a real resource names the `yaar://` URI and verb it is about to perform and asks `requirePermission` — the same check `/api/verb` already used, now shared rather than duplicated. `isStaticAsset` is a path test (nothing under `/api/` or `/mcp/` is ever static), so the extension bypass is gone. The MCP principal is a per-agent token bound server-side (`mcp/agent-tokens.ts`); `x-agent-id` is deleted, so an agent can no longer name itself the session agent. `bundles` is enforced at the HTTP door (`/api/dev/*` → `yaar-dev`, `/api/browser` + `/api/bridge` → `yaar-web`, `/api/ml-weights*` → `yaar-ml`), not just at compile time. `POST /api/iframe-token` — a mint-any-app's-token oracle — is host-only, as are `pick-directory`, `remote-info`, and `agents/stats`. An invalid or expired iframe token is now refused instead of being promoted to `host`.

**Landed in Slice 3:** the monitor of a window-scoped event is derived from its window and the monitor of a user-scoped event comes from its connection — and there is no third source. `LiveSession.activeMonitorId` is gone (a session has N connections, so a session-global "current monitor" was last-writer-wins between tabs); a connection holds exactly one `BroadcastCenter` subscription, replace-on-set, and an empty one now means *no* monitor-scoped events rather than *all* of them. `ContextPool.handleTask` derives the monitor for a plain window from `WindowStateRegistry`, as `AppTaskProcessor` already did. Every `?? '0'` is deleted: `requireMonitorId()` and `ActionEmitter.resolveWindowMonitor()` throw instead. The session agent reports the monitor of the turn it is running, so the MCP registry and the emitter can no longer disagree about where its window went. The monitor **list** moved to `LiveSession`: the server mints ids (`ADD_MONITOR`) and broadcasts them (`MONITORS`), and the frontend renders that instead of a per-tab counter that had two tabs colliding on one monitor `"1"`.

One thing the acceptance tests forced into the open: a connection that has not named its monitor now receives nothing, so `monitorId` had to ride on the WebSocket URL. Otherwise everything an agent emitted between attach and the client's first `SUBSCRIBE_MONITOR` would be dropped — and a reconnect into a live session is exactly when there is something to miss.

**Landed in Slice 4:** `PendingStore` has no `defaultValue`. An entry settles as `{ok: true, value}`, `{ok: false, reason: 'timeout'}`, or `{ok: false, reason: 'cancelled'}` (the session went away), and every caller now says in code what a missed deadline means for it. The two that were lying: `window.create` reported an iframe that never answered as a rendered window, and now reports `renderConfirmed: false` naming the uncertainty — the window is on the desktop, but nothing said its content loaded, and that is neither success nor failure; and `askUser`/`requestUserInput` reported a prompt nobody answered as one the user *dismissed*, which is a claim about a user who was not there. The one place silence still means success is `emitActionChecked` (close, updateContent): the frontend answers those only to *veto* them, so no answer is no objection — that is now written down at the call site, because it is indistinguishable from the bug otherwise.

Deadlines are derived from one budget (`MAX_REQUEST_DEADLINE_MS`, 240s) that sits strictly inside the transport's (`TRANSPORT_IDLE_TIMEOUT_S`, 255s — Bun's maximum, so the outer bound cannot be raised to meet the inner ones; the inner ones had to come down). A user prompt (300s) and an external MCP call (300s) both used to outlive the connection holding them open, so their expiry could not be reported even to itself.

**Landed in Slice 5:** `ErrorEvent` carries the `messageId` it is about, and every path that drops a user message now names it: the unknown/absent monitor guards, a pool that failed to initialize, the three queue-full branches, a reset or a removed monitor clearing its queues (`MonitorQueuePolicy.clear()` and `WindowQueuePolicy.clear()` return the tasks they discard rather than swallowing them), and an app window closed with work still queued. The `console.error`-and-drop in the WebSocket message handler — the outermost catch, and the one that swallowed the 30s budget timeout — answers the socket instead, with the id parsed straight off the event it failed on. On the client, message status is driven by terminal events rather than a lazily-evaluated 10s TTL (a chip could sit on "queued" forever for a message that had already died), `activeAgents` is cleared on an *involuntary* disconnect and not only on the explicit one, and `send()` returns whether it delivered. F-2's fix is an **outbox**: `sendMessage` builds the event, puts it in the outbox, *then* sends — so a closed socket can no longer eat a command whose drawing and images have already been consumed out of the store. It is held until `MESSAGE_ACCEPTED`/`MESSAGE_QUEUED` (the server has it) or an `ERROR` naming it (the server refused it), resent on reconnect, and the server dedups by id (`LiveSession.acceptedMessageIds`) so a retry is acked rather than run twice.

**Landed in Slice 6:** the reconnect snapshot is a **replace-state** snapshot, and it is *pulled*, not pushed. The client sends `RESYNC` once it has flushed what it was holding (buffered interactions, outbox), and the server answers with `SNAPSHOT` — windows, plus the notifications, dialogs, and prompts still on screen (a new `SurfaceRegistry`, fed from `LiveSession.broadcast()`, the single gateway every server→client event already goes through, so it cannot drift from what was actually sent), plus the agents actually still running. `applySnapshot` replaces rather than merges: what the snapshot does not name is deleted. That closes the cases a merge structurally could not — a window an agent closed during the outage stayed on screen, a spinner for a finished agent ran until the tab was reloaded, an expired dialog kept offering its buttons.

The order is the whole contract, and it forced a second fix: `message()` in the WebSocket handler is async and Bun does not await one call before making the next, so two frames from the same socket could interleave. That was survivable while every message was independent, but not with `RESYNC`, whose meaning is *"you have now heard everything I did while I was away"* — a snapshot built while the buffered `window.create` in front of it was still awaiting `getAppMeta` would omit that window, and the client, trusting the snapshot, would delete the very window the user had just opened. Messages from one connection are now serialized against each other (`WsData.queue`).

Deliberately not covered: message status is not in the snapshot (the outbox is the client's own truth about what it sent, and the acks rebuild status), and toasts are not in the `SurfaceRegistry` (they expire in seconds and nobody is waiting on an answer — re-showing a stale one is noise, not recovery).

`dialog.close` is a new OS action. Server-side expiry now reaches the screen: an unanswered dialog is still a denial, but it stops asking. And a click that lands just after expiry is no longer dropped whole — the *request* it answered is gone (`resolveDialogFeedback` returns false, and the user is told so with a toast), but "remember my choice" is a standing decision about every future request, not that one, and it is saved.

**Verified:** `packages/server/src/tests/deadline-semantics.test.ts` (15 tests, one `describe` per finding, including the wire path — the close is delivered to a connected socket through `LiveSession.broadcast()`, not merely emitted) and `packages/frontend/src/tests/store/dialog-expiry.test.ts` (the close removes the dialog from the store). Driven against a live server for the happy path: an agent opening an app gets `renderConfirmed: true` once the tab answers. **Not fully verified end-to-end:** a live run with a deliberately silent tab still reported `renderConfirmed: true`, and the reason was not run to ground (most likely a second client on the session answering the same request). The branch itself is pinned by unit test; the live path is not.

Two mappings had to be made explicit to get Slice 2 right, and both are load-bearing:
- `/api/storage/apps/{id}/x` and `yaar://apps/{id}/storage/x` are the *same file*. Only the second is what an app holds a permission for (`yaar://apps/self/storage/` is auto-granted), so `storageUriFor()` canonicalizes the HTTP path into it. Mapping to the flat `yaar://storage/apps/{id}/x` instead would have denied every app its own storage — and made a `yaar://storage/` grant silently mean *every other app's secrets*.
- `self` is resolved on **both** sides of the match — the requested URI and the declared permissions — because app.json speaks `yaar://apps/self/storage/` while a URI derived from an HTTP path speaks `yaar://apps/notes/storage/x`. Matching them literally denies an app its own storage. (A test caught exactly this.)

## Root cause

**The system fills in missing information with a plausible default instead of requiring it or failing.** Every finding below is an instance of that one habit, at a different boundary:

| Missing | Default invented | Consequence |
| --- | --- | --- |
| which monitor a message belongs to | `?? '0'`, or the session-global "active" monitor | work runs on the wrong monitor (F-11…F-14) |
| a response before the deadline | `resolve(defaultValue)` | a timeout is read as success (F-15) |
| a delivery guarantee | `send()` drops and warns | user commands vanish (F-2) |
| a caller identity on an HTTP route | treated as trusted host | the permission model is advisory (F-19…F-21) |
| an event stream across a disconnect | nothing | in-flight work is lost from the UI (F-1) |
| provider conversation continuity | a fresh conversation | agent history silently discarded (F-5) |
| a session incarnation identity | reuse the id | *fixed in Slice 1* |

The fix in each case is the same shape: **make the missing thing a required field or an explicit failure, and delete the fallback.** That is why these slices are simplifications, not additions — each one removes more code than it adds.

---

## Findings

Severity is user impact, not effort.

### Open — access control (Critical)

**F-23 — an app iframe shares the desktop's origin, so any header-based principal is forgeable.** *(New; surfaced while doing Slice 2, and the reason Slice 2's confinement is not yet airtight against hostile app code.)*

Local apps are served same-origin and deliberately unsandboxed — `IframeRenderer.tsx:89`: *"For same-origin content (local apps), don't sandbox - it's trusted."* Slice 2 resolves a caller to a principal from its iframe token, but a malicious app has three ways around that, none of which a token can fix:
- **Omit the token.** `resolvePrincipal` reads "no token" as `host`, because the desktop genuinely has no token. A same-origin `fetch()` from an iframe is byte-for-byte indistinguishable from the desktop's (`Sec-Fetch-Dest: empty`, `Sec-Fetch-Site: same-origin` for both).
- **Spoof `Referer`.** `fetch()`'s `referrer` option accepts any same-origin URL.
- **Reach `window.parent`.** Same-origin means full DOM and memory access to the desktop.

So today the permission model binds network callers, cross-session reads, other-app reads *by an app that plays by the rules*, and every accidental path — but not an app that sets out to escape. The fix is an origin boundary, not another header: serve app iframes from a distinct origin (e.g. desktop on `localhost:PORT`, apps on `127.0.0.1:PORT` — same server, different origin by the browser's rules), which makes `Origin` a browser-set, unspoofable principal. Cost: the frontend loses same-origin DOM reach into app iframes — script injection for non-compiled iframes and HTTP-error detection (`IframeRenderer.tsx:144-260`) must be reworked, CORS widened, and apps that build raw `/api/storage` URLs for `<img>`/`<video>` need the token-appending helper.

**F-19 — HTTP routes bypass the verb permission model.**
The verb layer's model (declared `permissions[]`, `self` resolution, the `session-principal` gate) is sound. The HTTP routes simply don't go through it, and have essentially no checks of their own:
- `GET/POST /api/storage/{path}` consults the iframe token *only* to expand `apps/self` (`packages/server/src/http/routes/files.ts:151-158`). `GET /api/storage/apps/{otherApp}/secrets.json` — and the `POST` write — need no permission and no token. Any app iframe reads and writes every other app's storage and SQLite DB.
- `PATCH /api/domains {allowAllDomains: true}` is in `PUBLIC_ENDPOINTS` (`routes/settings.ts:18`), unauthenticated, no prompt. One call disables the domain allowlist for HTTP fetch, browser navigation, tab control, and ML weight downloads.
- `GET /api/sessions/:id/transcript|messages` is public (`routes/sessions.ts:22`) — cross-session transcript read.
- `/api/browser` and `/api/bridge` are gated only on "holds *some* valid iframe token", not on the app's declared permissions.

**F-20 — remote-mode auth is bypassable by file extension.**
`isStaticAsset()` (`http/auth.ts:55-71`) is a pure extension check on the pathname, evaluated before any `/api` check. In `REMOTE=1`, `POST /api/storage/x.js` and `GET /api/storage/anything.png` skip token auth entirely. Note `IS_REMOTE` is also true for the bundled exe (`config.ts:156`).

**F-21 — the MCP principal is self-asserted.**
`mcp/server.ts:174-183` derives `agentId` — and therefore `role`, and therefore the `session-principal` gate — from an `x-agent-id` **request header**, behind a single process-wide bearer token shared by every agent. Any agent can claim to be the session agent. `MCP_SKIP_AUTH=1` (used by `make dev`) removes even the shared token. Separately, `bundles` gating is compile-time only (`compiler/src/plugins.ts:180`); the doors it nominally fences (`/api/dev/*`, `/api/browser`, `/api/bridge`) accept any iframe token, so a hand-written `fetch` gets the surface without declaring the bundle.

### Closed — monitor identity (High) — *Slice 3*

**F-11 — window-scoped events carry no `monitorId`.**
`WindowMessageEvent` and `ComponentActionEvent` have no `monitorId` field in the schema (`packages/shared/src/events.ts:105-110,142-151`). `ContextPool.handleTask` re-types a plain (non-app) window task to `'monitor'` without deriving the monitor from the window (`agents/context-pool.ts:447`), so it falls to `?? '0'` (`agents/monitor-task-processor.ts:24`). **Clicking a button in a plain window on monitor 1 runs on monitor 0's agent**, streams into monitor 0's CLI, and any window it opens lands on monitor 0. The app-window path derives this correctly (`app-task-processor.ts:36`); the plain-window path does not.

**F-12 — four disagreeing monitor fallbacks.**
`?? '0'` (queue processors, URI handlers: `monitor-task-processor.ts:24`, `handlers/window.ts:184`); `?? activeMonitorId` (the action emitter: `session/action-emitter.ts:207`); the windowId handle prefix (frontend store: `store/slices/windowsSlice.ts:102`); and `findMonitorForAgent()` (MCP: `mcp/server.ts:181`), which returns `undefined` for the session agent (`agents/agent-pool.ts:441`). For a session-agent turn the MCP side scopes the window to `'0'` while the emitter stamps the event with `activeMonitorId` — the window is registered on one monitor and its `ACTIONS` event delivered to another.

**F-13 — `activeMonitorId` is session-global and last-writer-wins.**
`LiveSession.activeMonitorId` (`session/live-session.ts:108,719`) is one field per session, overwritten by whichever connection last sent `SUBSCRIBE_MONITOR`. A session has N connections. Two tabs on different monitors: tab B's subscribe retargets every monitor-less action of tab A's monitor.

**F-14 — the monitor list is client-local.**
`monitors[]` and `monitorCounter` live only in each tab's store (`frontend/src/store/slices/monitorSlice.ts:8-23`). Two tabs independently mint monitor `"1"` and collide on the same server-side agent; neither sees the other's monitors. A reconnecting tab receives snapshot windows on monitors it has no entry for, and `WindowManager.tsx:36` cannot render them.

**F-7 — monitor subscriptions accumulate instead of switching.**
`BroadcastCenter.subscribeToMonitor()` only adds (`session/broadcast-center.ts:47-55`); nothing removes, not even `REMOVE_MONITOR` (`live-session.ts:725`). A tab keeps receiving events for monitors it has left or deleted, and the frontend applies them unfiltered — a deleted monitor's windows can be re-created in the store.

**F-10 — routing semantics flip on the first subscription.**
`publishToMonitor()` treats an empty `subscribedMonitors` as "receive everything" (`broadcast-center.ts:116`). A connection changes routing mode the moment its first `SUBSCRIBE_MONITOR` lands, and combined with F-7 the set never returns to a state with defined meaning.

### Closed — deadline semantics (High) — *Slice 4*

**F-15 — every timeout resolves to a default, so failure is indistinguishable from success.**
`PendingStore.create()` never rejects — on expiry it calls `resolve(opts.defaultValue)` (`session/pending-store.ts:33-35`). All four pending maps inherit this. At the call site, `features/window/helpers.ts:80` checks `if (feedback && !feedback.success)` — so a 3-second rendering-feedback timeout (2s on `window.create`, `features/window/create.ts:190`) reads as **success**, and the agent believes a window rendered that may not exist.

**F-16 — timeout nesting is inverted.**
`Bun.serve`'s `idleTimeout` is 255s (`main.ts:31`), but a user prompt holds its MCP tool call for 300s (`action-emitter.ts:401`) and external MCP calls for 300s (`mcp/external/client-manager.ts:28`). The transport dies 45 seconds before the inner deadline fires; the result is discarded while the inner timer keeps ticking. `app_command`'s 180s ceiling is the only one that fits under the transport limit.

**F-17 — dialogs and prompts have no cancellation path.**
There is no `dialog.close` or prompt-dismiss action anywhere in the protocol. The server times out (60s confirm/permission, 300s prompt) and resolves the tool with `false`, but the dialog stays on the user's screen indefinitely. Their eventual click sends `DIALOG_FEEDBACK` for an id `PendingStore.resolve()` no longer knows — dropped silently, **including the "remember my choice" permission write** (`action-emitter.ts:357-380`).

### Open — failure surfacing and delivery (High)

**F-18 — dropped work is invisible.**
`MonitorBudgetPolicy.acquireTaskSlot` rejects after 30s (`agents/context-pool-policies/monitor-budget-policy.ts:63-67`); the throw propagates to `websocket/server.ts:126` and is `console.error`'d and dropped — no `ERROR` event, no status. The 5th monitor is the same (`live-session.ts:466` `break`s with a warn). Budget interrupts surface as an empty completed response. The frontend's message-status TTL is only evaluated lazily inside `trackMessage`, so with no stream arriving the "queued" chip persists forever. And `activeAgents` is never cleared on an *involuntary* disconnect (`useAgentConnection.ts:163` vs `:195`), so the cursor spinner runs indefinitely after a socket drop.

**F-2 — user commands are silently dropped while disconnected.**
`send()` returns no delivery result. If the socket is not open it logs a warning and discards the event — after the UI has already generated a message ID, added a CLI entry, and consumed the drawing and attached images. No outbox, no acknowledgement, no server-side message-ID dedup.

### Open — resync and continuity

**F-1 — events emitted during disconnection are unrecoverable (High).**
A `LiveSession` outlives its last socket by 60s and agents keep running, but `broadcast()` only reaches sockets open at that instant. There is no retained event log or delivery cursor. The reconnect snapshot restores *windows only* — not agent state, dialogs, prompts, notifications, app-protocol requests, subscriptions, or message status. It also only *adds* server windows; it never removes stale client-only ones, so a window an agent closed during the gap stays on screen.

**F-5 — provider recovery silently loses agent history (High).**
Codex: a lost provider WebSocket errors rather than reconnecting; failed fork/thread-resume falls back to a **new thread**. Claude: a stale resume id clears the session id and retries **without resume**. A fresh conversation is not equivalent to a resumed one, but the outcome is not modeled as `resumed` / `restarted` / `history-lost`, so neither higher layers nor the user can react.

**F-6 — App Protocol recovery is partial and timing-dependent (Medium-High).**
Requests are broadcast once with a 5s wait and are not retained if no connection exists. Successful commands are recorded and replayed on re-registration, but queries and manifests are not, and a command *lost* during disconnection was never recorded — so it is not in the replay log.

**F-3 — reconnect timing policies are inconsistent (Medium, partially addressed).**
The client stops reconnecting after ~15s (5 × 3s, `transport-manager.ts:15-16`) while the server retains the session for 60s (`session-hub.ts:58`). The iframe verb SDK has a third ladder (5s server wait → retryable 503 → 1s, 3s client retries), worst case ~19s. These values encode assumptions about each other with no shared policy.

**F-22 — dead and leaking lifecycle timers (Low, hygiene).**
`AgentPool.idleTimer` is declared and set to `null` and never armed — **there is no idle-agent expiry at all** (`agents/agent-pool.ts:48,155`). `AgentLimiter.acquire(timeoutMs)` and its waiting queue have no callers; every path uses `tryAcquire()`, so the documented graceful backpressure does not exist (`agents/limiter.ts:75`). `ContextPool.teardown`'s 30s inflight race is never cleared or `unref()`'d — a fast teardown still pins the event loop for 30s, and when the timer wins it disposes agents with tasks still in flight, silently (`context-pool.ts:682-690`). `ActionEmitter.readyWindows` is added to but never pruned on window close, so a recycled window key makes `waitForAppReady` return `true` for an app that never registered (`action-emitter.ts:111,457`).

---

## Slices

Slices 2 and 3 are independent and can proceed in parallel. Slice 2 is first by urgency; Slice 3 is the biggest simplification and the one users actually hit.

### Slice 2 — one access chokepoint (F-19, F-20, F-21) — **Landed**

Route the HTTP surface through the same URI + permission check the verb/MCP path already uses, instead of maintaining a second, unchecked path to the same resources.

1. ✅ `/api/storage`, `/api/domains`, `/api/settings`, `/api/sessions`, `/api/shortcuts` resolve their caller to a principal and go through the verb permission check. `/api/domains`, `/api/settings`, `/api/sessions` and `/api/shortcuts` are out of `PUBLIC_ENDPOINTS` — no app has business there. `/api/storage` and `/api/pdf` stay on the iframe allowlist (apps legitimately use their own storage over HTTP) and are permission-checked instead.
2. ✅ `isStaticAsset()` is a path test. Nothing under `/api/` or `/mcp/` is ever a static asset.
3. ✅ Per-agent MCP token bound to the agent id server-side (`mcp/agent-tokens.ts`). `x-agent-id` is gone rather than merely distrusted — a header that names a principal is a hole whatever you check against it.
4. ✅ `bundles` enforced at the HTTP door. The `/api/ml-runtime/` artifacts stay open: ORT loads them itself with no way to attach a token, and they are inert binaries.

Acceptance — verified against a live server, and as tests in `packages/tests/src/integration/access-control.test.ts`: an app iframe with no declared permissions cannot read *or write* another app's storage, cannot flip `allowAllDomains`, cannot read a session transcript, cannot mint itself another app's token, and cannot reach a gated SDK's door — while its own storage still works and the desktop is unaffected. In `REMOTE=1` no `/api/*` path is exempt from the token regardless of extension. An agent cannot obtain `session-principal` by setting a header.

**Not closed:** confinement holds against network callers, cross-session reads, and any app that plays by the rules — but a *hostile* app can still present as the host, because it shares the desktop's origin. See F-23 / Slice 9.

### Slice 3 — monitor is derived, never defaulted (F-7, F-10, F-11…F-14) — **Landed**

The rule: **for window-scoped events the monitor comes from the window; for user-scoped events it comes from the connection. There is no fallback.**

1. ✅ Delete `LiveSession.activeMonitorId`. A session-global "current monitor" is a category error when a session has N connections.
2. ✅ Give each connection exactly one subscribed monitor, replace-on-set. Delete the `Set`, the append-only `subscribeToMonitor`, and the "empty set means everything" branch in `publishToMonitor` (F-7, F-10).
3. ✅ Derive the monitor for `WINDOW_MESSAGE` / `COMPONENT_ACTION` from the window, as `AppTaskProcessor` already does — including on the plain-window path in `handleTask` (F-11).
4. ✅ Delete every `?? '0'` and every `?? activeMonitorId`. A task or action that cannot resolve a monitor is a bug; make it throw rather than guess (F-12). Give the session agent an explicit monitor on each turn instead of two disagreeing fallbacks.
5. ✅ Move `monitors[]` to `LiveSession` and broadcast it on change; the frontend renders server state rather than minting its own (F-14). This removes the client-side counter, the two-tab id collision, and the orphaned-window case on reconnect.

Acceptance: clicking a component in a plain window on monitor 1 runs on monitor 1's agent and renders there; two tabs in one session on different monitors do not steal each other's actions; a deleted monitor stops delivering events; a second tab sees monitors created by the first.

Written first, red, then implemented against: `packages/server/src/tests/monitor-identity.test.ts` (15 tests, one `describe` per finding), plus `packages/tests/src/integration/monitor-routing.test.ts` for the one assertion that cannot run in the server package — `uri-resolve.test.ts` stubs `agent-context` with `getMonitorId: () => '0'`, and Bun's `mock.module` is process-wide and never restored, so "no monitor in context" is not expressible there.

Two tests in `window-handle-scope.test.ts` were **deleted**, not repaired: they asserted that an unstamped window action lands on the session's active monitor, and failing that on monitor 0. That is the bug, and it was pinned by a passing test.

### Slice 4 — deadlines fail loudly (F-15, F-16, F-17) — **Landed**

1. ✅ `PendingStore` returns `{ok: true, value} | {ok: false, reason: 'timeout' | 'cancelled'}`. No caller can read a timeout as success. `create.ts` reports an unconfirmed render as unconfirmed; `helpers.ts` states, rather than assumes, that close/update are veto-only and silence is consent.
2. ✅ Every inner deadline derives from `MAX_REQUEST_DEADLINE_MS` (240s), strictly below `TRANSPORT_IDLE_TIMEOUT_S` (255s). `idleTimeout` could not be raised — 255s is Bun's maximum — so the 300s prompt and the 300s external-MCP call came down instead (F-16).
3. ✅ `dialog.close` (new action) and `user.prompt.dismiss` (already in the schema, never emitted) carry server-side expiry to the UI, on a session-scoped channel because a timer callback has no monitor to stamp. A late click reports itself rather than vanishing, and its remembered choice is still saved (F-17).

Acceptance: a window whose iframe never reports is no longer announced as rendered; no inner deadline exceeds the transport idle timeout; an expired dialog disappears from the screen and a late click is not silently swallowed.

One thing the work forced into the open: **"the frontend said nothing" is not one event, it is two.** For `window.close` it means *no lock objection* — silence is the frontend's way of consenting, and reading it as failure would break every close. For `window.create` it means *the iframe never rendered*. Both arrived as the same `null`, and the fix is not a single rule for timeouts but a demand that each call site name which of the two it is looking at.

### Slice 5 — every dropped message is visible (F-18, F-2) — **Landed**

1. One rule: **any path that drops a user message emits `ERROR` carrying that `messageId`.** Budget rejection, monitor cap, queue full, and pool reset all currently violate it.
2. Drive message status off terminal events, not a lazily-evaluated TTL; clear `activeAgents` on involuntary disconnect, not only on explicit `disconnect()`.
3. `send()` returns a delivery result. A frontend outbox holds commands that require delivery until acknowledged; the server dedups by message id so a reconnect retry is safe. Do not consume the drawing or attached images until the send is acknowledged (F-2).

Acceptance: a submitted command is either acknowledged or visibly still unsent; a throttled or capped message produces a visible error rather than a chip stuck on "queued"; a socket drop mid-turn does not leave a spinner running forever. Pinned by `packages/server/src/tests/message-delivery.test.ts` and `packages/frontend/src/tests/store/resync.test.ts`.

### Slice 6 — authoritative resync (F-1) — **Landed**

Make the reconnect snapshot a **replace-state** snapshot, not an additive one, keyed off Slice 1's `recoveryMode` — `replaced` and `restored` are exactly the cases where the client's local state must be reconciled rather than merged. Cover agents, dialogs, prompts, notifications, message status, subscriptions, and app readiness, not just windows. Stale client-only windows must be removed. An event log with cursors comes only if the replace-state snapshot proves insufficient.

**Partially landed** (`lib/iframeTokenRefresh.ts`): the one piece of stale local state that was actively breaking apps — iframe tokens. They live in the dead process's memory, so after a restart every window the client kept on screen presents a token nothing can validate and every `/api/verb` from it answers 403 for the life of the tab. On a non-`attached` recovery the client now re-mints a token per iframe window it still holds. It is a repair of one field, not the reconciliation this slice describes: stale client-only windows, agents, dialogs, and message status are still merged rather than replaced.

### Slice 7 — provider and app-protocol continuity (F-5, F-6)

Model provider state explicitly (`connected` / `reconnecting` / `resumed` / `restarted` / `history-lost` / `failed`). A fallback to a fresh Claude conversation or Codex thread must never be presented as ordinary continuation. Separate app-protocol *request delivery* from *command-state replay*; give iframes an attachment lifecycle that re-establishes token generation, readiness, subscriptions, and pending requests.

### Slice 8 — timing policy and timer hygiene (F-3, F-22)

Consolidate the three retry ladders into one documented recovery policy whose values are derived from the session lease rather than independently chosen. Then clear the dead timers: arm or delete `AgentPool.idleTimer`; delete `AgentLimiter.acquire` or route acquisition through it; `unref()` and clear the teardown race; prune `readyWindows` on window close.

### Slice 9 — app iframes get an origin of their own (F-23)

Slice 2 gave the permission model a chokepoint; this gives it a principal that cannot be forged. Serve app iframes from a distinct origin so the browser itself, not the app's goodwill, decides who is calling — then `resolvePrincipal` can stop reading "no token" as "the desktop", because the desktop and an app become distinguishable at the transport.

Order matters: this is what turns Slice 2's confinement from *enforced against honest apps* into *enforced*. It was not folded into Slice 2 because it breaks same-origin iframe injection and error detection in `IframeRenderer`, which is frontend work with its own blast radius — and because F-20 and F-21 are the network-facing holes and should not wait behind it.

Acceptance: an app iframe that omits its token, spoofs `Referer`, or reaches for `window.parent` is still confined to what its app.json declares.

---

## Acceptance criteria for the whole effort

1. A submitted user command is either acknowledged or visibly remains unsent.
2. Reconnecting within the lease converges the frontend to authoritative server state.
3. Reconnecting after eviction is identified as a new session epoch. *(Landed, Slice 1)*
4. Missed window closures do not leave stale frontend windows.
5. In-flight agent completion is reflected after reconnect.
6. Approvals and app requests have defined disconnect behavior, and an expired dialog leaves the screen.
7. Provider history loss is visible and never reported as a successful resume.
8. App subscriptions are re-established or explicitly invalidated.
9. Stale socket callbacks cannot overwrite a newer connection. *(Landed, Slice 0)*
10. Multi-tab and multi-monitor routing is deterministic, with no monitor fallback anywhere in the code. *(Landed, Slice 3)*
11. A timeout is never observable as a success. *(Landed, Slice 4)*
12. No `/api/*` route reaches a resource the caller's declared permissions do not cover. *(Landed, Slice 2 — for any caller that presents its identity. Closing it for a caller that hides it needs Slice 9.)*
