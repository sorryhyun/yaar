# Proposal: Runtime Decomposition and Session-Scoped Event Routing

**Status:** Partially implemented — **0A and 0B have landed**, so Phase 1 is unblocked. 0C is
open and its stated premise turned out to be stale (see that section). Revised 2026-07-19:
evidence re-verified against master, and the app protocol manifest work extracted to
[`app_protocol_manifest_proposal.md`](./app_protocol_manifest_proposal.md).
**Scope:** `packages/server`, `packages/frontend`, and the `@bundled/yaar` shim in `packages/compiler`
**Primary objective:** remove process-global session fan-out and split the remaining large runtime coordinators without changing YAAR's public protocols or application behavior

## Summary

YAAR's package-level architecture is healthy: shared wire contracts are centralized, server business logic is moving behind `features/` and URI handlers, agent execution already uses processors and policies, and the frontend store is slice-based.

The remaining headroom is concentrated in a few runtime coordinators:

- `ActionEmitter` combines process-wide delivery, ambient identity, four request/response brokers, permissions, prompts, and app readiness.
- Every `LiveSession` subscribes separately to that process-global emitter.
- `LiveSession` owns connection lifecycle, routing, monitors, snapshots, app protocol, user interaction handling, and browser cleanup.
- `ContextPool` has monitor/app processors, but still implements session-agent turns and window/app event coordination directly.
- A few internal modules (`handlers/apps.ts`, `config.ts`, `iframe-bridge.ts`, and the `@bundled/yaar` shim) contain several independently testable domains behind one file.

This proposal addresses those in dependency order. The first phase is not cosmetic: session-addressed event delivery is a correctness boundary that the later extractions should build on.

A related constraint that used to be Phase 3 here — app `protocol.ts` files cannot be freely decomposed because the compiler discovers their manifest from one literal `app.register({ ... })` expression — is a compiler/DX project with its own risk profile and demand curve. It now lives in [`app_protocol_manifest_proposal.md`](./app_protocol_manifest_proposal.md); this proposal only carries the invariant it protects (see Required invariants).

## Current evidence

### Static structure

| Module | Approximate size | Responsibilities currently combined |
|---|---:|---|
| `session/live-session.ts` | 1,044 lines | session lifecycle, client routing, monitors, snapshots, app protocol, interactions, cleanup |
| `session/action-emitter.ts` | 809 lines | event dispatch, ambient identity, feedback, dialogs, prompts, permissions, app RPC/readiness |
| `agents/context-pool.ts` | 878 lines | pool lifecycle, session tasks, routing, subscriptions, event rate limits, reset/cleanup |
| `agents/agent-pool.ts` | 684 lines | monitor/app/session/ephemeral agent lifecycle and lookup |
| `frontend/store/iframe-bridge.ts` | 563 lines | iframe lookup, capture, app RPC, subscriptions, drag state, SDK requests, notifications |
| `compiler/shims/yaar.ts` | 696 lines | verb client, app storage, app DB, dialogs, UI helpers, reactive persistence |

### Existing groundwork

*(As surveyed before Phase 0 landed. `SessionEmitterBridge` no longer exists — 0B replaced it
with `session/session-event-router.ts`.)*

Part of the session-addressing machinery already exists, which makes Phase 0A smaller than it may read:

- `session/emitter-channels.ts` defines a `SessionScopedEvent` envelope with a required `sessionId`, and derives the `SessionScopedChannel` list from the channel map type so a new session-scoped channel cannot be forgotten in the filter path.
- Seven forwarded channels (`session-action`, `user-prompt`, `approval-request`, `verb-subscription`, `desktop-shortcut`, `browser-action`, and app readiness via `AppReadyEvent`) already carry a session and are filtered per session in `subscribeSessionChannels()`.
- `SessionEmitterBridge` centralizes each session's subscriptions with an idempotent `detach()`.
- `session/client-event-router.ts` exists as the total `ClientEventRoutes` seam that Phase 1.2 builds on.

The channels that remain unscoped are exactly `action` and `app-protocol`. Phase 0A is therefore "extend the existing envelope pattern to those two channels and make their `sessionId` required," not "invent session addressing." The per-session listener growth (Phase 0B) is unaddressed by any of the above.

### Session fan-out

*(Fixed by 0A and 0B. Retained as the evidence those phases were built against, and as the
description of what regresses if the addressing is ever loosened again.)*

`SessionEmitterBridge` adds one listener per live session for `action`, `app-protocol`, `bridge-event`, and each session-scoped forwarding channel. Creating eleven retained sessions in `packages/tests/src/integration/websocket-session.test.ts` produces `MaxListenersExceededWarning` for those channels. The assertions still pass, so this is not evidence of a failed cleanup path by itself; it is evidence that listener count grows with session count.

There are also stronger static correctness findings:

- `ActionEvent` has an optional `sessionId`, but `emitAction()` does not populate it from `AgentContext` by default.
- `SessionEmitterBridge` forwards every `action` event to every `LiveSession`, and `LiveSession.handleEmittedAction()` does not filter by session. The handler applies every process-wide action to its own `WindowStateRegistry`, notifies its own `yaar://windows` subscribers, and — because monitor IDs are session-local — bills `event.monitorId` against its **own** monitor's action budget. With two live sessions, session B's budget is charged for session A's actions today. In local single-browser use this is invisible; in `REMOTE` mode with two connected devices it is real.
- `AppProtocolRequestData` has no `sessionId` at all.
- `emitAppProtocolRequest()` reads the current session for its pending entry, then emits a process-global `app-protocol` request without that session.
- Every `LiveSession` therefore relays the request to its frontend. Two sessions with the same monitor/window key can observe and answer the same request ID; the first answer wins the global pending entry.

`bridge-event` is intentionally global because one real-browser bridge may be relevant to more than one session. Action and app-protocol delivery are not intentionally global.

### Validation baseline

At the time of this revision:

- `bun run typecheck` passes for every workspace package.
- `bun run test` passes for every workspace package.
- The targeted WebSocket session integration test passes with the listener warnings described above.

This green baseline is the compatibility gate for each phase below.

## Goals

1. Make every frontend-directed action and app-protocol request belong to exactly one session.
2. Keep process-global subscriptions constant as the number of live sessions grows.
3. Keep `LiveSession` as the session aggregate root while moving independently testable policies out of it.
4. Finish the processor pattern in `ContextPool` without hiding role-specific agent semantics behind a generic framework.
5. Preserve existing public imports, wire event shapes during migration, and app behavior unless a phase explicitly introduces a versioned contract.

## Non-goals

- Replacing `EventEmitter` everywhere.
- Rewriting the agent pool or provider implementations.
- Splitting files solely to satisfy a line-count target.
- Moving `shared/actions.ts` or `shared/events.ts` into many small files; they are authoritative discriminated contracts and benefit from central review.
- Introducing a base class or framework for app entry points. Their similarity is mostly convention, while their runtime needs differ substantially.
- Changing monitor, window, or agent identity semantics.
- Combining MIME tables whose extension sets represent different capabilities merely because they overlap.
- The app protocol manifest contract — see [`app_protocol_manifest_proposal.md`](./app_protocol_manifest_proposal.md).

## Required invariants

1. A frontend-directed event is delivered to one `SessionId`, unless its type is explicitly declared global.
2. A window action always carries or resolves a monitor; this proposal does not reintroduce monitor `0` fallbacks.
3. Server-to-client waits remain answerable over the socket that is holding them. Existing loopback coverage remains mandatory.
4. `LiveSession.broadcast()` remains the only server-to-frontend gateway because it enforces monitor routing and surface tracking.
5. Session cleanup settles all pending waits as cancelled and detaches every session-owned resource.
6. Agent roles remain explicit (`session`, `monitor`, `app`, `ephemeral`); shared lifecycle primitives may be deduplicated, but role behavior does not become data-driven magic.
7. App protocol descriptor maps remain single-literal `app.register({ ... })` expressions until the manifest contract lands. Handler bodies may move to imported functions; descriptor objects may not be spread, computed, or imported. Static and runtime manifests must continue to agree.

## Target architecture

```text
tool / HTTP route / provider
        |
        v
SessionEventRouter  <---- one process-wide subscription per channel
        |
        +-- ActionDispatcher ---------> session.broadcast(ACTIONS)
        +-- InteractionBroker <-------- feedback / dialog / prompt answers
        +-- AppProtocolBroker --------> session.broadcast(APP_PROTOCOL_REQUEST)
        |
        v
LiveSession (aggregate root)
        |
        +-- MonitorRegistry
        +-- ClientEventController
        +-- SessionSnapshotService
        +-- AppWindowCoordinator
        +-- ContextPool
              +-- MonitorTaskProcessor
              +-- AppTaskProcessor
              +-- SessionTaskProcessor
              +-- WindowEventCoordinator
```

The names are descriptive, not mandated. The ownership boundaries are the proposal.

## Phase 0: session-addressed event delivery

This phase should land before moving substantial code out of `LiveSession` or `ActionEmitter`. Otherwise the existing implicit routing is merely redistributed across more modules.

Phase 0 is three independently mergeable steps, and only the first two gate the later phases: **Phase 1 may begin once 0A and 0B have landed.** 0C (ambient identity removal) is the step most likely to stall on provider capabilities and must not block the rest of the program.

### 0A. Make delivery envelopes honest — **landed**

Extend the existing `SessionScopedEvent` pattern to the two channels that lack it. Change frontend-directed emitter payloads so they name their destination:

```ts
interface ActionEvent {
  sessionId: SessionId;
  action: OSAction;
  requestId?: string;
  agentId?: string;
  monitorId?: string;
}

interface AppProtocolRequestData {
  sessionId: SessionId;
  requestId: string;
  windowId: string;
  request: AppProtocolRequest;
  timeoutMs?: number;
}
```

`emitAction()` and `emitAppProtocolRequest()` resolve `sessionId` from the explicit argument or `AgentContext`. If neither exists, a frontend-directed call fails loudly instead of being broadcast to an arbitrary/default session. `SessionEmitterBridge` (or its successor) filters `action` and `app-protocol` by session the same way `subscribeSessionChannels()` already filters the forwarded channels.

Some actions originate outside an agent turn. Those call sites already know their target session or use a session-scoped channel; make that target explicit rather than consulting `SessionHub.getDefault()`.

Keep `BridgeEvent` explicitly global. If another global event is added later, it must opt into a separate global envelope rather than making `sessionId` optional again.

#### What landed, and two things this plan did not anticipate

An unaddressable emit *drops* with a `console.error` naming the action type, rather than
throwing. Throwing would have introduced new crash paths into fire-and-forget callers on HTTP
routes; the waiting variants (`emitActionWithFeedback`, `emitAppProtocolRequest`) instead
settle immediately as `cancelled`, so no caller waits out a deadline for an action that was
never sent — a silence the caller would otherwise read as "the frontend declined".

Two findings beyond the plan:

- **`ToolActionBridge` had the same defect at a second layer.** It filtered with
  `if (event.agentId && event.agentId !== myAgentId)`, so an action emitted *outside* a turn —
  carrying no `agentId` — passed the filter for every agent in every session. The plan treated
  the `LiveSession` listener as the only unfiltered consumer of `action`; it was not. Now
  filtered on session first, which is only possible because 0A made the field required.
- **Three call sites had no session to resolve**, and would have silently regressed to dropped
  emits: `/api/dev/*` (deploy and git-restore emit `desktop.refreshApps` and shortcut actions)
  and two `/api/browser` routes. Each already had an `AppPrincipal` carrying `sessionId`, so
  they now run inside `runWithAgentContext` exactly as `POST /api/verb` already did. One
  `SessionHub.getDefault()` went with them — it was choosing which session to raise a browser
  consent dialog against, which is a question about *whose* desktop and not one a map ordering
  should answer.

### 0B. Install one process-level router — **landed**

Add a `SessionEventRouter` initialized with server lifecycle:

```ts
interface SessionEventSink {
  handleAction(event: ActionEvent): void;
  handleAppProtocolRequest(event: AppProtocolRequestData): void;
  broadcast(event: ServerEvent): void;
}

router.attach(sessionId, sink);
router.detach(sessionId);
```

The router subscribes once to each process-global source and resolves the destination sink by `sessionId`. `LiveSession` registers one sink when constructed and unregisters it during cleanup. Session-scoped forwarding channels can either enter the same router or call a lifecycle-owned `SessionHub` delivery method; they should no longer create one listener per session.

`bridge-event` keeps one process-level listener and explicitly fans out only to sessions with a relevant bridge window.

#### What landed

`session/session-event-router.ts` holds one subscription per channel for the process
lifetime and resolves the destination sink by id; `session-emitter-bridge.ts` is deleted.
`bridge-event` fans out to every attached sink, as the one deliberately global channel.

`detach()` takes the sink and checks its identity before removing it. A session id is not
unique over time — an evicted `LiveSession` and its replacement share one, which is what
`epoch` exists to distinguish — so deleting by id alone would let a late `cleanup()` on the
old object unsubscribe the new one. That failure is silent: a live session that receives
nothing logs no error and drops no event, it just stops updating. The per-session bridge could
not have this bug, because each object removed the listeners it had personally added; the
identity check is what preserves that property under a shared map.

### 0C. Remove process-global ambient identity

`ActionEmitter.currentAgentId` and `currentMonitorId` are mutable fallbacks around provider turns. Concurrent provider turns can overwrite one another, even though `AsyncLocalStorage` is exact for ordinary in-process work.

**The premise below is stale, and 0C is probably smaller than it reads.** This section claimed
the fallback exists because Codex cannot attach per-call identity. It can, and does:
`providers/codex/provider.ts` builds a per-thread MCP scope stamping `x-agent-token`
(`buildMcpScope`), and `agentId` is set unconditionally on every turn's `TransportOptions`
(`agent-session.ts`). Step 1 below has therefore already landed, and the
`getCurrentAgentId()` fallback in `mcp/server.ts` looks unreachable in practice.

What remains is narrower but not free, and the risk sits in `currentMonitorId` rather than
`currentAgentId`. `resolveWindowMonitor()` *throws* when no monitor is in context, so if
`SessionHub.findMonitorForAgent()` fails to resolve for any agent that emits a window action,
deleting the fallback converts a working `window.create` into an exception. Whether it always
resolves is a runtime question about live Codex turns with overlapping agents, not one the
code answers by inspection. Validate against a real Codex session before deleting.

Preferred order:

1. Ensure provider MCP calls carry the server-minted agent token wherever the provider permits it.
2. Resolve agent/session/monitor from that token at the MCP boundary.
3. For a provider that cannot attach identity, bind identity to that provider connection or turn object, not to a process-global singleton.
4. Delete `setCurrentAgent`, `clearCurrentAgent`, `setCurrentMonitor`, and `clearCurrentMonitor` after all call sites migrate.

Do not replace this with another global map keyed only by "current turn". Identity must be connection- or async-context-scoped.

### Phase 0 acceptance tests

Per step, so each can merge on its own gate. 0A's live in
`packages/server/src/tests/session-isolation.test.ts` and 0B's in
`session-event-router.test.ts`; both sets were confirmed to fail against the unfixed code
rather than merely to pass against the fixed code.

**0A — session isolation:**

- Two live sessions with the same window key: an app query reaches only its originating session.
- A response from the non-originating session cannot resolve the pending request.
- An action emitted in session A changes only session A's `WindowStateRegistry`, subscriptions, and monitor budgets.
- Existing loopback answerability and late-reply tests remain green.

**0B — constant listener count and cleanup:**

- Creating twenty live sessions keeps process-global listener counts constant.
- Cleanup cancels only the departing session's waits and leaves the other session's waits intact.
- No `MaxListenersExceededWarning` in the retained-sessions integration test. Measured rather
  than assumed: nine warnings on master, zero after 0B.

**0C — concurrent identity:**

- Two concurrent provider turns retain distinct agent, monitor, and session identity.

## Phase 1: thin `LiveSession` without weakening ownership

`LiveSession` remains the owner of its connections, `WindowStateRegistry`, layout, reload cache, context pool, logger, and cleanup order. It delegates four coherent policies. Prerequisite: Phases 0A and 0B (not 0C).

### 1.1 `MonitorRegistry`

Move:

- authoritative monitor list;
- ID allocation and limit enforcement;
- per-connection subscription updates;
- viewport updates;
- monitor removal and subscriber detachment.

The registry calls injected callbacks for `removeMonitorAgent()` and event delivery. It does not import `ContextPool` or `BroadcastCenter` singletons directly.

### 1.2 `ClientEventController`

Move the total `ClientEventRoutes` table and event-specific handlers behind a dependency object containing:

- session and connection delivery functions;
- `WindowStateRegistry`;
- `SurfaceRegistry`;
- lazy `ContextPool` access;
- monitor registry;
- logger and browser-cleanup callbacks.

The route table stays total at compile time. `LiveSession.routeMessage()` remains the public entry and delegates after initialization and message-ID deduplication.

Message acceptance/deduplication should remain at the session boundary, not inside individual task processors.

### 1.3 `SessionSnapshotService`

Move:

- window-to-create-action conversion;
- iframe-token refresh;
- surface snapshots;
- active-agent snapshot formatting.

Snapshot construction remains read-only over injected registries. It must not acquire providers, create agents, or mutate window state.

### 1.4 `AppWindowCoordinator`

Move:

- app readiness tracking at the session boundary;
- command replay after a real iframe re-registration;
- app channel/event routing;
- app-protocol request delivery to the originating frontend.

The request/response pending lifecycle itself belongs to `AppProtocolBroker` from Phase 0; this coordinator owns session/window behavior only.

### Phase 1 acceptance tests

- Existing `ClientEventRoutes` exhaustiveness test remains compile-time enforced.
- Resync snapshots are identical before and after extraction.
- Re-announcing app readiness does not replay commands; remounting does.
- Removing one monitor detaches only that monitor's subscribers and agents.
- Browser sessions close under the same user-interaction conditions as before.

## Phase 2: finish `ContextPool` decomposition

### 2.1 `SessionTaskProcessor`

Monitor and app turns already have processors; session-agent execution should use the same boundary. Move:

- lazy session-agent acquisition;
- session-agent steering;
- monitor pinning;
- session prompt construction;
- model/tool selection;
- `runAgentTurn()` invocation.

`ContextPool.handleSessionTask()` becomes the reset/inflight guard plus delegation.

### 2.2 `WindowEventCoordinator`

Move:

- window subscription key resolution;
- change and app-channel notifications;
- per-window app-event rate limiting;
- close-time subscription and queue cleanup;
- active app-window resolution where it is genuinely event/window state.

It composes `WindowSubscriptionPolicy` and `AppTaskProcessor`; it does not become another agent pool.

### 2.3 Keep role lifecycle explicit

`AgentPool.createAgentCore()` and `disposeAgent()` are the correct shared lifecycle seams. Monitor, app, session, and ephemeral agents should continue to have named APIs because they differ in:

- key and owner;
- persistence;
- provider acquisition;
- monitor/window association;
- removal behavior;
- roster presentation.

A generic `ManagedAgentRegistry<TKey, TRoleConfig>` would reduce repeated map operations but obscure the behavior that multi-monitor tests are designed to protect. Do not introduce it unless a later implementation shows substantial identical logic remaining after the processor extractions.

### Phase 2 acceptance tests

- All multi-monitor and monitor-identity tests remain green.
- Session, monitor, and app steering preserve current queue semantics.
- Reset reports every dropped message and waits for inflight work exactly as before.
- Closing an app window clears only its scoped tasks/subscriptions.

## Phase 3: bounded internal module splits

These extractions have lower architectural risk and can proceed independently after the session boundary is fixed. They are opportunistic cleanup — pick them up as the files are touched, not as a scheduled program.

### 3.1 App URI handlers

Keep `registerAppsHandlers()` as the public registration function and split implementation into:

```text
handlers/apps/
  register.ts
  app-resource.ts
  storage-resource.ts
  db-resource.ts
  paths.ts
```

The current `ResourceRegistry` wildcard syntax does not support arbitrary middle wildcards such as `yaar://apps/*/storage/*`. Therefore the initial split should remain an internal composite behind `yaar://apps/*`, not pretend the registry can dispatch these subresources independently.

### 3.2 Server configuration

Turn `config.ts` into a compatibility barrel over:

```text
config/
  env.ts
  paths.ts
  assets.ts
  deadlines.ts
  limits.ts
  providers/claude.ts
  providers/codex.ts
  browser.ts
```

Load the root `.env` from one explicit bootstrap point before importing environment-derived constants. Avoid modules whose values change depending on which consumer imported `config.ts` first.

### 3.3 Frontend iframe bridge

Keep one initialization entry point and split:

```text
store/iframe-bridge/
  target.ts
  capture.ts
  app-protocol-relay.ts
  subscription-relay.ts
  app-events.ts
  windows-sdk.ts
  notifications.ts
  index.ts
```

`target.ts` owns the repeated monitor/window-key resolution, DOM lookup, iframe lookup, and target-origin logic. Inject the store accessor or narrow selectors so the current explicit circular import from `iframe-bridge.ts` to `desktop.ts` does not spread to every child module.

### 3.4 `@bundled/yaar` SDK internals

Preserve `import { ... } from '@bundled/yaar'` and split its source into internal modules:

```text
shims/yaar/
  verbs.ts
  app-storage.ts
  app-db.ts
  dialogs.ts
  ui.ts
  reactive.ts
  index.ts
```

The compiler shim entry remains a barrel. This is an internal ownership/testability change, not a new collection of public subpath imports.

## Change inventory

Files marked *(exists)* already exist on master — the work is modification, not creation.

### Phase 0

Done in 0A/0B:

- `packages/server/src/session/emitter-channels.ts` — `sessionId` required on both envelopes
- `packages/server/src/session/action-emitter.ts` — address-or-drop on every emit path
- `packages/server/src/session/session-emitter-bridge.ts` — **deleted**, replaced by:
- `packages/server/src/session/session-event-router.ts` — **new**
- `packages/server/src/session/live-session.ts` — attaches/detaches a sink
- `packages/server/src/agents/session-policies/tool-action-bridge.ts` — session filter *(not in the original inventory)*
- `packages/server/src/agents/agent-session.ts` — passes its session to the bridge
- `packages/server/src/http/routes/dev.ts`, `http/routes/browser.ts` — run in agent context *(not in the original inventory)*
- `packages/server/src/tests/session-isolation.test.ts`, `session-event-router.test.ts` — **new**

Remaining for 0C:

- `packages/server/src/providers/claude/session-provider.ts`
- `packages/server/src/providers/codex/provider.ts`
- `packages/server/src/mcp/server.ts`
- `packages/server/src/session/session-hub.ts`, `agents/agent-context.ts`

### Phase 1

- `packages/server/src/session/live-session.ts`
- `packages/server/src/session/client-event-router.ts` *(exists — becomes the `ClientEventController` seam)*
- new monitor, snapshot, client-event, and app-window modules

### Phase 2

- `packages/server/src/agents/context-pool.ts`
- `packages/server/src/agents/pool-types.ts`
- `packages/server/src/agents/app-task-processor.ts`
- new session-task and window-event modules

### Phase 3

- `packages/server/src/handlers/apps.ts`
- `packages/server/src/config.ts`
- `packages/frontend/src/store/iframe-bridge.ts`
- `packages/compiler/src/shims/yaar.ts`

## Delivery plan

| Phase | Outcome | Merge gate | Status |
|---|---|---|---|
| 0A | Session IDs required on action and app-RPC envelopes | two-session isolation tests | **landed** |
| 0B | One session event router; constant global listener count | listener-count and cleanup tests | **landed** |
| 0C | Broker split and removal of global current identity | concurrent-turn identity tests | open — premise revised |
| 1 | Thin `LiveSession` (needs 0A+0B, not 0C) | snapshot, reconnect, monitor, and loopback suites | unblocked |
| 2 | Session processor and window event coordinator | agent pool and multi-monitor suites | open |
| 3 | Handler/config/frontend/SDK internal splits | package-local tests plus full workspace gate | opportunistic |

Each row should be independently mergeable. Avoid one repository-wide relocation commit: it would mix behavior fixes with import churn and make review of the session boundary unnecessarily difficult.

## Risks and mitigations

### Duplicate delivery during migration

Running the old per-session bridge and the new router simultaneously can send an action twice. Put delivery behind one feature seam and switch ownership atomically per channel. Add a request/action ID assertion in tests where possible.

### Events emitted without a session

Making `sessionId` required will expose timer, HTTP, warm-up, and test call sites that depended on defaults. Treat that as useful migration evidence. Session-scoped UI work must take a session explicitly; truly global work must use a distinct global channel.

### 0C removes a fallback that is load-bearing at runtime

The original risk here — that Codex cannot attach per-call identity — no longer holds; see 0C.
The live risk is narrower and sharper: `currentMonitorId` backstops
`resolveWindowMonitor()`, which throws rather than guessing, so deleting it turns any
unresolved monitor into a failed `window.create` instead of a misplaced one. That is the
correct direction (a window placed by guess is worse than one that fails to open) but it is a
runtime behavior change, and the paths that would hit it are exactly the concurrent-turn ones
that are hard to reach from a unit test. If 0C stalls the program continues: Phases 1–3 do not
depend on it, and the fallback's blast radius already shrank when 0A made delivery explicit.

### Cleanup ordering regressions

`LiveSession.cleanup()` currently detaches listeners, cancels pending waits, flushes logs, tears down the pool, clears subscriptions, and clears window state. Preserve this order in one orchestration method even after ownership moves. Services may expose `dispose()`, but `LiveSession` decides the order.

### Over-abstraction

Do not introduce interfaces merely because a class moved to another file. Extract when a component has its own state/invariants or can be tested through a narrow contract. Keep simple helpers as functions.

### Protocol manifest drift

Do not modularize app protocol descriptor maps with spreads under the existing extractor — invariant 7 forbids it. The fix (a compiler-recognized manifest contract) is [`app_protocol_manifest_proposal.md`](./app_protocol_manifest_proposal.md); until it lands, handler bodies may move but descriptor objects stay literal.

## Recommendation

Approve Phases 0–2 as the runtime architecture program, with Phase 0A as the first implementation target: it is the cheapest phase, it fixes a verified correctness bug (cross-session app-protocol answers and cross-session window-state/budget pollution, both reproducible on master today), and the envelope machinery it needs is already half-built in `emitter-channels.ts`. Phase 1 starts as soon as 0A and 0B land; 0C proceeds in parallel and gates nothing. Phase 3 is useful cleanup to pick up opportunistically. The app protocol manifest contract is a separate, demand-driven proposal.

The desired end state is not “small files.” It is explicit ownership:

- one session owns every user-visible event;
- one aggregate controls session lifecycle;
- each processor owns one task role;
- public APIs remain stable while internals become independently testable.
