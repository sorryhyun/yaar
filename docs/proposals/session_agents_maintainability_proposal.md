# Proposal: session & agent-orchestration maintainability

**Responds to:** the 2026-08-06 three-track audit of `src/session/`, `src/agents/`, and the
cross-cutting session flows (connect/restore/teardown, `handlers/window.ts`, event fan-out).
**Scope:** `packages/server/src` — session layer, ContextPool/AgentPool orchestration, restore
paths. No wire-format or behavior changes.

**Phase 0 (four bug fixes) landed 2026-08-06** and has been removed from this document; the
code and its regression tests are the record. One piece of it was deliberately deferred to
Phase 2, and landed with it.

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

**Phase 2 (all eight items) landed 2026-08-06** and has been removed from this document;
the code and its tests are the record. Seven notes worth carrying forward:

- **The handle-stamping rule split in two** (`session/window-handle-stamp.ts`):
  `windowHandleFor()` holds the ordering rule (a `create` resolves *after* the registry
  write, everything else prefers the answer from *before*), `stampWindowHandle()` is the
  pure patch. All three emit paths call both. One deliberate behavior change:
  `ToolActionBridge` used to return the action untouched when it had no `monitorId` and now
  stamps an unambiguous handle anyway — an *ambiguous* raw id still resolves to `undefined`
  and falls back to itself, so this cannot misplace a window. The launch-hook path gained
  the prior-handle lookup it never had, which is what a launch hook closing a window needed.
- **`getPrimaryAgent` turned out to have no callers at all**, so it went with the other
  delegators rather than being kept as proposed, and took `AgentPool.getMonitorAgentSession`
  (its only callee) with it. `ContextPool.agentPool` now carries the doc comment saying it is
  the door; what stays on `ContextPool` either orchestrates or guards.
- **`Task.kind` made `direct_message` honest, and that changed one behavior.** A DM
  targeting a monitor is `kind: 'relay'`, so it now interrupts-and-queues on a busy monitor
  agent instead of trying to steer — the same "must not silently evaporate" guarantee the
  `relay` tool already had, and the reason the distinction exists. `window.message` is
  `'relay'` too, but it is always an app task, where `kind` does not affect routing.
  `reload/fingerprint.ts` deliberately keys on `requestedType`, not the executor: a cache key
  must not depend on the window registry's current state.
- **The queue refusal is shared, the wording is not** (`agents/queue-refusal.ts`). Both
  queues send one event shape; `why` stays at the call site, for the reason
  `monitor-task-processor.ts` already documented.
- **The budget slot wraps the *turn*, not `processMonitorTask`.** That method re-enters
  `processMonitorQueue` on its way out, so a slot held across the whole method would be held
  while the next turn asked for one of its own — with `MONITOR_MAX_CONCURRENT` background
  monitors draining, a deadlock against a semaphore each of them holds. Ephemeral turns are
  now billed a slot explicitly; they used to be covered only incidentally, by the slot
  `queueMonitorTask` happened to be holding.
- **The exhaustiveness `never` moved onto the surviving reducer.**
  `WindowStateRegistry.handleAction` now declines non-window actions at the top and is total
  over `window.*`, so the guarantee Phase 0 bought did not die with the reducer it was added
  to. `windowCreateAction()` (in `window-state.ts`) is the one state→action mapping, shared
  by restore and the reconnect snapshot.
- **`session-policies/` is now two files.** `ProviderLifecycleManager` is deleted, not
  slimmed: with the logger mint and `CONNECTION_STATUS` gone, `AgentSession.initialize` is
  six lines of acquire-and-attach.

## Phase 3 — the two big splits

**Items 1 and 2 landed 2026-08-06** and have been removed from this document; the code
and the suites that already covered it are the record. Six notes worth carrying forward:

- **The loopback grep needed no move after all.** `loopback-answer-waits.test.ts` scans
  source text for `actionEmitter.(resolve*|notifyAppReady)(` in the two frame-answering
  files, and keeping the singleton's public surface byte-identical is what left it
  pointed at real calls. Extracting *behind* a facade rather than *out from under* one is
  what made the trap a non-event.
- **`DesktopRequest` folded a sixth thing nobody had listed: the late-answer grace
  window.** `expiredDialogs` and `expiredAppRequests` were two maps, two prunes and two
  cutoff computations for one rule, so the store now owns "remember an expiry for
  `graceMs`" and the two callers keep their distinct *readings* of a late answer — a
  dialog's "don't ask me again" is still saved, an app's answer is still only a log line.
- **`AppReadyRegistry` holds its own waiters** rather than subscribing to the emitter's
  `'app-ready'` channel. A wait that is also a channel subscriber makes the registry's
  correctness depend on a subscription another module could remove; the channel stays as
  the public announcement of the same fact.
- **The sub-agent tier is reached through `AgentPool.subAgents`, not nine pass-throughs**
  — the call Phase 2 made for `ContextPool.agentPool`, one tier down. The registry reaches
  back for exactly two things, both constructor callbacks (build an agent, dispose one);
  `acquireProvider` was the third the proposal named, but `createWithFreshProvider`
  already wraps it, so injecting it separately would have been a second door onto the
  same seam.
- **`agent-roster.ts` took the composite keys too.** They are the ownership tree written
  as strings (`monitorId` → `::appId` → `::subId`) and `buildAgentTree` reads them back;
  three modules mint them and a fourth parses them, so they belong with the projection
  that depends on the extension rule rather than with the lifecycle that does not.
- **`SpawnReservations` states its three rules at the top**, because the two copies had
  drifted in *shape* while agreeing on every rule, and the leak they prevent is invisible
  by construction (an agent in no collection, holding a provider process and a
  `MAX_AGENTS` slot until the process dies). The app tier now matches reservations by tag
  instead of re-parsing its own key; every settle call survived the move unchanged.

### 3.3 — Retire `currentMonitorId` — **measuring, opened 2026-08-06**

The only cross-session mutable global left in the layer, last-writer-wins across
concurrent turns, undercutting `resolveWindowMonitor`'s own "never place a window by
guess" invariant from underneath. Its stated justification ("Codex cannot stamp identity
onto MCP requests") has been false since agent tokens: `mcp/server.ts` resolves the
monitor from `hub.findMonitorForAgent(agentId)` for *both* providers.

**The measurement is in** (`ActionEmitter.reportMonitorFallback`): a warning naming the
agent, once per agent id, whenever the fallback actually decides the answer. Naming the
agent rather than counting is what makes the result actionable — the whole server suite,
loopback included, prints the line zero times, so what is left to find is which *tier*
takes it in a real session.

The known candidate is the one `hub.findMonitorForAgent` cannot answer for: **ephemeral
agents have no monitor by design** (the session agent between turns is the other). If a
week of real use only ever names ephemerals, deleting the field means giving ephemerals a
monitor first, not just removing the four provider call sites
(`claude/session-provider.ts`, `codex/provider.ts` — two each). If it names nobody, the
field and its four call sites go.

## Phase 4 — agent pool system (deep lifecycle audit, 2026-08-06)

A dedicated trace of create → run → interrupt → dispose per tier (session, monitor, app,
sub-agent, ephemeral), limiter accounting, warm pool, and interrupt propagation.

**4.1, 4.2, 4.3, 4.4 and 4.6 landed 2026-08-06, ahead of Phase 3** — the bug fixes are
worth more than the refactor, and they barely overlap: Phase 3's three `agent-pool.ts`
seams (sub-agent tier, roster, spawn reservations) leave the core these fixes edit
(`disposeAgent`, `createAgentCore`, `cleanup`) exactly where it is. Their code and
regression tests are the record. Six notes worth carrying forward:

- **`disposeAgent` is now idempotent per agent id**, decided by the synchronous
  `agentIds` delete before its first await, and that is what makes the fire-and-forget
  disposers safe. `cleanup()` routes through it, clears its collections *before* the
  first dispose await (`disposeAgent`'s contract is that the caller already removed the
  agent), and **never throws** — the caller has no recovery to offer and stopping early
  is the bug. `disposeEphemeral` needed no separate guard in the end; the id guard covers
  every path.
- **`createAgentCore` releases on every non-success exit**, and
  `createWithFreshProvider`'s provider compensation moved into a `finally` — a *throw*
  used to skip the `if (!agent) dispose()` shape entirely, leaving the child process too.
- **`instanceId` is `genId(\`agent-${counter}\`)`** — the counter stays for readable
  logs, `genId` supplies the identity. The stale rationale in `disposeAgent`'s
  layout-delta comment ("a later agent could be handed a delta computed against a dead
  one's") went with it: that reuse is now impossible.
- **The provider switch refuses while a turn is in flight, then resets every session.**
  Each half covers what the other cannot — a running agent is the only thing that can
  observe its provider dying mid-stream, and idle agents still hold clients to the
  stopped `AppServer`. The refusal lands *before* anything is persisted. `applySettings`
  is the one implementation; `PATCH /api/settings` is now a thin door onto it and gained
  the validation and `desktop.updateSettings` broadcast it never had.
- **The idle reaper is one pool-level sweep, not a timer per agent** — `lastUsed` is
  already stamped on every turn, so it needs no new call sites and cannot leave a timer
  on a disposed agent. `PooledAgent.idleTimer` was deleted rather than wired up. Two
  decisions are load-bearing and documented at the sweep: a busy agent is *refreshed*
  rather than skipped (`lastUsed` is stamped at turn start, so a long turn would be
  reapable the instant it ended), and `getOrCreateAppAgent` touches the agent on the
  reuse path (between hand-out and `runAgentTurn` it is neither busy nor recently used).
  `APP_AGENT_IDLE_MINUTES` (default 15, `0` disables).
- **`SessionHub` gained `all()` and `drain()`.** `drain()` is bounded at 2s inside
  shutdown's 5s force-kill deadline: a hung provider must not be what stops the log flush
  of every *other* session.

### 4.5 — Structural (fold into Phases 1–3 where they overlap) — **still open**

- **Half of `AgentLimiter` is dead** (`limiter.ts:75-105`): production only calls
  `tryAcquire()`; the wait queue, timeout machinery, `clearWaiting`, `getWaitingCount` are
  unreachable, and stats report a structurally-zero `waitingCount`. Either delete the queue
  half or adopt it — and note `ContextPool.teardown:659` calls the **global** limiter's
  `clearWaiting`, which would reject *other sessions'* waiters the day anything queues.
  Deleting resolves both.
- **The `acquireProvider` test seam has a hole it documents itself as closing**
  (`agent-pool.ts`, at the `acquireProvider` field): `createMonitorAgent(id)` with no
  provider falls through to
  `AgentSession.initialize`'s module-level `acquireWarmProvider()`, bypassing the injected
  seam — the reason `tests/agent-cleanup.test.ts` needs `mock.module` and its own test
  partition. Thread the pool's `acquireProvider` into `createAgentCore`.
- **A fifth turn runner diverges from the other four**
  (`features/agents/session-actions.ts`): runs session-agent turns outside
  `SessionTaskProcessor` — passes `allowedTools` unconditionally on Codex (`:60`; both
  other sites pass `undefined` and say why), never sets the session-agent monitor while
  hardcoding `source: yaar://monitors/0` (`:56`), skips `MESSAGE_ACCEPTED` and
  reload-cache recording. Route it through `SessionTaskProcessor.process` (Phase 1's
  `turnOptionsFor()` removes the first divergence mechanically).
- **Settle-then-sweep re-entry window on the dispose side** (`AgentPool.disposeAppAgent`
  and `SubAgentRegistry.disposeForApp`/`disposeForMonitor`; widened by
  `removeMonitorAgent` deleting from `monitorAgents` *after* the app-agent sweep): a spawn
  beginning during the settle await lands after the sweep, orphaned until pool cleanup.
  Reorder the map delete first; add the missing dispose-then-create-race test
  (`app-agent-fresh.test.ts:362` covers only the reverse). Phase 3's seam C consolidated
  the two reservation copies, so the reorder is now one rule in one place — state it on
  `SpawnReservations` beside the three it already carries.
- **Warm pool goes permanently cold after one failed replenish**
  (`warm-pool.ts:237-257`): replenish only triggers on the *hit* path, so one `null`
  replenish leaves size 0 and every acquisition cold with no retry; and `doInitialize`'s
  early return (`:98-101`) without setting `initialized` re-runs full provider detection
  (Codex: `AppServer` start + OAuth) on every subsequent acquire. Replenish on the
  on-demand path too; latch the no-provider answer with a TTL.
- **Sub-agent turns bypass `inflightCount`** (`SubAgentRegistry.runTurn`):
  `ContextPool.teardown` step 4's "no in-flight references" comment is false for this tier
  — step 5 disposes providers under a live `for await`. Count sub-agent turns in
  `inflightCount` (or a pool-owned equivalent awaited by teardown). The step-5 comment now
  *names* the exception rather than claiming the guarantee, so this is a real fix waiting,
  not a lie waiting.

### Phase 4 lifecycle map (reference, as of the 4.1–4.4 landing)

Every tier's dispose is now idempotent — the guard is `disposeAgent`'s, not each
disposer's, so a new tier gets it for free.

| tier | provider acquired by | disposed by | reclaim gaps |
|---|---|---|---|
| session | pool `acquireProvider` | `disposeSessionAgent` | — |
| monitor | **ContextPool supplies** | `removeMonitorAgent` (cascades) | `MonitorRegistry.remove` fires it unawaited (safe, but still unobserved) |
| app | pool `acquireProvider` | `disposeAppAgent` | never on window close — idle reap is what bounds it |
| sub-agent | pool `acquireProvider` | `SubAgentRegistry.dispose*` | turn bypasses inflight (4.5); unawaited on last-window-close |
| ephemeral | pool `acquireProvider` | own task's `finally` only | — |

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
- **`interruptAll`'s idle skip** (`agent-pool.ts`) — the `isRunning` filter is
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

Each phase lands independently; within a phase, items are independent PRs. Phases 1–3
were behavior-preserving and the existing suites were the safety net — which held: the
two splits landed with no test edited beyond import paths and the sub-agent door's new
spelling. Nothing left here changes wire formats, `ClientEvent`/`ServerEvent` shapes, or
app-facing verbs.

Phase 4's items are bug fixes, and each carries a regression test pinning the fixed
behavior. **Only 4.5 is left**, plus 3.3's week of measurement. The one ordering
constraint between them is now discharged: 4.5's settle-then-sweep reorder touched the
two spawn-reservation copies, and seam C has consolidated them, so it is one edit to
`SpawnReservations` rather than two edits that must agree.

What landed with 4.1–4.4: `tests/agent-cleanup.test.ts` flipped from certifying the leak
to pinning the fix and gained the double-release race, the create-throws case, the token
revocation and the cross-pool id collision; `tests/app-agent-idle-reap.test.ts` and
`tests/settings-provider-switch.test.ts` are new; `tests/personas.test.ts` and
`tests/pool-drain.test.ts` took the interrupt guard and the hub drain.
