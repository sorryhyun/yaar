# Core Concepts: Session, Monitor, and Window

YAAR's runtime is organized into three nested abstractions. Understanding them is key to working with the codebase.

```
Session
├── Monitor 0 ("Desktop 1")
│   ├── Monitor Agent (persistent, sequential)
│   ├── Window A
│   ├── Window B
│   └── CLI history
├── Monitor 1 ("Desktop 2")
│   ├── Monitor Agent (independent)
│   ├── Window C
│   └── CLI history
└── Event log (messages.jsonl)
```

---

## Session

A **session** is the top-level container for one complete conversation. It owns all state — agents, windows, monitors, context history, and the on-disk log. Sessions survive individual WebSocket disconnections: the session is about *persistence*, not about any one browser tab.

The `yaar://` URI scheme is implicitly scoped to the current session — `yaar://` *is* the session root. The session itself is addressable as `yaar://session` (see the [URI & Verb Reference](../reference/uri_reference.md)).

### Multi-connection

Multiple browser tabs can share one session. When a tab connects with `?sessionId=X`, the server looks up the existing `LiveSession` (`session/live-session.ts`, registered in the singleton `SessionHub`) instead of creating a new one. All connections receive the same agent output via `BroadcastCenter`.

```
Tab 1 ──┐
Tab 2 ──┼──> LiveSession(ses-123) ──> ContextPool, WindowState, ...
Tab 3 ──┘
```

### Lifecycle

1. **First connection** — no `?sessionId` param. Server creates a new `LiveSession` and sends `CONNECTION_STATUS { sessionId }`; the frontend stores it for reconnection.
2. **Reconnection** — frontend passes `?sessionId=X`; server returns the existing session and the new client gets a snapshot of current windows.
3. **Lazy init** — the expensive `ContextPool` (agents, provider) isn't created until the first message. This keeps `/health` fast.
4. **Persistence** — `SessionLogger` writes everything to `session_logs/{sessionId}/messages.jsonl`; sessions are browsable and restorable from those logs.

---

## Monitor

A **monitor** is a virtual desktop workspace within a session (up to 4). Think Linux workspaces or macOS Spaces — each monitor holds an independent set of windows and runs its own monitor agent.

### Why monitors exist

Monitors enable parallel, independent AI workflows: a long background task can run on Monitor 2 while the user keeps interacting on Monitor 1. Each monitor has its own monitor agent (with its own provider session), its own sequential main queue, its own CLI history, and its own windows. Monitors are addressed as `yaar://session/monitors/{id}`; suspend/resume/interrupt controls are listed in the [URI & Verb Reference](../reference/uri_reference.md).

### Who owns what

**The session owns the monitor list; a connection owns which monitor it is looking at.**

`LiveSession.monitors` is authoritative. The server mints the ids (`ADD_MONITOR` → lowest unused integer) and broadcasts the list (`MONITORS`) on attach and on every change; the frontend renders it. It used to be per-tab state minted from a per-tab counter, so two tabs each made a monitor `"1"`, collided on one server-side agent, and neither saw the other's.

`activeMonitorId` lives only in the frontend store, one per tab, and is mirrored server-side as the connection's single `BroadcastCenter` subscription (replace-on-set). The server has no session-wide "active monitor" — a session has N connections, so one such field is a category error, and it was last-writer-wins between tabs.

### The server never invents a monitor id for routing

For a **window-scoped** event (`WINDOW_MESSAGE`, `COMPONENT_ACTION`, any `window.*` action) the monitor comes from the window — `WindowStateRegistry.getMonitorForWindow`. For a **user-scoped** event it comes from the connection that sent it. On the routing path, a task or action whose monitor cannot be resolved throws (`requireMonitorId`, `ActionEmitter.resolveWindowMonitor`) rather than guessing. Guessing is what made a click in a window on monitor 1 run on monitor 0's agent and open its windows there. The findings behind the rule, and the tests that pin it, are in `packages/server/src/tests/monitor-identity.test.ts`.

This is a routing-path guarantee, not a claim that `'0'` never appears anywhere. `DEFAULT_MONITOR_ID` (`'0'`) is a real, live fallback for *display* purposes on the frontend — e.g. `(w.monitorId ?? DEFAULT_MONITOR_ID)` in `packages/frontend/src/store/selectors.ts` and `desktop.ts`, and in the server's monitor registry, which seeds `monitors[0]` as `DEFAULT_MONITOR_ID` (`packages/server/src/session/monitor-registry.ts`). Those are initialization/rendering defaults, not routing guesses.

### Server side

Each monitor gets its own monitor agent (keyed by `monitorId` in `AgentPool`) and its own main queue in `ContextPool`. A `USER_MESSAGE` carrying an unseen `monitorId` auto-creates the agent. Monitor-scoped events (`USER_MESSAGE`, `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, `TOOL_PROGRESS`) carry a `monitorId` for routing.

### Session agent

A **session agent** is a lazy, on-demand AI supervisor that sits above monitor agents — and is the **session principal**, the one agent tier with access to `yaar://session/*`. It provides cross-monitor visibility and coordination: auditing monitor states, intervening when agents are stuck, orchestrating cross-monitor workflows.

- **Lazy singleton** — created on first invocation, not at session start
- **No monitor, no windows** — communicates via tool results and relay messages only
- **Verb tools only** — the same 5 generic verbs as other agents; no WebSearch, no Task
- **Privileged principal** — agents carry a `role` (`session` / `monitor` / `app`); only `role === 'session'` may reach `yaar://session/*`, enforced centrally in `ResourceRegistry.execute()`

Its invoke actions (`audit`, `coordinate`, `query`) are listed in the [URI & Verb Reference](../reference/uri_reference.md).

---

## Window

A **window** is an AI-generated rectangular UI surface on the desktop. Windows are not pre-built screens — they are created and controlled entirely by the AI through OS Actions. Agents address them as `yaar://windows/{windowId}`; the monitor is inferred from the agent's context.

A window carries an id, title, bounds, a lock state, and — the interesting part — a `content` payload of `{ renderer, data }`. Renderers are pluggable: `markdown`, `html`, `text`, `table`, `iframe`, and `component` (a flat Component DSL — no recursive nesting, CSS-grid layout — designed so an LLM can emit it reliably). The frontend extends this with pure UI state (minimized/maximized, z-order). Full renderer payload shapes are in the [OS Actions Reference](../reference/os_actions_reference.md).

### Who handles a window interaction

Window interactions (`COMPONENT_ACTION`, `WINDOW_MESSAGE`) route by window type:

- **Plain windows** (markdown, table, component, …) → the **monitor agent** for the window's monitor. It has the full conversation context.
- **App windows** → a dedicated **app agent** via `AppTaskProcessor`. App agents are persistent per `appId` and survive window close/reopen. They use a scoped `app` MCP toolset (`query`/`command`/`relay`) instead of generic verbs — see [common_flow.md](./common_flow.md) for the division of responsibility.
- **Monitor → app agent** — a monitor agent messages an app window with `invoke('yaar://windows/{id}', { action: 'message', ... })`; the task takes the same queue path as a user interaction. Fire-and-forget; combine with `subscribe` to learn when the app agent finishes.

Same-window tasks are serialized via `WindowQueuePolicy`; different windows run in parallel.

### Subscriptions and locking

Agents can subscribe to another window's changes (`action: 'subscribe'`, events like `content`, `interaction`, `close`); the subscriber receives a synthetic `<window:change>` message when the target changes. Updates are debounced (500ms), an agent's own writes don't trigger its own subscription, and subscriptions are cleaned up on window close or agent disposal.

Locking prevents concurrent modification: `window.lock(windowId, agentId)` makes the window writable only by that agent until it unlocks.

### Lifecycle summary

```
AI emits window.create action
  → Server: WindowStateRegistry records it, BroadcastCenter sends to all connections
  → Frontend: added to store, rendered by WindowManager in z-order

User interacts (drag, resize, click button, close)
  → Frontend: local state updated immediately
  → Server: routed to monitor agent (or app agent for app windows), recorded in InteractionTimeline

AI emits window.close / user clicks X
  → Frontend: removed from store
  → Server: subscriptions cleared, context pruned, reload cache invalidated
```

`WindowStateRegistry` (in `LiveSession`) is the server's own view of every open window — agents inspect what's on screen via `list('yaar://windows/')` / `read('yaar://windows/{id}')` without asking the frontend.

---

## How They Relate

```
Session (1 per conversation)
 ├── owns SessionHub registration, SessionLogger
 ├── has 1–4 Monitors (defaults to 1)
 │    ├── each has 1 Monitor Agent (persistent, sequential within monitor)
 │    ├── each has N Windows (AI-created, user-interactable)
 │    └── each has its own CLI history
 ├── has 1 WindowStateRegistry (tracks all windows across all monitors)
 ├── has 1 ReloadCache (fingerprint-based action caching)
 └── supports N WebSocket connections (multi-tab)
```

**Session** is about persistence and connectivity — it survives tab closes and supports multi-tab.
**Monitor** is about workspace isolation — independent agent contexts for parallel workflows.
**Window** is about visualization and interaction — the AI's canvas for showing content and receiving user actions.
