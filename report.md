# Connection, Session, and Agent Recovery Diagnosis

Date: 2026-07-13

## Executive summary

YAAR's connection and recovery behavior is genuinely complex, and the complexity currently creates correctness risks rather than merely making the code difficult to follow.

The system has several independently implemented recovery mechanisms:

- browser WebSocket reconnection;
- `LiveSession` reuse and eviction;
- frontend window reconstruction;
- iframe/app reattachment and HTTP verb retries;
- app-protocol readiness and command replay;
- Claude conversation resume and fresh-session fallback;
- Codex app-server WebSocket and thread resume/fallback.

These mechanisms do not share an end-to-end recovery contract. In particular, there is no session generation, event cursor, authoritative full-state reconciliation, reliable client outbox, or explicit indication that an agent conversation was restarted instead of resumed.

The result is that the system may report a successful connection while losing events, commands, app requests, or agent history. The highest-risk behavior is silent continuity loss: a new transport, session instance, or provider thread can be presented as though it were the continuation of the previous one.

## Scope

This report is diagnostic only. It examines recovery across:

1. frontend-to-server WebSocket connections;
2. server-side `LiveSession` lifetime;
3. frontend state reconstruction;
4. iframe applications and the App Protocol;
5. monitor, app, and session agents;
6. Claude and Codex provider sessions.

## Current lifecycle model

The effective lifecycle is:

```text
Browser WebSocket
  -> attaches to sessionId
  -> SessionHub returns or creates LiveSession
  -> LiveSession owns windows and ContextPool
  -> ContextPool owns monitor/app/session agents
  -> each agent owns a provider connection or conversation/thread
  -> iframe apps independently call HTTP verbs and App Protocol
```

Each arrow represents a boundary that can fail or restart independently. Today, recovery at one boundary does not prove continuity at the next boundary.

## Findings

### F-1: Events emitted during disconnection are not recoverable

Severity: High

A `LiveSession` remains alive after its last WebSocket disconnects and is normally evicted after 60 seconds. Agents can continue running during that grace period. However, `LiveSession.broadcast()` forwards events only to WebSockets that are open at that moment. There is no retained event log, delivery cursor, or replay acknowledgement.

On reconnection, the server sends:

- a `CONNECTION_STATUS` event;
- a snapshot consisting of current windows represented as `window.create` actions;
- CLI restore entries only when the startup-level `cliEntries` value is still available.

The snapshot does not restore:

- agent thinking or response events;
- active/completed agent state;
- approval or user-prompt dialogs;
- notifications and toasts;
- app-protocol requests;
- subscription updates;
- message acknowledgement state;
- other non-window UI state.

Consequences include:

- an agent completing while the frontend continues to show stale activity;
- an approval request disappearing while the provider waits or times out;
- an app query or command timing out even if the browser reconnects shortly afterward;
- a window closed by an agent during disconnection remaining in the frontend, because the reconnect snapshot adds existing server windows but does not remove client-only stale windows.

Evidence:

- `packages/server/src/session/live-session.ts`, `broadcast()` and `generateSnapshot()`;
- `packages/server/src/websocket/server.ts`, WebSocket `open()` handler;
- `packages/server/src/session/broadcast-center.ts`, immediate-send publication methods.

### F-2: User commands can be silently dropped while disconnected

Severity: High

The frontend `send()` helper returns no delivery result to its callers. If the WebSocket is not open, it logs a warning and discards the event.

For a user message, the frontend has already:

- generated and tracked a message ID;
- added a CLI history entry;
- consumed the current drawing;
- consumed attached images.

It then attempts the WebSocket send. If disconnected, the UI has locally committed the action but the server never receives it. There is no outbound queue, retry, acknowledgement, or server-side message-ID deduplication contract.

Window messages, dialog responses, interrupts, and other direct sends have the same delivery weakness.

Evidence:

- `packages/frontend/src/hooks/useAgentConnection.ts`, `send()` and `sendMessage()`;
- `packages/frontend/src/hooks/use-agent-connection/transport-manager.ts`, `sendEvent()`.

### F-3: Reconnect timing policies are inconsistent

Severity: Medium

The frontend retries a failed WebSocket every three seconds for at most five attempts. A server-side session is retained for 60 seconds. Therefore, the client may stop reconnecting after roughly 15 seconds while the server continues retaining the session for another 45 seconds.

The iframe verb SDK uses a separate recovery ladder:

- the server may wait five seconds for the named session to reappear;
- the endpoint returns a retryable 503;
- the iframe retries after one second and then three seconds.

These values encode assumptions about one another but are not governed by a shared policy or attachment state. Small timing changes can invalidate the intended behavior.

Additionally, frontend reconnect attempts are reset as soon as the WebSocket transport opens, before session attachment and synchronization are confirmed. A server that repeatedly accepts and then closes a socket may therefore avoid the intended retry limit.

Evidence:

- `packages/frontend/src/hooks/use-agent-connection/transport-manager.ts`;
- `packages/frontend/src/hooks/useAgentConnection.ts`, `onopen` and `onclose`;
- `packages/server/src/session/session-hub.ts`, `scheduleEviction()`;
- `packages/shared/src/iframe-scripts/verb-sdk.ts`.

### F-4: A session ID does not identify one session incarnation

Severity: Medium-High

If a requested session ID is still present in `SessionHub`, reconnection returns the same `LiveSession` object. If it has been evicted, `getOrCreate()` creates a new `LiveSession` using the requested ID.

Thus, the same `sessionId` can mean either:

- the same in-memory session and agent pool;
- a reconstructed session after process restart;
- a new session instance created after eviction.

There is no epoch, generation, incarnation ID, or recovery mode in the connection response. The frontend and iframe apps cannot distinguish a true reattachment from a replacement session.

This makes stale local state, iframe capabilities, pending requests, and assumed agent continuity difficult to reconcile safely.

Evidence:

- `packages/server/src/session/session-hub.ts`, `getOrCreate()` and `scheduleEviction()`;
- `packages/server/src/websocket/server.ts`, connection-status response.

### F-5: Provider recovery can silently lose agent history

Severity: High

Outer YAAR session continuity and provider conversation continuity are separate, but the UI does not expose that distinction.

For Codex:

- the provider WebSocket is established during warmup;
- if that WebSocket later becomes unavailable, `query()` emits an error rather than reconnecting it;
- failed fork or thread-resume attempts fall back to starting a new thread;
- certain invalid-thread errors clear the current thread and recursively retry.

For Claude:

- a persistent stream that ends before responding is retried fresh;
- a stale resume ID causes the provider to clear the session ID and retry without resume.

These fallbacks improve availability, but a fresh provider conversation is not semantically equivalent to a resumed conversation. An app or monitor agent can retain its YAAR identity while losing its provider-side history.

The recovery outcome is not modeled as `resumed`, `restarted`, or `history-lost`, so neither higher layers nor the user can react appropriately.

Evidence:

- `packages/server/src/providers/codex/provider.ts`, `query()` and `ensureThread()`;
- `packages/server/src/providers/claude/session-provider.ts`, `runPersistentTurn()`.

### F-6: App Protocol recovery is partial and timing-dependent

Severity: Medium-High

App Protocol requests are broadcast once and wait for a response for five seconds. If no frontend connection is available, the request is not retained for later delivery.

Successful commands are recorded and may be replayed when an iframe re-registers. However:

- queries and manifest requests are not replayed;
- a command is recorded only after it has successfully received a response;
- a command lost during disconnection is therefore not part of the replay log;
- replay restores command effects but is not a general request-delivery mechanism.

The HTTP verb retry mechanism addresses the absence of a `LiveSession`, but it does not make WebSocket-carried App Protocol requests reliable.

Evidence:

- `packages/server/src/session/action-emitter.ts`, `emitAppProtocolRequest()`;
- `packages/server/src/features/window/app-protocol.ts`, query and command handlers;
- `packages/server/src/session/window-state.ts`, `recordAppCommand()`;
- `packages/server/src/session/live-session.ts`, `replayAppCommands()`.

### F-7: Monitor subscriptions accumulate instead of switching

Severity: Medium

Each WebSocket connection has a `Set` of subscribed monitor IDs. `SUBSCRIBE_MONITOR` adds to this set, but switching the active monitor does not remove the former subscription.

A tab can therefore receive monitor-scoped events for every monitor it has visited. This increases ambiguity in multi-tab and app routing, particularly when app-protocol messages are session-wide and frontend resolution uses the active monitor as a fallback.

Evidence:

- `packages/server/src/session/broadcast-center.ts`, `subscribeToMonitor()`;
- `packages/frontend/src/hooks/use-agent-connection/useMonitorSync.ts`.

### F-8: Socket callbacks are not guarded against stale socket instances

Severity: Medium — fixed in Slice 0

The frontend callbacks mutate the singleton `wsManager.ws` without verifying that the callback belongs to the currently registered socket. If a new socket is created while an older socket is closing, the older socket's delayed `onclose` can set `wsManager.ws` to `null` and schedule another reconnect.

The current `connect()` guard reduces the frequency of this race, but it permits creating a new socket while the old one is in `CLOSING` or `CLOSED` state. Socket identity should be checked before callbacks alter shared connection state.

Evidence:

- `packages/frontend/src/hooks/useAgentConnection.ts`, `connect()`, `onopen`, and `onclose`.

## Test coverage assessment

The existing focused connection tests pass, but they do not validate the recovery guarantees discussed above.

The WebSocket session test described as reconnection verifies only that calling `SessionHub.getOrCreate()` with an existing ID returns the same object. It does not exercise a network disconnect/reconnect cycle or assert state convergence.

Missing scenarios include:

- events emitted while no connection is present;
- an in-flight agent turn spanning a disconnect;
- authoritative removal of stale frontend windows;
- a user message submitted while disconnected;
- reconnect after session eviction;
- provider WebSocket loss;
- provider thread/conversation fallback visibility;
- app-protocol query or command spanning disconnection;
- reconnect with multiple monitors or tabs;
- stale socket callback ordering.

Focused tests run during this diagnosis:

```text
bun test packages/tests/src/integration/websocket-session.test.ts \
  packages/frontend/src/tests/hooks/agent-connection-policies.test.ts

14 passed, 0 failed
```

This result confirms the current unit-level behavior, not end-to-end recovery correctness.

## Root cause

The main issue is the absence of explicit recovery semantics across layers.

Three kinds of continuity are currently treated as approximately interchangeable:

1. transport continuity: a WebSocket is open;
2. session continuity: the same `sessionId` is attached;
3. agent continuity: the same provider conversation and history are available.

They are not equivalent. A socket can reconnect to a replacement `LiveSession`, and an existing `LiveSession` can hold an agent whose provider thread was restarted. Apps introduce a fourth form: capability and iframe-runtime continuity.

Local retries attempt to conceal these distinctions, which makes failure modes silent and difficult to test.

## Recommended target model

### 1. Separate transport connection from session attachment

Opening a WebSocket should mean only that transport is available. A subsequent attachment handshake should return at least:

```text
sessionId
sessionEpoch
connectionId
recoveryMode: attached | restored | replaced
latestEventCursor
```

The frontend should not declare the session connected until attachment and initial synchronization complete.

### 2. Add authoritative state synchronization

Use either:

- a full replace-state snapshot; or
- a snapshot plus ordered event replay from a client cursor.

The synchronization payload should cover all recoverable state, not only windows. At minimum it should define behavior for agents, dialogs, prompts, notifications, message status, subscriptions, and app readiness.

### 3. Make outbound commands reliable

Maintain a frontend outbox for commands that require delivery. Each command should have a stable ID and remain pending until acknowledged by the server.

The server should deduplicate command IDs so reconnect retries are safe. Destructive or non-idempotent commands need explicit idempotency semantics.

### 4. Model provider recovery explicitly

Provider state should expose transitions such as:

```text
connected
reconnecting
resumed
restarted
history-lost
failed
```

A fallback to a new Claude conversation or Codex thread should not be represented as ordinary continuation. Higher layers can then decide whether to rebuild context, notify the user, retry the task, or stop.

### 5. Give applications an attachment lifecycle

After session synchronization, each iframe should re-establish:

- its current token/capability generation;
- App Protocol readiness;
- reactive subscriptions;
- any pending reliable requests.

Command-state replay can remain as state restoration, but it should be separate from request delivery.

### 6. Define monitor subscription semantics

Choose and encode one of:

- exactly one active monitor per connection;
- an explicit subscribe/unsubscribe set;
- all monitors for every connection.

The current implicit accumulation should be removed from the contract.

## Suggested implementation order

1. Prevent silent command loss with send results, an outbox, acknowledgements, and deduplication.
2. Add `sessionEpoch` and distinguish reattachment from replacement.
3. Make reconnect synchronization authoritative, initially through a full replace-state snapshot.
4. Add provider connection recovery and expose whether history was resumed or restarted.
5. Move iframe/App Protocol recovery onto the explicit attachment lifecycle.
6. Add event cursors if uninterrupted stream and UI history recovery are required.
7. Consolidate retry timings into one documented recovery policy.

## Acceptance criteria for a corrected design

A recovery design should be considered complete only when automated tests demonstrate that:

1. a submitted user command is either acknowledged or visibly remains unsent;
2. reconnecting within the lease converges the frontend to authoritative server state;
3. reconnecting after eviction is identified as a new session epoch;
4. missed window closures do not leave stale frontend windows;
5. in-flight agent completion is reflected after reconnect;
6. approvals and app requests have defined disconnect behavior;
7. provider history loss is visible and never reported as a successful resume;
8. app subscriptions are re-established or explicitly invalidated;
9. stale socket callbacks cannot overwrite a newer connection;
10. multi-tab and multi-monitor routing is deterministic.

## Conclusion

The concern is valid. The current implementation has multiple reasonable local fallback mechanisms, but they do not compose into reliable end-to-end recovery.

The central design change is to stop treating an open socket, an attached YAAR session, a live iframe, and a resumed agent conversation as the same condition. Once those states are explicit, reconnection becomes a controlled synchronization protocol rather than a collection of timing-based fallbacks.

## Addendum: verification findings and Slice 0 plan

Date: 2026-07-13 (same day, after an independent verification pass against the code)

All high-severity findings above were re-verified against the current source and hold. The verification pass surfaced two additional findings.

### F-9: A failed eviction wedges a half-destroyed session in the hub

Severity: High — fixed in Slice 0

`SessionHub.remove()` awaits `session.cleanup()` before `sessions.delete(sessionId)`. If `cleanup()` throws, the delete never runs — but `scheduleEviction()` already removed the eviction timer before calling `remove()`. The result is a permanently stuck `LiveSession` whose emitter listeners and pending requests were partially torn down, and `getOrCreate()` will happily reattach the next reconnect to that half-dead instance. This is strictly worse than clean eviction: the session ID resolves, but the session no longer behaves.

Evidence:

- `packages/server/src/session/session-hub.ts`, `remove()` and `scheduleEviction()`;
- `packages/server/src/session/live-session.ts`, `cleanup()` (multiple awaits that can throw: logger dispose, pool cleanup).

### F-10: Monitor routing semantics flip when the first subscription arrives

Severity: Medium

`publishToMonitor()` treats an empty `subscribedMonitors` set as "receive all monitor-scoped events" (backward compatibility). A connection therefore changes routing mode the moment its first `SUBSCRIBE_MONITOR` is processed. Events emitted between socket open and that message are routed under different rules than events after it, and — combined with F-7's grow-only set — the set's contents never return to a state with defined meaning.

Evidence:

- `packages/server/src/session/broadcast-center.ts`, `publishToMonitor()` empty-set branch;
- `packages/frontend/src/hooks/useAgentConnection.ts`, `onopen` (subscription sent after open).

### Slice 0: immediate fixes — done

Landed: `SessionHub.remove()` deregisters in a `finally` (F-9); socket callbacks are wired through `openSocket()` and bail unless they belong to the currently registered socket (F-8); the reconnect budget resets on `CONNECTION_STATUS` rather than transport open (F-3, in part). Each has an acceptance test.

### Slice 1: the attachment handshake — done

Target model item 1 ("separate transport connection from session attachment"), which also closes F-4.

The WebSocket join now answers with a distinct `SESSION_ATTACHED` event carrying `sessionId`, `sessionEpoch`, `connectionId`, and `recoveryMode` (`attached` | `restored` | `replaced` | `created`). `CONNECTION_STATUS` is demoted to what it always really was — provider status — and no longer doubles as proof that a socket is bound to a session.

- `sessionEpoch` stamps the *incarnation*, not the id: `SessionHub.attach()` classifies whether the requested id resolved to the live session (`attached`), a new one seeded from boot-time restore state (`restored`), a new empty one under an id this process evicted or never held (`replaced`), or a session the client never asked for (`created`). Eviction is checked before restore state, so a replaced session that happens to come up with boot windows is not reported as a rejoin.
- The frontend's `isConnected` now requires attachment, not just an open transport, and a socket that drops loses its attachment. `markAttached()` keys off `SESSION_ATTACHED`. A non-`attached` recovery mode is surfaced rather than absorbed.
- `latestEventCursor` is deliberately absent: there is no retained event log to cursor into (F-1), and a cursor field the server cannot honor would be a false promise. It belongs with the event-log slice.

Verified against a running server: rejoining a live session returns the same epoch and `attached`; an unknown id returns a new epoch and `replaced`; a browser reload rejoins its own session in place.

Acceptance tests cover `attach()` classification, epoch uniqueness across incarnations, the join event's shape, and the frontend's connected-means-attached rule.

### Next slices

Following the "Suggested implementation order" above: send results without premature input consumption (order item 1), then the replace-state snapshot plus one defined monitor-subscription semantic covering F-7/F-10 (items 3 and 7). The snapshot slice can now key off `recoveryMode` — a `replaced` or `restored` attachment is exactly the case where the client's local windows must be reconciled rather than merged.

Still open from the findings: F-1 (unrecoverable events), F-2 (silently dropped commands), F-3 (the remaining timing-policy inconsistencies), F-5 (provider history loss), F-6 (App Protocol delivery), F-7 and F-10 (monitor subscription semantics).
