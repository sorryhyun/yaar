# Proposal: Runtime Decomposition and Session-Scoped Event Routing

**Status:** In progress. **0A, 0B, and Phase 1 have landed and have been removed from this
document** — see "Already landed" for where that work is now documented. What remains is 0C
(open; its original premise turned out to be stale), Phase 2 (unblocked), and Phase 3
(opportunistic). Revised 2026-07-19.
**Scope:** `packages/server`, `packages/frontend`, and the `@bundled/yaar` shim in `packages/compiler`
**Primary objective:** split the remaining large runtime coordinators without changing YAAR's public protocols or application behavior

## Summary

YAAR's package-level architecture is healthy: shared wire contracts are centralized, server business logic is moving behind `features/` and URI handlers, agent execution already uses processors and policies, and the frontend store is slice-based.

The remaining headroom is concentrated in a few runtime coordinators:

- `ActionEmitter` still combines ambient identity with four request/response brokers, permissions, prompts, and app readiness.
- `ContextPool` has monitor/app processors, but still implements session-agent turns and window/app event coordination directly.
- A few internal modules (`handlers/apps.ts`, `config.ts`, `iframe-bridge.ts`, and the `@bundled/yaar` shim) contain several independently testable domains behind one file.

A related constraint that used to be Phase 3 here — app `protocol.ts` files cannot be freely decomposed because the compiler discovers their manifest from one literal `app.register({ ... })` expression — is a compiler/DX project with its own risk profile and demand curve. It now lives in [`app_protocol_manifest_proposal.md`](./app_protocol_manifest_proposal.md); this proposal only carries the invariant it protects (see Required invariants).

## Already landed

The plans for these are gone from this document; the reasoning that outlived them lives in
the code, which is where it binds:

| Phase | Outcome | Where the reasoning now lives |
|---|---|---|
| 0A | Every frontend-directed action and app-RPC request names its destination session; an unaddressable emit drops loudly and its waiting variants settle as `cancelled` | `session/emitter-channels.ts`, `session/action-emitter.ts` |
| 0B | One process-wide subscription per channel, replacing per-session fan-out; `detach()` checks sink identity because a session id is reused across reconnects | `session/session-event-router.ts` |
| 1 | `LiveSession` delegates four policies (`MonitorRegistry`, `ClientEventController`, `SessionSnapshotService`, `AppWindowCoordinator`) while remaining the aggregate root | `session/live-session.ts` and the four modules beside it; `packages/server/CLAUDE.md` |

Their acceptance tests are `tests/session-isolation.test.ts`, `tests/session-event-router.test.ts`,
and the loopback suite. Note that the loopback tripwire
(`tests/loopback/loopback-answer-waits.test.ts`) works by *scanning source text* for frames
that resolve waits: a future phase that moves a frame handler to a new file must add that file
to its `ANSWERING_SOURCES` list, and the test's count guard is what will say so.

## Current evidence

### Static structure

| Module | Approximate size | Responsibilities currently combined |
|---|---:|---|
| `session/action-emitter.ts` | 809 lines | ambient identity, feedback, dialogs, prompts, permissions, app RPC/readiness |
| `agents/context-pool.ts` | 878 lines | pool lifecycle, session tasks, routing, subscriptions, event rate limits, reset/cleanup |
| `agents/agent-pool.ts` | 684 lines | monitor/app/session/ephemeral agent lifecycle and lookup |
| `frontend/store/iframe-bridge.ts` | 563 lines | iframe lookup, capture, app RPC, subscriptions, drag state, SDK requests, notifications |
| `compiler/shims/yaar.ts` | 696 lines | verb client, app storage, app DB, dialogs, UI helpers, reactive persistence |

`session/live-session.ts` was on this list at 1,044 lines and is now 605, with its four
extracted policies beside it. See "Already landed".

### Validation baseline

At the time of this revision:

- `bun run typecheck` passes for every workspace package.
- `bun run test` passes for every workspace package.

This green baseline is the compatibility gate for each phase below.

## Goals

1. Finish the processor pattern in `ContextPool` without hiding role-specific agent semantics behind a generic framework.
2. Bind agent/monitor identity to a connection or async context rather than a process-global singleton.
3. Preserve existing public imports, wire event shapes during migration, and app behavior unless a phase explicitly introduces a versioned contract.

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

## Phase 0C: remove process-global ambient identity

The other two steps of Phase 0 have landed. 0C is the step most likely to stall on provider
capabilities, and it gates nothing: Phases 2 and 3 do not depend on it.

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

### Phase 0C acceptance test

- Two concurrent provider turns retain distinct agent, monitor, and session identity.

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

### Phase 0C

- `packages/server/src/providers/claude/session-provider.ts`
- `packages/server/src/providers/codex/provider.ts`
- `packages/server/src/mcp/server.ts`
- `packages/server/src/session/session-hub.ts`, `agents/agent-context.ts`

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
| 0C | Broker split and removal of global current identity | concurrent-turn identity tests | open — premise revised |
| 2 | Session processor and window event coordinator | agent pool and multi-monitor suites | open |
| 3 | Handler/config/frontend/SDK internal splits | package-local tests plus full workspace gate | opportunistic |

Each row should be independently mergeable. Avoid one repository-wide relocation commit: it would mix behavior fixes with import churn and make review unnecessarily difficult.

## Risks and mitigations

### 0C removes a fallback that is load-bearing at runtime

The original risk here — that Codex cannot attach per-call identity — no longer holds; see 0C.
The live risk is narrower and sharper: `currentMonitorId` backstops
`resolveWindowMonitor()`, which throws rather than guessing, so deleting it turns any
unresolved monitor into a failed `window.create` instead of a misplaced one. That is the
correct direction (a window placed by guess is worse than one that fails to open) but it is a
runtime behavior change, and the paths that would hit it are exactly the concurrent-turn ones
that are hard to reach from a unit test. If 0C stalls the program continues: Phases 2 and 3 do
not depend on it, and the fallback's blast radius already shrank when 0A made delivery explicit.

### Cleanup ordering regressions

`LiveSession.cleanup()` currently detaches listeners, cancels pending waits, flushes logs, tears down the pool, clears subscriptions, and clears window state. Preserve this order in one orchestration method even after ownership moves. Services may expose `dispose()`, but `LiveSession` decides the order.

### Over-abstraction

Do not introduce interfaces merely because a class moved to another file. Extract when a component has its own state/invariants or can be tested through a narrow contract. Keep simple helpers as functions.

### Protocol manifest drift

Do not modularize app protocol descriptor maps with spreads under the existing extractor — invariant 7 forbids it. The fix (a compiler-recognized manifest contract) is [`app_protocol_manifest_proposal.md`](./app_protocol_manifest_proposal.md); until it lands, handler bodies may move but descriptor objects stay literal.

## Recommendation

The session boundary is fixed and `LiveSession` is decomposed, so the remaining work is no longer gated on anything. Phase 2 is the substantive next target: it finishes the processor pattern in `ContextPool`, and its risk is well-understood because monitor and app turns already run through the same seam. 0C proceeds in parallel and gates nothing — it is blocked on validation against a live Codex session, not on design. Phase 3 is useful cleanup to pick up opportunistically as those files are touched. The app protocol manifest contract is a separate, demand-driven proposal.

The desired end state is not “small files.” It is explicit ownership:

- one session owns every user-visible event;
- one aggregate controls session lifecycle;
- each processor owns one task role;
- public APIs remain stable while internals become independently testable.
