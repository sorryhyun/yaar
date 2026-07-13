# Proposal: Multi-Window Apps (`windowMode`)

**Status:** Draft
**Scope:** `packages/server` (agent pool, app task processor, context pool, window ID derivation), `apps/*/app.json` manifest

## Summary

Let one app hold several windows **on the same monitor**, each serviced by its own agent, by
keying app agents by window for apps that opt in. A new `app.json` field selects it:

```json
{ "windowMode": "multi" }
```

Default is `"single"` — existing apps keep today's behavior exactly.

## The invariant this builds on: apps are monitor-scoped

An app agent belongs to exactly one monitor, always. This is already true and is not up for
negotiation here: `appAgents` is keyed by `{monitorId}::{appId}` (`agent-pool.ts` —
`appAgentKey`), and the owning monitor is derived from the window the agent drives
(`AppTaskProcessor.ownerMonitor`), never from whoever sent the task. Two monitors running
the same app get two agents, two conversations, two windows.

`windowMode` therefore says nothing about monitors. It only decides how many windows an app
gets **within** its monitor:

| | agent key | meaning |
|---|---|---|
| `single` (default) | `{monitorId}::{appId}` | one agent per app per monitor — today |
| `multi` | `{monitorId}::{appId}::{windowId}` | one agent per window, all within one monitor |

The monitor prefix is present in both. Nothing in this proposal lets an agent, a task, or a
message reach across monitors — the cross-monitor routes (`direct_message` to `app:{id}`,
cross-app `controls`, `getActiveAppWindow`) stay scoped to the caller's monitor.

## Motivation

YAAR's model is: app = program, window = process, app agent = driver. Each app window
already has its own iframe runtime (own JS heap, own state; sharing only via `appStorage`).
The one-agent-per-app rule was an economy measure — fewer agents, warm continuity — not a
semantic decision, and it breaks the moment two windows of the same app exist on a monitor.

Document-shaped apps make the gap obvious: two PDFs in `pdf-viewer`, two memos, two storage
panes side by side. "One window per app" is a phone-OS assumption; YAAR's pitch is
desktop-grade AI-composed UI.

## Current state (verified)

### The window layer blocks this first

The draft this replaces assumed the window layer already permitted N windows per app. It does
not — and this is the **prerequisite**, ahead of any agent work:

- `deriveWindowId` (`features/window/helpers.ts:19`) is `if (appId) return appId` — the
  `name` and `title` arguments are ignored outright when an appId is present.
- The launch snippet handed to every agent (`features/dev/helpers.ts:52`) is
  `invoke('yaar://windows/${appId}', { action: "create" })` — so the raw window ID *is* the
  appId by convention.
- Both paths land on the same raw ID, hence the same handle, hence
  `WindowStateRegistry.handleAction` overwrites the first window's state with the second's.

An agent *can* dodge this today by choosing an explicit distinct ID
(`invoke('yaar://windows/pdf-report', { action: "create", appId: "pdf-viewer" })`), but
nothing tells it to, and every SKILL.md and generated snippet says otherwise. Multi-window is
unreachable in practice until window IDs are unique per window.

### The agent layer then serializes them

Assuming distinct window IDs, three things still collapse sibling windows onto one agent:

| Assumption | Location | Behavior today |
|---|---|---|
| One agent per (monitor, app) | `agent-pool.ts` — `appAgents: Map<'{monitorId}::{appId}', PooledAgent>` | All windows of an app on a monitor share one agent and one conversation |
| One task at a time per (monitor, app) | `app-task-processor.ts` — `processingKey = 'app-' + monitorId + '-' + appId` | Interactions in window B queue behind (or steer into) window A's running task |
| One "active" window per (monitor, app) | `app-task-processor.ts` — `activeWindows: Map<'{monitorId}::{appId}', windowId>`, last write wins | Hook responses, `findWindowForAgent`, and DirectMessage routing target whichever window was touched most recently |

And one place where the singleton is actively destructive:

- **Close clobbers siblings** — `handleWindowClose` clears the (monitor, app)'s entire task
  queue and interrupts the shared agent when *any* window of that app closes, even if the
  agent is mid-task for a different window.

The per-task tooling is already window-correct: `mcp/app-agent/index.ts` resolves `windowId`
from the current task via AsyncLocalStorage and derives `appId` from
`windowState.getAppIdForWindow(windowId)`. The leak is confined to window ID derivation,
lifecycle, queueing, and routing — not the tools.

## Design

### 0. Unique window IDs (prerequisite)

For `multi` apps, a bare create must mint a fresh ID instead of reusing the appId:

```ts
// deriveWindowId(appId, name, title), for windowMode: 'multi'
// prefer an explicit name; else suffix the appId with a short unique token
name ? `${appId}-${slug(name)}` : `${appId}-${shortId()}`
```

`single` apps keep `deriveWindowId → appId` verbatim, so their stable, guessable window ID
(which SKILL.md snippets and `reload` fingerprints rely on) is unchanged. The launch snippet
in `features/dev/helpers.ts` must, for `multi` apps, stop hardcoding
`yaar://windows/${appId}` and instead create against the bare collection
(`invoke('yaar://windows/', { action: "create", appId, name })`) so each launch gets its own
window. Uniqueness only has to hold within a monitor — the handle map already namespaces raw
IDs by monitor (`{monitorId}/{rawId}`).

### 1. Manifest flag

Add to `AppInfo` (`features/apps/discovery.ts`) and parse from `app.json`:

```ts
windowMode?: 'single' | 'multi'; // default 'single'
```

- `single` — today's behavior. Correct for control-surface apps (dock, devtools, panels —
  anything with `variant: 'panel'` is implicitly single).
- `multi` — document-shaped apps; each window gets its own agent.

This mirrors the classic OS distinction (single-instance vs document-based apps) and fits the
convention-based app system: the app declares what it is; the pool picks the agent key.

### 2. Agent key: window for `multi`, app for `single` — monitor always

Extend `appAgentKey` (`agent-pool.ts`), which today is `(monitorId, appId)`:

```ts
// monitorId is never optional — see "the invariant" above
agentKey = windowMode === 'multi'
  ? `${monitorId}::${appId}::${windowId}`
  : `${monitorId}::${appId}`;
```

Concretely:

- **`agent-pool.ts`** — entries store `{ appId, monitorId, windowId? }` alongside the agent
  rather than being parsed back out of the key string (`parseAppKey` already exists and grows
  awkward at three parts). `getOrCreateAppAgent` / `getAppAgent` / `hasAppAgent` /
  `steerAppAgent` / `disposeAppAgent` take the key; `findAppForAgent` returns the record.
  `disposeAppAgentsForMonitor` keeps working — it filters on the record's `monitorId`, which
  is exactly why the monitor must stay a first-class field and not just a string prefix.
- **`app-task-processor.ts`** — `processingKey = 'app-' + agentKey`. For `multi` apps this
  mechanically fixes all three collapses at once:
  - queues become per-window (windows of one app run concurrently);
  - `handleWindowClose` clears only the closed window's queue and interrupts only its agent —
    sibling windows are untouched;
  - `activeWindows` becomes redundant for `multi` apps (the agent's window *is* its key).
- **Profile cache stays per-app** — `profiles: Map<appId, AgentProfile>` is unchanged;
  `buildAppAgentProfile(appId)` is shared across all windows. The system prompt is a function
  of the app, not the window or the monitor.

### 3. Routing (`activeWindows` becomes single-mode-only)

`getActiveWindowId(monitorId, appId)` has two callers in `context-pool.ts`
(`findWindowForAgent`, and `getActiveAppWindow` used by DirectMessage and cross-app control).

- `findWindowForAgent(agentId)` — for `multi` apps, read `windowId` straight off the agent's
  stored record. Exact, no last-write-wins.
- `getActiveAppWindow(monitorId, appId)` — for `multi` apps "the app's window" is genuinely
  ambiguous. Resolve to the **most recently created still-open** window of that app *on that
  monitor*, and document that senders targeting a multi-window app should address a window,
  not an app. (`direct_message` already accepts `window:{id}`.)
- `notifyHookResponse(appId, windowId, monitorId, …)` already receives the explicit windowId
  from the task — no change.

### 4. Steering

Steering currently injects a message into the running app agent when a new task arrives while
it is busy. With per-window agents this scopes itself: steer only when the *same window's*
agent is busy. A task for window B while window A runs creates/uses window B's agent
concurrently instead of steering into A — strictly more correct than today.

### 5. Lifecycle & resource pressure

Per-window agents multiply against `MAX_AGENTS` (default 10, enforced by `AgentLimiter`), and
they now multiply per monitor as well — the ceiling is windows × monitors. Two mitigations:

1. **Dispose on close for `multi` agents.** A `single` agent persists for the session (the
   window may reopen). A `multi` agent's identity *is* its window; when the window closes,
   `disposeAppAgent(agentKey)` after the interrupt in `handleWindowClose`. This releases the
   limiter slot and returns the warm provider to the replenishment path.
   `disposeAppAgentsForMonitor` (which reclaims a removed monitor's app agents) already covers
   the monitor-teardown case and needs no change beyond the new key shape.
2. **Idle reaping (follow-up, not required for v1).** If sessions routinely hold many windows
   open, reap agents idle > N minutes and recreate lazily on next interaction. The warm pool
   makes recreation cheap; that window's conversation continuity is lost, which is acceptable —
   iframe state and `appStorage` persist.

### 6. Cross-window state

Today the singleton agent incidentally "remembers" activity across an app's windows.
Per-window agents lose that channel, deliberately: `appStorage` is the honest shared-state
channel and already exists. An app that *needs* cross-window agent memory is telling you it's
a control surface — it should stay `single`.

The monitor agent still sees every app-agent response via `InteractionTimeline`
(`pushAI(..., windowId, ...)` already tags the window), so cross-window orchestration stays
the monitor's job, which matches the architecture. Cross-*monitor* orchestration remains the
session agent's job, and is untouched.

### 7. Logging / observability

`agentRole` is already `app-${appId}-m${monitorId}-${…}`. For `multi` apps, include the
window in the non-parallel form (`app-${appId}-m${monitorId}-w${windowId}-${task.messageId}`)
so session logs distinguish sibling windows — today two windows of one app on one monitor are
indistinguishable in `session_logs/*/agents/`. `sharedLogger.registerAgent` already receives
the windowId.

## What does NOT change

- **Monitor scoping.** App agents remain per-monitor; no route added here crosses monitors.
- `single` apps: zero behavioral change; `windowMode` is optional and defaults to `single`.
- The OS Actions schema, WebSocket events, frontend, and app protocol. Windows already carry
  `appId`, and the frontend already renders N windows per app given distinct IDs.
- App agent tools (`query` / `command` / `relay` / `direct_message`) — already window-scoped
  via AsyncLocalStorage.

## Implementation sketch

1. `features/window/helpers.ts` + `features/dev/helpers.ts` — windowMode-aware
   `deriveWindowId` and launch snippet (§0). **Do this first; nothing else matters without it.**
2. `features/apps/discovery.ts` — parse `windowMode` into `AppInfo`; expose `getWindowMode(appId)`.
3. `agents/agent-pool.ts` — extend `appAgentKey` to the 3-part form; store
   `{ appId, monitorId, windowId? }` records; update the `*AppAgent` signatures.
4. `agents/app-task-processor.ts` — derive the key from windowMode; per-key `processingKey`;
   scope `handleWindowClose` to the key; dispose `multi` agents on close; keep `activeWindows`
   for `single` apps only; extend `agentRole`.
5. `agents/context-pool.ts` — update `findWindowForAgent` / `getActiveAppWindow` per §3.
6. Docs — `packages/server/CLAUDE.md` (app agent key), `docs/app-development.md` (`windowMode`).
7. Mark document-shaped bundled apps (`pdf-viewer`, `storage`, …) `"windowMode": "multi"` once
   verified.

Estimated size: ~250–350 lines across 6 server files + manifest parsing; no shared/frontend
changes.

## Testing

- Unit: `deriveWindowId` — `multi` yields distinct IDs per window; `single` still yields the
  bare appId.
- Unit: `AppTaskProcessor` with two windows of a `multi` app on one monitor — concurrent
  processing, independent queues, close of window A does not interrupt window B's running task.
- Unit: **monitor scoping holds under `multi`** — the same `multi` app with two windows on
  monitor 0 and two on monitor 1 yields four agents, and no route resolves from one monitor
  into the other's windows (extends `window-handle-scope.test.ts`).
- Unit: `single` app regression — steering, queueing, close-interrupt identical to today.
- Manual (headless flow per root CLAUDE.md): open two `pdf-viewer` windows with different
  documents, interact with both in quick succession, close one mid-task, verify the other
  completes; verify hook responses land in the correct window.

## Alternatives considered

- **Window-aware singleton** (one agent per app per monitor; fix `activeWindows`,
  close-interrupt, and routing to be per-task): cheaper, preserves cross-window memory, but
  retains the serial per-app bottleneck and an interleaved conversation in which the model must
  keep straight which window each exchange belongs to. Rejected: fixes the bugs but not the
  model-confusion or the concurrency ceiling.
- **Per-window agents for all apps** (no flag): simpler mental model, but breaks apps relying on
  agent continuity across reopen (dock, devtools) and multiplies agent count for no benefit for
  panel apps. Rejected in favor of opt-in.
- **Per-app agents shared across monitors** (drop the monitor from the key): rejected outright —
  this was the bug fixed in `9b941ed3`. A shared agent hands monitor 2's user the window,
  context, and conversation of monitor 1.

## Open questions

1. Should `variant: 'panel'` / `dockEdge` apps hard-reject `windowMode: 'multi'` at discovery
   time, or just warn?
2. Is there a per-monitor window cap for `multi` apps (a runaway agent opening 20 PDF windows
   exhausts `MAX_AGENTS` for the whole session, starving other monitors)? `MonitorBudgetPolicy`
   is the natural home if so.
3. Should a `multi` agent survive window close for a grace period (reopen-with-memory), or is
   dispose-on-close (§5) always right? v1 says dispose; revisit with usage data.
