# Session Agent — Proposal

**Status:** Draft
**Scope:** Cross-monitor oversight and coordination within a single session

---

## Problem

Monitors are isolated islands. Each has its own agent, queue, and budget — but nothing coordinates across them. Today there is no way to:

- Audit what all monitors are doing from a single vantage point
- Interrupt or suspend a specific monitor's agent from another monitor
- Enforce session-wide resource policies (e.g., "only 2 monitors may use web search simultaneously")
- Coordinate work across monitors (e.g., "monitor 1 fetches data, monitor 2 visualizes it")
- Provide a unified "control plane" view of the session

The closest thing is `yaar://agents` (list/interrupt), but it's a flat introspection API with no judgment, no memory, and no ability to orchestrate.

---

## Proposal

Introduce a **session agent** — a persistent, session-scoped agent that sits above monitor agents in the hierarchy and has cross-monitor visibility and control.

```
LiveSession (kernel)
└── ContextPool
    ├── SessionAgent          ← NEW: session-scoped oversight
    │   ├── can read all monitor states
    │   ├── can interrupt/suspend/resume monitors
    │   ├── can relay messages between monitors
    │   └── can enforce session-wide policies
    ├── MonitorAgent[0]       (primary desktop)
    ├── MonitorAgent[1..3]    (background desktops)
    ├── AppAgent[appId]       (per-app daemons)
    └── EphemeralAgent[]      (one-shot tasks)
```

### Design Principles

1. **Lazy activation** — Not always running. Spun up on-demand when cross-monitor judgment is needed. Mechanical enforcement (rate limits, budgets) stays in policies.
2. **Observer by default, actor by request** — Reads state freely; writes (interrupt, suspend, relay) require explicit invocation.
3. **No routing changes for normal flow** — User messages still go to monitor agents. The session agent is a sidecar, not a gateway.
4. **Shares existing infrastructure** — Uses `AgentPool`, `AgentSession`, `AITransport`, `ActionEmitter` like any other agent. No new subsystems.

---

## Agent Lifecycle

### Creation

Lazy — created on first invocation, not at session init:

```
Trigger (URI invoke / slash command / policy escalation)
  → ContextPool.getOrCreateSessionAgent()
  → AgentPool.createSessionAgent()
  → Acquire warm provider
  → Set system prompt (session-agent-specific)
  → Ready
```

### Persistence

- **Provider session continuity**: Yes (like monitor agents). The session agent maintains conversation history across invocations.
- **Key**: `session` (singleton per ContextPool, like `monitorId` for monitor agents)
- **Idle timeout**: Same as monitor agents. Provider session preserved even when idle.

### Disposal

- Disposed with `ContextPool.cleanup()` (session end)
- Can be manually disposed via `delete('yaar://agents/session')`
- Auto-disposed after extended idle (configurable, default: 5 minutes)

---

## URI Surface

The session agent introduces URIs under the `yaar://monitors/` and `yaar://agents/` namespaces, consistent with existing flat URI patterns (`yaar://apps`, `yaar://config/`, etc.). The session agent is both a **resource** (queryable state) and an **actor** (invokable for judgment calls). The URI surface splits accordingly.

### Data reads (no agent needed — pure policy/state lookups)

| Verb | URI | Returns |
|------|-----|---------|
| `list` | `yaar://monitors` | All monitors: id, agent status, queue depth, budget usage |
| `read` | `yaar://monitors/{id}` | Single monitor detail: agent info, recent actions, windows |
| `list` | `yaar://agents` | All agents across all types (extends existing handler) |
| `read` | `yaar://budget` | Session-wide resource usage: total tokens, actions/min, active providers |
| `read` | `yaar://agents/session` | Session agent status (exists, idle/busy, last invocation) |

These are **stateless reads** handled by the handler layer — no agent spin-up required.

### Control actions (mechanical — no agent needed)

| Verb | URI | Payload | Effect |
|------|-----|---------|--------|
| `invoke` | `yaar://monitors/{id}` | `{ action: "suspend" }` | Pause monitor's queue, keep agent alive |
| `invoke` | `yaar://monitors/{id}` | `{ action: "resume" }` | Resume suspended monitor |
| `invoke` | `yaar://monitors/{id}` | `{ action: "interrupt" }` | Interrupt monitor's current task |
| `invoke` | `yaar://monitors/{id}` | `{ action: "set_budget", ... }` | Override budget for this monitor |
| `delete` | `yaar://monitors/{id}` | — | Dispose monitor agent, close its windows |

These are **mechanical operations** — deterministic, no AI judgment needed. Implemented as direct calls to `AgentPool`/`MonitorBudgetPolicy`.

### Session agent actions (judgment needed — agent spun up)

| Verb | URI | Payload | Effect |
|------|-----|---------|--------|
| `invoke` | `yaar://agents/session` | `{ action: "audit" }` | Session agent reviews all monitor states, reports anomalies |
| `invoke` | `yaar://agents/session` | `{ action: "coordinate", plan: "..." }` | Session agent orchestrates cross-monitor work |
| `invoke` | `yaar://agents/session` | `{ action: "query", question: "..." }` | Ask the session agent a question about session state |
| `delete` | `yaar://agents/session` | — | Dispose session agent |

These **wake the session agent** (or create it). The agent receives the request as a user message, reasons about it, and can call the mechanical URIs above as tools.

---

## System Prompt

The session agent gets a specialized system prompt focused on oversight:

```
You are the session controller for a YAAR session.

Your role:
- Monitor and audit agent activity across all monitors
- Intervene when agents are stuck, looping, or conflicting
- Coordinate cross-monitor workflows when requested
- Enforce session-wide resource policies

You have access to:
- list/read yaar://monitors — monitor states
- invoke yaar://monitors/{id} — suspend/resume/interrupt
- list yaar://agents — all agent info
- read yaar://budget — resource usage
- invoke yaar://agents/monitor — relay messages

You should:
- Be conservative with interventions (observe first, act second)
- Prefer relay messages over direct interrupts
- Report findings concisely
```

The session agent uses the same MCP tool surface as other agents but with a prompt that focuses it on oversight rather than UI generation.

---

## Implementation Plan

### Phase 1: URI Surface (data reads + mechanical controls)

**Files to modify:**
- `handlers/` — New `monitors.ts` handler (or extend existing if there's overlap)
- `handlers/uri-registry.ts` — Register `yaar://monitors` prefix
- `agents/agent-pool.ts` — Add `suspendAgent(monitorId)` / `resumeAgent(monitorId)`
- `agents/context-pool-policies/monitor-queue-policy.ts` — Support suspended state

**New concepts:**
- Monitor suspend/resume: Agent stays alive but queue stops draining. Queued tasks wait. New tasks queue normally.
- Session budget read: Aggregate across `MonitorBudgetPolicy` instances.

**No new agent code needed** — this phase is pure introspection + mechanical control.

### Phase 2: Session Agent

**Files to modify:**
- `agents/agent-pool.ts` — Add `sessionAgent: PooledAgent | null` field, `createSessionAgent()`, `disposeSessionAgent()`
- `agents/context-pool.ts` — Add `getOrCreateSessionAgent()`, wire into `cleanup()`
- `providers/claude/system-prompt-session.ts` — New system prompt for session agent
- `handlers/agents.ts` — Wire `invoke yaar://agents/session` to create + message the session agent

**Session agent is just another `PooledAgent`** — no new agent infrastructure. It uses `AgentSession.handleMessage()` like everything else. The only difference is its system prompt and that it's keyed by session rather than monitor/app.

### Phase 3: Trigger Points

How the session agent gets invoked (all optional, additive):

1. **Manual URI** — Any agent calls `invoke('yaar://agents/session', { action: "audit" })`. Useful for monitor agents that detect they need help.

2. **Slash command** — User types `/session audit` or `/session coordinate ...`. Frontend routes to session agent.

3. **Policy escalation** — `MonitorBudgetPolicy` or `AgentLimiter` can emit an event when thresholds are hit. `ContextPool` listens and optionally wakes the session agent.

4. **Periodic audit** — Optional timer that wakes the session agent every N minutes to check session health. Disabled by default.

---

## What This Doesn't Change

- **Normal message routing** — `USER_MESSAGE` still goes to the monitor agent. No new routing layer.
- **App agents** — Still keyed by `appId`, still managed by `AppTaskProcessor`.
- **Ephemeral agents** — Still one-shot, still created by `MonitorTaskProcessor`.
- **BroadcastCenter** — Session agent's events broadcast like any agent's events (scoped to a monitor or session-wide).
- **Provider abstraction** — Session agent uses the same `AITransport` as everyone else.

---

## Open Questions

1. **Which monitor does the session agent "belong to"?**
   - Option A: Monitor `0` (primary) — simplest, but conflates session-level with primary monitor
   - Option B: No monitor — events broadcast session-wide, UI (if any) floats above monitors
   - Option C: Virtual monitor `-1` or `session` — clean separation but requires frontend awareness
   - **Leaning toward B** — the session agent is a control plane, not a desktop

2. **Can monitor agents invoke the session agent directly?**
   - Yes via `invoke('yaar://agents/session', ...)` — same tool surface
   - Risk: monitor agent might over-rely on session agent. Mitigate via system prompt guidance.

3. **Should the session agent have window creation privileges?**
   - Minimal: No windows — communicates via relay messages and notifications only
   - Extended: Can create a "control panel" window on any monitor
   - **Leaning toward minimal initially**, extend later if needed

4. **Session agent budget**
   - Should bypass `MonitorBudgetPolicy` (it's not a background monitor)
   - Should have its own lighter budget (e.g., max 10 actions/invocation) to prevent runaway oversight
   - Counted against global `MAX_AGENTS` semaphore

5. **Inter-monitor relay**
   - Currently `relay` action only targets the monitor agent (`yaar://agents/monitor`)
   - Session agent would need `relay` to target specific monitors: `invoke('yaar://monitors/{id}', { action: "relay", message: "..." })`
   - This is a natural extension of the existing relay pattern

---

## OS Analogy

| OS Concept | Session Agent Equivalent |
|------------|--------------------------|
| `systemd` / `launchd` | Session agent (service manager, can start/stop/restart monitors) |
| `top` / `htop` | `list('yaar://monitors')` — process overview |
| `kill` / `SIGSTOP` / `SIGCONT` | `invoke('yaar://monitors/{id}', { action: "interrupt/suspend/resume" })` |
| `cgroups` | `MonitorBudgetPolicy` + session-wide budget aggregation |
| `/proc` filesystem | `yaar://monitors/`, `yaar://agents/`, `yaar://budget` — read-only introspection |

---

## Summary

The session agent is a **lazy, on-demand supervisor** that provides cross-monitor visibility and coordination. Most of its value comes from Phase 1 (data reads + mechanical controls via `yaar://monitors/` and `yaar://agents/` URIs) — the actual AI agent (Phase 2) is only needed when judgment or natural-language coordination is required.

Implementation is incremental and non-breaking: each phase adds capabilities without modifying existing message flow.
