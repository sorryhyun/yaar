# Proposal: session & agent-orchestration maintainability

**Responds to:** the 2026-08-06 three-track audit of `src/session/`, `src/agents/`, and the
cross-cutting session flows (connect/restore/teardown, `handlers/window.ts`, event fan-out).
**Scope:** `packages/server/src` — session layer, ContextPool/AgentPool orchestration, restore
paths. No wire-format or behavior changes.

**Phase 0 (four bug fixes) landed 2026-08-06** and has been removed from this document; the
code and its regression tests are the record. One piece of it was deliberately deferred and
survives here as Phase 2.8.

The audit's overall verdict: the architecture is healthier than its file sizes suggest — the
existing extractions (`ClientEventController`'s total routing table, `SessionEventRouter`,
`context-pool-policies/`, the single `LiveSession.broadcast()` egress) are pulling weight.
The debt is concentrated: two god objects that stopped halfway through decomposition
(`ActionEmitter`, `agent-pool.ts`), duplicated reducers/encodings that have **already
drifted**, and a leaky `ContextPool` facade. Phases are ordered so each shrinks the blast
radius of the next.

**Phase 1 (dead surface & drift-prone encodings) landed 2026-08-06** and has been removed
from this document; the code is the record. Three notes worth carrying forward:

- Deleting `ContextPool.hasActiveAgent` left `AgentPool.hasRolePrefix` with no callers, so
  it went too. `appRolePrefix()` now lives in `agents/roles.ts` beside the other role
  minters rather than in `app-task-processor.ts` as proposed — one home for every role
  string, with `appProcessingKey()` (a queue key, not a role) staying behind.
- `agents/roles.ts` also took `principalRole` off `agent-context.ts`, so the prefixes and
  the access tier they decide sit in one file.
- `turnOptionsFor()` was applied to the fourth site as well
  (`features/agents/session-actions.ts`), which fixes the unconditional-`allowedTools`-on-
  Codex divergence Phase 4.5 records. That is the one behavior change in the phase.

## Phase 2 — seams & honest contracts (a day or two each)

1. **One `stampWindowHandle()`.** Three implementations of "stamp the scoped handle before
   broadcast": `tool-action-bridge.ts:16` (agent path), `live-session.ts:323`/`:368`
   (iframe/HTTP — the only copy with the create/close pre-vs-post resolve asymmetry from the
   `0/preview`-vs-`1/preview` incident), `live-session.ts:496` (launch hooks). Extract one
   helper beside `window-handle-map.ts` taking `{handleMap, monitorId, requestId?, phase}`;
   the ordering rule gets one home and one test. Best value-to-cost in the session layer.

2. **Complete-or-drop the `ContextPool` facade.** ~20 one-line delegators coexist with a
   public `readonly agentPool` that seven modules use to bypass them — a reader cannot tell
   which is the intended door. **Recommendation: drop the delegators** (they enforce
   nothing), keep only names that add meaning (`getPrimaryAgent`, `listAgents`).

3. **Narrow `PoolContext`** (`pool-types.ts:108`). Every task processor currently receives
   the entire pool (agentPool, tape, windowState, all six policies, mutable
   `savedThreadIds`), so none is independently reasonable. Split into a small `TurnContext`
   (sendEvent, contextTape, contextAssembly, reloadPolicy, windowState, providerType,
   sharedLogger) plus per-processor extras. Mechanical, type-checked; do after Phase 1
   shrinks the surface.

4. **Make task routing honest.** `Task.type: 'monitor' | 'app' | 'session'` is not the
   routing key: `handleTask` (`context-pool.ts:440`) routes by windowId→appId lookup (a
   plain-window `'app'` task silently becomes a monitor task) and `'session'` never reaches
   it. `MonitorTaskProcessor:109` routes by sniffing `messageId` prefixes (`relay-`,
   `hook-resp-`) minted in three unrelated files.
   **Fix:** add `kind: 'user' | 'relay' | 'hook' | 'notify'` to `Task`, delete the prefix
   sniffing; rename `Task.type` → `requestedType` or drop `'session'` from the union; add
   one producer-enumeration diagram (7 producers × 4 executors × 3 gates) atop
   `context-pool.ts` — the cheapest comprehension win the audit found.

5. **Bound the app-window queues.** `AppTaskProcessor` enqueues with no `canEnqueue()`
   (`app-task-processor.ts:105`); `WindowQueuePolicy` has no `maxQueueSize` — contrast the
   monitor path's `enqueueOrReject` + `MESSAGE_QUEUE_FULL`. A wedged app agent accumulates
   tasks without bound or feedback. Give the window queue a bound routed through the same
   refusal shape — **preserving both refusal wordings** (`monitor-task-processor.ts:49-57`
   documents the rejected consolidation).

6. **One owner for logger-mint and `CONNECTION_STATUS`.**
   `ProviderLifecycleManager.initialize` duplicates both from `ContextPool.initialize`; the
   duplicate emits `CONNECTION_STATUS` with no `sessionId` — the exact hazard
   `context-pool.ts:743` documents. Strip it to provider acquire/attach only; then inline
   the manager back into `AgentSession` (its 47 remaining lines cost a 30-line getter/setter
   proxy and an eslint-disable; `setProvider` is already gone, and once this strips
   `initialize`, nothing of substance remains).

7. **Budget-slot placement.** `MonitorBudgetPolicy` slots are acquired at `queueMonitorTask`
   and held across a whole queue drain, but `ContextPool.resumeMonitor` (`context-pool.ts:339`)
   enters the same drain slot-less — "one background monitor slot" means different things by
   entry path. Move acquire/release to wrap `processMonitorTask` (what actually consumes a
   provider). Read `tests/monitor-budget-policy.test.ts` first.

8. **One window reducer.** Carried forward from the landed Phase 0: `getWindowRestoreActions`
   (`logging/window-restore.ts`) is now exhaustive over `window.*`, so it can no longer
   *silently* lack a case — but it is still a second hand-written reducer beside
   `WindowStateRegistry.handleAction`, free to disagree about what a case means. Replace it
   with a throwaway `WindowStateRegistry` fed the same JSONL entries, deriving final actions
   via the win→action mapping `SessionSnapshotService.windowActions()` already owns
   (`session/session-snapshot-service.ts:50`) — extracted to a pure function both can call.
   Collapses three parallel reducers to one source of truth. Requires threading an explicit
   `monitorId` instead of the ambient `getMonitorId()` lookup (restore has no ambient
   context); bounded to one file plus that extraction.

## Phase 3 — the two big splits (do last; Phases 1–2 shrink them first)

1. **Split `ActionEmitter`** (1003 lines, 11 fields, nine responsibilities, five methods
   repeating the same resolve-session → mint-id → `PendingStore.create` → emit → map-outcome
   prelude). Extract, keeping the singleton's public surface byte-identical as a facade:
   - `session/desktop-request.ts` — the ask-the-desktop-and-wait prelude (dialogs, prompts,
     clipboard, app-protocol requests share it).
   - `session/app-ready-registry.ts` — `readyWindows` + notify/is/forget/wait. Per-(session,
     window) state, not an emitter concern.
   - `session/interrupt-gate.ts` — `interruptedAgents` (two external mutators in
     `agent-session.ts`).
   **Trap:** `tests/loopback/loopback-answer-waits.test.ts:373` greps *source text* for
   `/actionEmitter\.(resolve[A-Z]\w*|notifyAppReady)\s*\(/` — the regex must move with the
   extraction or the loopback wait-coverage assertion silently stops covering it.
   While here (cheap riders): the 9-positional-arg dialog API → options object
   (`install.ts:118` already passes `undefined, // default deadline`); document or rename
   the `WindowState.appProtocol` ("has ever registered") vs `readyWindows` ("currently
   registered") split at `window-state.ts:588`.

2. **Split `agent-pool.ts`** (1288 lines) along three seams:
   - **A:** sub-agent tier (lines ~755–978 + types at ~186–258) → `agents/sub-agent-registry.ts`;
     touches only `createAgentCore`, `disposeAgent`, `acquireProvider` — inject those three.
   - **B:** `buildAgentTree` + `AgentEntry`/`AgentTreeNode` (~100–184, already pure) +
     `listAgents` → `agents/agent-roster.ts`.
   - **C:** the reserve-before-first-await / join-in-flight / settle-before-sweep pattern,
     implemented twice (`appAgentSpawns` `:305,636-659,722-727`; `subAgentSpawns`
     `:326,777-807,867-872`) → one `SpawnReservations<T>`. **Do not** alter the semantics —
     the comments at `:291-305` and `:757-776` record a real leak class (agent in no
     collection holding a `MAX_AGENTS` slot forever); the settle calls in every dispose path
     must survive the move. Rider: `settlePersonaSpawns` → `settleSubAgentSpawns` (internal
     symmetry; the wire-facing persona vocabulary is untouched).

3. **Retire `currentMonitorId`** (`action-emitter.ts:187`) — the only cross-session mutable
   global in the layer, last-writer-wins across concurrent turns. Its justification ("Codex
   cannot stamp identity onto MCP requests", `:252-256`) is contradicted in writing by
   `mcp/server.ts:242-244`, and it undercuts `resolveWindowMonitor`'s own "never place a
   window by guess" invariant. **Measure first:** warn when the fallback actually fires, run
   a week, then delete the field and the four provider call sites
   (`claude/session-provider.ts:292,303`, `codex/provider.ts:189,283`). Caveat before
   deleting: `hub.findMonitorForAgent` returns `undefined` for agents outside an
   `AgentPool` (sub-agents, ephemeral).

## Phase 4 — agent pool system (deep lifecycle audit, 2026-08-06)

A dedicated trace of create → run → interrupt → dispose per tier (session, monitor, app,
sub-agent, ephemeral), limiter accounting, warm pool, and interrupt propagation. The limiter
bugs are the most urgent thing left in this document — process-global, permanent for the
life of the process, and invisible from `/api/agents/stats`. They land here rather than
first only because the fixes share one structural move (4.1).

### 4.1 — Limiter accounting: route everything through the dispose chokepoint

The global `MAX_AGENTS` count can drift in **both directions**, permanently, per process:

- **Up (slots leak):** `AgentPool.cleanup()` (`agent-pool.ts:1272-1275`) runs
  `await agent.session.cleanup(); limiter.release()` per agent with **no `try/finally`** —
  the first throwing agent leaks its slot and every subsequent agent's, `ContextPool.teardown`
  swallows the throw (`context-pool.ts:680-684`), collections never clear, hub agent-ids stay
  registered, providers stay alive. **A passing test certifies this bug**:
  `tests/agent-cleanup.test.ts:245-252` asserts `mockRelease` is called 0 times under a
  comment that literally reads `// BUG: …`.
- **Down (over-admission):** two fire-and-forget dispose paths
  (`monitor-registry.ts:127` unawaited `removeMonitorAgent`;
  `window-event-coordinator.ts:164` `.catch()`-ed `disposeSubAgentsForApp`) can dispose an
  agent already snapshotted by `cleanup()`'s `allAgents()` — `disposeAgent` releases, then
  cleanup Phase 2 releases the same agent again; `AgentLimiter.release()` only guards at
  zero (`limiter.ts:111`), so the count under-runs while agents are live and the process
  admits past `MAX_AGENTS`.
- **Exception door open at create:** `createAgentCore` (`agent-pool.ts:487-526`) does
  `tryAcquire()` then `await session.initialize(...)` with no try/finally — a throw (e.g. fs
  `mkdir` in `createSession`) holds the slot **and** the provider process forever, skipping
  every caller's `if (provider) dispose()` compensation. The spawn reservations closed the
  concurrency door (`:291-305`); the exception door is still open. Same shape:
  `warm-pool.ts:226-231`'s on-demand branch can throw `CodexVersionError` out of `acquire()`
  and no pool call site is in a `try`.

**Fix (one move):** `disposeAgent` (`:462-479`) is already the correct chokepoint
(try/finally, `retiredUsage` fold, untrack, notify). Route `cleanup()` through it per agent
instead of hand-rolling; make dispose idempotent per agent id so the fire-and-forget paths
can't double-release (guard by map delete, as the app/sub-agent disposers already do —
`disposeEphemeral` at `:562-565` is the one sibling missing the guard); wrap
`createAgentCore`'s body in try/finally releasing on any non-success exit. Then flip the
`agent-cleanup.test.ts` assertions from certifying the leak to pinning the fix.

### 4.2 — Agent identity: `instanceId` collides across pools

`agent-${this.nextAgentId++}-${Date.now()}` (`agent-pool.ts:494-495`) — per-pool counter
from 0, ms timestamp, no entropy. Two sessions creating their first agent in the same ms
collide: `SessionHub.registerAgent` silently overwrites (misrouted `findSessionByAgent`),
`actionEmitter.interruptedAgents` is process-global so one session's stop gates the other's
actions, and `getAgentToken` hands both the same MCP token. `lib/ids.ts:genId` (used for
the *fallback* id at `agent-session.ts:124`) already has entropy — use it here too.

### 4.3 — Credential and shutdown hygiene

- **`revokeAgentToken` is dead** (`mcp/agent-tokens.ts:41`): exported, documented, called
  from nowhere. Token maps grow for the process's life and a disposed agent's
  `X-Agent-Token` stays resolvable — currently fails closed only because
  `findRoleForAgent` returns `undefined` downstream. Call it from `disposeAgent`.
- **Shutdown never drains sessions** (`lifecycle.ts:400-462`): `shutdown()` never touches
  `SessionHub`, so no `LiveSession.cleanup()` runs and `SessionLogger`'s debounced buffer
  (`session-logger.ts:109-213`) is lost on every Ctrl-C — a data-loss finding, not a
  process leak (`process.kill(-pid)` takes the provider group). Add a bounded
  best-effort hub drain before `server.stop()`.
- **Provider switch tears down the warm pool under live agents**
  (`features/config/settings.ts:50-53` vs `http/routes/settings.ts:59-63`): two independent
  implementations with *different* change detection; `warmPool.cleanup()` stops the shared
  Codex `AppServer` while live agents' clients still point at it, and
  `ContextPool.providerType` never updates. That last part is the desync the client-side
  `SET_PROVIDER` switch was deleted for — this is the **other** door onto it, and it is
  still open. Consolidate to one implementation; either refuse the switch while agents are
  live or reset sessions through `ContextPool`.
- **Unguarded interrupt kills idle sub-agent processes**
  (`handlers/apps/agents-resource.ts:267`): every other interrupt door checks
  `isRunning()` first (`agent-pool.ts:1125`, `handlers/agents.ts:177`); this one doesn't,
  and an idle interrupt takes `closePersistentSession()`
  (`claude/session-provider.ts:610-613`) — the exact cost `interruptAll`'s doc says the
  skip avoids — plus leaves a stale `markInterrupted` until the next turn. Copy the guard.

### 4.4 — App-agent accumulation vs `MAX_AGENTS` (the load-bearing gap)

App agents are reclaimed only by `fresh:true`, monitor removal, explicit `delete`, or
session teardown — never window close, never idle. Eight apps opened once permanently hold
8 of 10 global slots; the ninth app and every other session then get "Agent limit reached."
`PooledAgent.idleTimer` is always `null` and `lastUsed` is written-never-read
(`agent-pool.ts:75-77`) — the struct advertises an idle-reaper that does not exist, on the
one tier that needs it. **Implement the idle reaper** (timer-based `disposeAppAgent` after
N minutes idle, reset on task). This supersedes `multi_window_apps_proposal.md`'s "idle
reaping — follow-up, not required for v1": with a global limit of 10, it is now the
load-bearing gap, not a nicety.

### 4.5 — Structural (fold into Phases 1–3 where they overlap)

- **Half of `AgentLimiter` is dead** (`limiter.ts:75-105`): production only calls
  `tryAcquire()`; the wait queue, timeout machinery, `clearWaiting`, `getWaitingCount` are
  unreachable, and stats report a structurally-zero `waitingCount`. Either delete the queue
  half or adopt it — and note `ContextPool.teardown:659` calls the **global** limiter's
  `clearWaiting`, which would reject *other sessions'* waiters the day anything queues.
  Deleting resolves both.
- **The `acquireProvider` test seam has a hole it documents itself as closing**
  (`agent-pool.ts:365-374`): `createMonitorAgent(id)` with no provider falls through
  `ProviderLifecycleManager` to the module-level `acquireWarmProvider()`, bypassing the
  injected seam — the reason `tests/agent-cleanup.test.ts` needs `mock.module` and its own
  test partition. Thread the pool's `acquireProvider` into `createAgentCore`.
- **A fifth turn runner diverges from the other four**
  (`features/agents/session-actions.ts`): runs session-agent turns outside
  `SessionTaskProcessor` — passes `allowedTools` unconditionally on Codex (`:60`; both
  other sites pass `undefined` and say why), never sets the session-agent monitor while
  hardcoding `source: yaar://monitors/0` (`:56`), skips `MESSAGE_ACCEPTED` and
  reload-cache recording. Route it through `SessionTaskProcessor.process` (Phase 1's
  `turnOptionsFor()` removes the first divergence mechanically).
- **Settle-then-sweep re-entry window on the dispose side** (`agent-pool.ts:712,963,973`;
  widened by `removeMonitorAgent` deleting from `monitorAgents` *after* the app-agent
  sweep, `:617-627`): a spawn beginning during the settle await lands after the sweep,
  orphaned until pool cleanup. Reorder the map delete first; add the missing
  dispose-then-create-race test (`app-agent-fresh.test.ts:362` covers only the reverse).
- **Warm pool goes permanently cold after one failed replenish**
  (`warm-pool.ts:237-257`): replenish only triggers on the *hit* path, so one `null`
  replenish leaves size 0 and every acquisition cold with no retry; and `doInitialize`'s
  early return (`:98-101`) without setting `initialized` re-runs full provider detection
  (Codex: `AppServer` start + OAuth) on every subsequent acquire. Replenish on the
  on-demand path too; latch the no-provider answer with a TTL.
- **Sub-agent turns bypass `inflightCount`** (`agent-pool.ts:924`):
  `ContextPool.teardown` step 4's "no in-flight references" comment (`context-pool.ts:679`)
  is false for this tier — step 5 disposes providers under a live `for await`. Count
  sub-agent turns in `inflightCount` (or a pool-owned equivalent awaited by teardown), then
  the comment becomes true.

### 4.6 — Doc corrections (one-line each)

- `packages/server/CLAUDE.md` pattern table: `AgentLimiter` — "global agent limit with
  queue" → no queue in effect (or delete the queue half first and keep the doc).
- `agent-pool.ts:2-25` header: state that disposal cascades monitor→app→sub-agent but
  window close reclaims only sub-agents, never app agents (readers assume otherwise).
- `context-pool.ts:679` step-5 comment: false until 4.5's inflight fix lands.

### Phase 4 lifecycle map (reference)

| tier | provider acquired by | disposed by | reclaim gaps |
|---|---|---|---|
| session | pool `acquireProvider` | `disposeSessionAgent` (idempotent) | — |
| monitor | **ContextPool supplies** | `removeMonitorAgent` (cascades) | `MonitorRegistry.remove` fires it unawaited |
| app | pool `acquireProvider` | `disposeAppAgent` (idempotent) | never on window close, no idle reap (4.4) |
| sub-agent | pool `acquireProvider` | `disposeSubAgent*` | turn bypasses inflight (4.5); unawaited on last-window-close |
| ephemeral | pool `acquireProvider` | own task's `finally` only | dispose not idempotent (4.1) |

## Non-goals — audited and deliberately left alone

- **`StreamToEventMapper`** (612 lines): its length is the provider union's length; the
  latch state (`blockText`, turn counters) is what makes the ordering correct, and every
  comment block records a measured incident. Do not restructure.
- **`AgentSession.recordUsage`**: each branch is a measured provider behavior
  (`agent-session.ts:205-226`). Do not merge the scope branches.
- **Spawn-reservation semantics** (consolidate the copies, never the rules).
- **`ContextPool.teardown`'s numbered steps**; the 30s race backstop is deliberate.
- **The connect → attach → first-message → teardown chain** (`websocket/server.ts`,
  `SessionHub`, `LiveSession`): hop count is justified, comments carry the invariants
  (init-race, epoch, limiter-slot release). No changes.
- **`SessionEventRouter`, `emitter-channels.ts`, `pending-store.ts`,
  `client-event-router`'s "dead" `if (!handler)`** — each is documented design, not debt.
- **`handlers/window.ts`** (~1000 lines): a thin verb dispatcher over `features/window/*`;
  no overlap with `window-state`/`action-emitter`. At most split the ~120-line
  `invokeSchema` literal into a sibling file (cosmetic; optional).
- **`persona`/`subAgent` naming split** — a documented wire-vocabulary boundary with one
  translation point (`handlers/apps/agents-resource.ts`). Renaming breaks the wire.
- **`BroadcastCenter`'s three publish loops** — distinct predicates, single stringify;
  a predicate-taking helper saves ~20 lines at a closure-per-connection-per-event cost.
- **`MonitorBudgetPolicy`'s six primary-monitor early-returns** — one rule stated where it
  applies (`monitor-budget-policy.ts:193-198`).
- **Comment density** (~1:1 in `live-session.ts`, `window-state.ts`) — house style encoding
  incident history. Compressing it deletes the reasons.
- **`WindowStateRegistry`'s ambient `getMonitorId()` fallback** — load-bearing for the MCP
  path. Add optional explicit `monitorId` params opportunistically (the grant pair at
  `window-state.ts:532,560` shows the shape); do not purge as a project.
- **`interruptAll`'s idle skip** (`agent-pool.ts:1118-1128`) — the `isRunning` filter is
  load-bearing and its doc is accurate; Phase 4.3's finding is a site that failed to copy
  it, not a flaw in the rule.
- **Sub-agent containment** (`profiles/sub-agent.ts`, `mcp/sub-agent/`, the
  `allowedTools: []`-not-`undefined` rule, `capabilities.ts` grant intersection) — audited,
  no finding; the spawn cap counts reservations and decides atomically before the first
  await.
- **Both providers' `dispose`/interrupt contracts** — clean; every leak found is a
  *missing* `dispose()` call, never a bad one. `ClaudeSessionProvider`'s interrupt
  escalation ladder stays as-is.

## Sequencing & test posture

Each phase lands independently; within a phase, items are independent PRs. Phases 1–3 are
behavior-preserving: the existing suites are the safety net, plus the one moved grep-regex
in the loopback test. Nothing left here changes wire formats, `ClientEvent`/`ServerEvent`
shapes, or app-facing verbs.

Phase 4's items are bug fixes, and each carries a regression test pinning the fixed
behavior, written against the *old* behavior first (`it.failing`, or simply run red before
the fix — the `audit_fix_proposal.md` ratchet pattern, and how the landed Phase 0 was
verified). 4.1 additionally flips `tests/agent-cleanup.test.ts:245-252` from certifying the
leak to pinning the fix.
