# Proposal: Runtime Decomposition and Session-Scoped Event Routing

**Status:** Draft
**Scope:** `packages/server`, `packages/frontend`, `packages/compiler`, and app protocol authoring
**Primary objective:** remove process-global session fan-out and split the remaining large runtime coordinators without changing YAAR's public protocols or application behavior

## Summary

YAAR's package-level architecture is healthy: shared wire contracts are centralized, server business logic is moving behind `features/` and URI handlers, agent execution already uses processors and policies, and the frontend store is slice-based.

The remaining headroom is concentrated in a few runtime coordinators:

- `ActionEmitter` combines process-wide delivery, ambient identity, four request/response brokers, permissions, prompts, and app readiness.
- Every `LiveSession` subscribes separately to that process-global emitter.
- `LiveSession` owns connection lifecycle, routing, monitors, snapshots, app protocol, user interaction handling, and browser cleanup.
- `ContextPool` has monitor/app processors, but still implements session-agent turns and window/app event coordination directly.
- App `protocol.ts` files cannot be freely decomposed because the compiler discovers their manifest from one literal `app.register({ ... })` expression.
- A few internal modules (`handlers/apps.ts`, `config.ts`, `iframe-bridge.ts`, and the `@bundled/yaar` shim) contain several independently testable domains behind one file.

This proposal addresses those in dependency order. The first phase is not cosmetic: session-addressed event delivery is a correctness boundary that the later extractions should build on.

## Current evidence

### Static structure

| Module | Approximate size | Responsibilities currently combined |
|---|---:|---|
| `session/live-session.ts` | 1,044 lines | session lifecycle, client routing, monitors, snapshots, app protocol, interactions, cleanup |
| `session/action-emitter.ts` | 809 lines | event dispatch, ambient identity, feedback, dialogs, prompts, permissions, app RPC/readiness |
| `agents/context-pool.ts` | 878 lines | pool lifecycle, session tasks, routing, subscriptions, event rate limits, reset/cleanup |
| `agents/agent-pool.ts` | 684 lines | monitor/app/session/ephemeral agent lifecycle and lookup |
| `frontend/store/iframe-bridge.ts` | 563 lines | iframe lookup, capture, app RPC, subscriptions, drag state, SDK requests, notifications |
| `compiler/shims/yaar.ts` | 665 lines | verb client, app storage, app DB, dialogs, UI helpers, reactive persistence |

App protocol declarations total roughly 5,676 lines. The largest are `devtools` (963), `image-edit` (554), `slides-lite` (519), and `video-editor-lite` (380).

### Session fan-out

`SessionEmitterBridge` adds one listener per live session for `action`, `app-protocol`, `bridge-event`, and each session-scoped forwarding channel. Creating eleven retained sessions in `packages/tests/src/integration/websocket-session.test.ts` produces `MaxListenersExceededWarning` for those channels. The assertions still pass, so this is not evidence of a failed cleanup path by itself; it is evidence that listener count grows with session count.

There is also a stronger static correctness finding:

- `ActionEvent` has an optional `sessionId`, but `emitAction()` does not populate it from `AgentContext` by default.
- `SessionEmitterBridge` forwards every `action` event to every `LiveSession`; `LiveSession.handleEmittedAction()` does not filter by session.
- `AppProtocolRequestData` has no `sessionId` at all.
- `emitAppProtocolRequest()` reads the current session for its pending entry, then emits a process-global `app-protocol` request without that session.
- Every `LiveSession` therefore relays the request to its frontend. Two sessions with the same monitor/window key can observe and answer the same request ID; the first answer wins the global pending entry.

`bridge-event` is intentionally global because one real-browser bridge may be relevant to more than one session. Action and app-protocol delivery are not intentionally global.

### Validation baseline

At the time of this proposal:

- `bun run typecheck` passes for every workspace package.
- `bun run test` passes for every workspace package.
- The targeted WebSocket session integration test passes with the listener warnings described above.

This green baseline is the compatibility gate for each phase below.

## Goals

1. Make every frontend-directed action and app-protocol request belong to exactly one session.
2. Keep process-global subscriptions constant as the number of live sessions grows.
3. Keep `LiveSession` as the session aggregate root while moving independently testable policies out of it.
4. Finish the processor pattern in `ContextPool` without hiding role-specific agent semantics behind a generic framework.
5. Let app protocol handler implementations be organized by domain without losing compiler-visible manifest entries.
6. Preserve existing public imports, wire event shapes during migration, and app behavior unless a phase explicitly introduces a versioned contract.

## Non-goals

- Replacing `EventEmitter` everywhere.
- Rewriting the agent pool or provider implementations.
- Splitting files solely to satisfy a line-count target.
- Moving `shared/actions.ts` or `shared/events.ts` into many small files; they are authoritative discriminated contracts and benefit from central review.
- Introducing a base class or framework for app entry points. Their similarity is mostly convention, while their runtime needs differ substantially.
- Changing monitor, window, or agent identity semantics.
- Combining MIME tables whose extension sets represent different capabilities merely because they overlap.

## Required invariants

1. A frontend-directed event is delivered to one `SessionId`, unless its type is explicitly declared global.
2. A window action always carries or resolves a monitor; this proposal does not reintroduce monitor `0` fallbacks.
3. Server-to-client waits remain answerable over the socket that is holding them. Existing loopback coverage remains mandatory.
4. `LiveSession.broadcast()` remains the only server-to-frontend gateway because it enforces monitor routing and surface tracking.
5. Session cleanup settles all pending waits as cancelled and detaches every session-owned resource.
6. Agent roles remain explicit (`session`, `monitor`, `app`, `ephemeral`); shared lifecycle primitives may be deduplicated, but role behavior does not become data-driven magic.
7. Static and runtime app protocol manifests must agree. A refactor must never create a command that works at runtime but is invisible to an agent.

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

### 0.1 Make delivery envelopes honest

Change frontend-directed emitter payloads so they name their destination:

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

`emitAction()` and `emitAppProtocolRequest()` resolve `sessionId` from the explicit argument or `AgentContext`. If neither exists, a frontend-directed call fails loudly instead of being broadcast to an arbitrary/default session.

Some actions originate outside an agent turn. Those call sites already know their target session or use a session-scoped channel; make that target explicit rather than consulting `SessionHub.getDefault()`.

Keep `BridgeEvent` explicitly global. If another global event is added later, it must opt into a separate global envelope rather than making `sessionId` optional again.

### 0.2 Install one process-level router

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

### 0.3 Remove process-global ambient identity

`ActionEmitter.currentAgentId` and `currentMonitorId` are mutable fallbacks around provider turns. Concurrent provider turns can overwrite one another, even though `AsyncLocalStorage` is exact for ordinary in-process work.

Preferred order:

1. Ensure provider MCP calls carry the server-minted agent token wherever the provider permits it.
2. Resolve agent/session/monitor from that token at the MCP boundary.
3. For a provider that cannot attach identity, bind identity to that provider connection or turn object, not to a process-global singleton.
4. Delete `setCurrentAgent`, `clearCurrentAgent`, `setCurrentMonitor`, and `clearCurrentMonitor` after all call sites migrate.

Do not replace this with another global map keyed only by "current turn". Identity must be connection- or async-context-scoped.

### 0.4 Split the `ActionEmitter` façade internally

Retain the exported `actionEmitter` façade temporarily so fifty-plus call sites do not change in one commit, but delegate to:

- `ActionDispatcher`: stamps and emits OS actions.
- `InteractionBroker`: rendering feedback, confirmation dialogs, permission decisions, and user prompts.
- `AppProtocolBroker`: app readiness and app query/command request-response lifecycle.
- Existing `PendingStore`: remains the common typed deadline/cancellation primitive.

Permission persistence belongs with the permission/dialog service, not in the low-level event dispatcher.

### Phase 0 acceptance tests

- Two live sessions with the same window key: an app query reaches only its originating session.
- A response from the non-originating session cannot resolve the pending request.
- An action emitted in session A changes only session A's `WindowStateRegistry` and subscriptions.
- Creating twenty live sessions keeps process-global listener counts constant.
- Two concurrent provider turns retain distinct agent, monitor, and session identity.
- Cleanup cancels only the departing session's waits and leaves the other session's waits intact.
- Existing loopback answerability and late-reply tests remain green.

## Phase 1: thin `LiveSession` without weakening ownership

`LiveSession` remains the owner of its connections, `WindowStateRegistry`, layout, reload cache, context pool, logger, and cleanup order. It delegates four coherent policies.

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

## Phase 3: a compiler-supported app protocol contract

### Problem

The compiler currently searches source text for `.register({`, then extracts literal `state`, `commands`, and `events` blocks. Spreads, computed keys, and imported descriptor maps can work at runtime but disappear from the static manifest. That forces large protocol declarations to remain visibly monolithic.

Moving handler bodies into imported functions is safe today, but moving descriptor objects is not generally safe.

### Proposed contract

Introduce a compiler-recognized, typed manifest declaration separate from runtime binding:

```ts
export const manifest = defineProtocolManifest({
  appId: 'devtools',
  state: {
    project: { description: 'Active project', schema: projectSchema },
  },
  commands: {
    readFile: { description: 'Read files', params: readFileParams },
  },
});

app.register(bindProtocol(manifest, {
  state: projectStateHandlers,
  commands: fileCommandHandlers,
}));
```

The exact runtime API may differ, but it must provide:

- one statically extractable manifest;
- handler keys checked against manifest keys;
- no handler without a manifest entry;
- no manifest entry without a handler, unless explicitly declared read-only/generated;
- runtime/static manifest parity diagnostics.

### Compiler implementation options

Preferred: parse `defineProtocolManifest()` with the TypeScript AST already available to compiler guards. This supports imported literal schemas only if the compiler deliberately resolves them; start with same-file literals and make unsupported constructs a build error rather than a best-effort warning.

Alternative: execute a build-time manifest-only module in a restricted evaluator. This is more flexible but expands the trusted build surface and should not be the first choice.

Do not silently continue with a partial manifest. The current diagnostic mechanism should become a hard compile failure for deployed apps once migration is complete.

### Migration order

1. Add the new contract and parity tests.
2. Migrate `devtools` as the stress case.
3. Migrate `image-edit`, `slides-lite`, and `video-editor-lite`.
4. Provide a compatibility path for literal `app.register()` apps.
5. Deprecate best-effort regex extraction only after all bundled apps migrate.

### Phase 3 acceptance tests

- Static and runtime manifests match for every bundled app.
- Spreads/computed keys either resolve deliberately or fail compilation with a location.
- Handler maps cannot omit or invent keys at typecheck time.
- Existing compiled app output and app-agent descriptions remain equivalent.

## Phase 4: bounded internal module splits

These extractions have lower architectural risk and can proceed independently after the session boundary is fixed.

### 4.1 App URI handlers

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

### 4.2 Server configuration

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

### 4.3 Frontend iframe bridge

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

### 4.4 `@bundled/yaar` SDK internals

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

### Phase 0

- `packages/server/src/session/emitter-channels.ts`
- `packages/server/src/session/action-emitter.ts`
- `packages/server/src/session/session-emitter-bridge.ts` (replaced or reduced)
- `packages/server/src/session/live-session.ts`
- `packages/server/src/session/session-hub.ts`
- `packages/server/src/agents/agent-context.ts`
- `packages/server/src/providers/claude/session-provider.ts`
- `packages/server/src/providers/codex/provider.ts`
- `packages/server/src/mcp/server.ts`
- new session routing/broker modules and cross-session tests

### Phase 1

- `packages/server/src/session/live-session.ts`
- `packages/server/src/session/client-event-router.ts`
- new monitor, snapshot, client-event, and app-window modules

### Phase 2

- `packages/server/src/agents/context-pool.ts`
- `packages/server/src/agents/pool-types.ts`
- `packages/server/src/agents/app-task-processor.ts`
- new session-task and window-event modules

### Phase 3

- `packages/compiler/src/extract-protocol.ts`
- `packages/compiler/src/shims/yaar.ts`
- `packages/compiler/src/bundled-types/index.d.ts`
- protocol compiler tests
- bundled app `protocol.ts` files, beginning with `apps/devtools`

### Phase 4

- `packages/server/src/handlers/apps.ts`
- `packages/server/src/config.ts`
- `packages/frontend/src/store/iframe-bridge.ts`
- `packages/compiler/src/shims/yaar.ts`

## Delivery plan

| Phase | Outcome | Merge gate |
|---|---|---|
| 0A | Session IDs required on action and app-RPC envelopes | new two-session isolation tests |
| 0B | One session event router; constant global listener count | listener-count and cleanup tests |
| 0C | Broker split and removal of global current identity | concurrent-turn identity tests |
| 1 | Thin `LiveSession` | snapshot, reconnect, monitor, and loopback suites |
| 2 | Session processor and window event coordinator | agent pool and multi-monitor suites |
| 3 | Typed protocol manifest contract | static/runtime parity across bundled apps |
| 4 | Handler/config/frontend/SDK internal splits | package-local tests plus full workspace gate |

Each row should be independently mergeable. Avoid one repository-wide relocation commit: it would mix behavior fixes with import churn and make review of the session boundary unnecessarily difficult.

## Risks and mitigations

### Duplicate delivery during migration

Running the old per-session bridge and the new router simultaneously can send an action twice. Put delivery behind one feature seam and switch ownership atomically per channel. Add a request/action ID assertion in tests where possible.

### Events emitted without a session

Making `sessionId` required will expose timer, HTTP, warm-up, and test call sites that depended on defaults. Treat that as useful migration evidence. Session-scoped UI work must take a session explicitly; truly global work must use a distinct global channel.

### Cleanup ordering regressions

`LiveSession.cleanup()` currently detaches listeners, cancels pending waits, flushes logs, tears down the pool, clears subscriptions, and clears window state. Preserve this order in one orchestration method even after ownership moves. Services may expose `dispose()`, but `LiveSession` decides the order.

### Over-abstraction

Do not introduce interfaces merely because a class moved to another file. Extract when a component has its own state/invariants or can be tested through a narrow contract. Keep simple helpers as functions.

### Protocol manifest drift

Do not modularize descriptor maps with spreads under the existing extractor. Land the compiler contract first, migrate one complex app, and require parity before expanding.

## Recommendation

Approve Phases 0–2 as the runtime architecture program, with Phase 0A as the first implementation target. Treat Phase 3 as a compiler/DX project that unlocks safe app-level decomposition. Phase 4 is useful cleanup but should not displace the session-routing work.

The desired end state is not “small files.” It is explicit ownership:

- one session owns every user-visible event;
- one aggregate controls session lifecycle;
- each processor owns one task role;
- app manifests are statically authoritative while handlers remain modular;
- public APIs remain stable while internals become independently testable.
