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

A **session** is the top-level container for one complete conversation. It owns all state — agents, windows, monitors, context history, and the on-disk log. Sessions survive individual WebSocket disconnections.

### Identity

Sessions are identified by `ses-{timestamp}-{random}` IDs (e.g., `ses-1707000000000-abc1234`), generated in `session/types.ts`. The `yaar://` URI scheme is implicitly scoped to the current session — `yaar://` *is* the session root. The current session is addressable as `yaar://sessions/current`, with sub-resources for logs (`yaar://sessions/current/logs`) and context (`yaar://sessions/current/context`). See [URI-Based Resource Addressing](./verbalized-with-uri.md).

### Multi-connection

Multiple browser tabs can share one session. When a tab connects with `?sessionId=X`, the server looks up the existing `LiveSession` instead of creating a new one. All connections in a session receive the same agent output via `BroadcastCenter.publishToSession()`.

```
Tab 1 ──┐
Tab 2 ──┼──> LiveSession(ses-123) ──> ContextPool, WindowState, ...
Tab 3 ──┘
```

### Lifecycle

1. **First connection** — no `?sessionId` param. Server creates a new `LiveSession` and sends `CONNECTION_STATUS { sessionId }`. Frontend stores it for future reconnections.
2. **Reconnection** — frontend passes `?sessionId=X`. Server returns the existing session. New client gets a snapshot of current windows via `generateSnapshot()`.
3. **Lazy init** — the expensive `ContextPool` (agents, provider) isn't created until the first message. This keeps `/health` fast.
4. **Persistence** — `SessionLogger` writes all messages to `session_logs/{sessionId}/messages.jsonl`. Sessions are browsable via `GET /api/sessions` and restorable via `POST /api/sessions/:id/restore`.

### Key types

| Type | Location | Purpose |
|------|----------|---------|
| `LiveSession` | `server/session/live-session.ts` | Session container — owns pool, window state, reload cache |
| `SessionHub` | `server/session/session-hub.ts` | Singleton registry of all active sessions |
| `SessionLogger` | `server/logging/session-logger.ts` | Writes messages.jsonl to disk |
| `SessionMetadata` | `server/logging/types.ts` | On-disk metadata (provider, agent hierarchy, thread IDs) |

---

## Monitor

A **monitor** is a virtual desktop workspace within a session (up to 4 per session). Think Linux workspaces or macOS Spaces — each monitor holds an independent set of windows and runs its own monitor agent.

### Why monitors exist

Monitors enable parallel, independent AI workflows. A user can run a long background task on Monitor 2 while continuing to interact on Monitor 1. Each monitor maintains its own:

- **Monitor agent** — persistent agent with its own provider session
- **Main queue** — sequential message processing, independent of other monitors
- **CLI history** — per-monitor command log
- **Windows** — each window belongs to exactly one monitor

### Identity

Monitors use numeric IDs like `0`, `1`, etc. The default monitor is always `0` ("Desktop 1"). Window URIs use the `yaar://monitors/{id}/{windowId}` format — see [URI-Based Resource Addressing](./verbalized-with-uri.md).

### Frontend

Monitors are managed in `monitorSlice.ts`:

```typescript
interface Monitor {
  id: string;        // "0"
  label: string;     // "Desktop 1"
  createdAt: number;
}
```

- **Taskbar tabs** — when more than one monitor exists, tabs appear on the left side of the taskbar
- **Keyboard** — `Ctrl+1` through `Ctrl+9` to switch monitors
- **Window filtering** — `selectVisibleWindows` filters by `activeMonitorId`
- **Removal** — deleting a monitor deletes all its windows

### Server

Each monitor gets its own monitor agent and queue:

```typescript
// agent-pool.ts
private mainAgents = new Map<string, PooledAgent>();  // Key: monitorId

// context-pool.ts — per-monitor main queue
private getOrCreateMainQueue(monitorId: string): MainQueuePolicy
```

When the server receives a `USER_MESSAGE` with a `monitorId` it hasn't seen before, it auto-creates a new monitor agent for that monitor.

### Event plumbing

`USER_MESSAGE`, `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, and `TOOL_PROGRESS` events all carry an optional `monitorId` field for routing.

---

## Window

A **window** is an AI-generated rectangular UI surface on the desktop. Windows are not pre-built screens — they are created and controlled entirely by the AI through OS Actions (JSON commands). Windows are addressed as `yaar://monitors/{monitorId}/{windowId}` — see [URI-Based Resource Addressing](./verbalized-with-uri.md).

### Structure

```typescript
// Shared (actions.ts)
interface WindowState {
  id: string;           // e.g., "win-settings"
  title: string;
  bounds: { x, y, w, h };
  content: { renderer: string; data: unknown };
  locked: boolean;
  lockedBy?: string;    // Agent ID holding the lock
}

// Frontend (types/state.ts) — extends with UI state
interface WindowModel extends ... {
  minimized: boolean;
  maximized: boolean;
  previousBounds?: WindowBounds;
  monitorId?: string;   // Which monitor this window belongs to
}
```

### Content renderers

Windows display content through pluggable renderers:

| Renderer | Data | Description |
|----------|------|-------------|
| `markdown` | `string` | Markdown converted to HTML |
| `html` | `string` | Raw HTML |
| `text` | `string` | Plain text |
| `table` | `{headers, rows}` | Tabular data |
| `iframe` | `string` or `{url}` | Embedded web content |
| `component` | `ComponentLayout` | Interactive React components from a flat JSON array |

The `component` renderer uses a flat Component DSL (no recursive nesting) designed for LLM simplicity. Components support forms (`formId`/`submitForm`), buttons with `action` strings, and CSS grid layout (`cols`, `gap`).

### Window interactions

Window interactions (`COMPONENT_ACTION`, `WINDOW_MESSAGE`) route based on window type:

- **Plain windows** (markdown, table, component, etc.) — interactions route to the **monitor agent** for the window's monitor. The monitor agent has the full conversation context.
- **App windows** — interactions route to a **dedicated app agent** via `AppTaskProcessor`. App agents are persistent per app (keyed by `appId`) and survive window close/reopen.
- **Monitor → App agent**: Monitor agents can send messages to app agents via `invoke('yaar://windows/{windowId}', { action: 'message', message: '...' })`. This takes the same code path as user interaction — the task is queued to the app agent through `AppTaskProcessor`. The call is fire-and-forget; combine with `subscribe` to get notified when the app agent finishes.

Same-window tasks are serialized via `WindowQueuePolicy`.

### App agent tools

App agents use a dedicated `app` MCP server (`mcp__app__*`) instead of the generic `yaar://` verb tools. This avoids requiring the agent to know its windowId (resolved via `AsyncLocalStorage`), limits tool access to exactly what's needed, and eliminates URI discovery round-trips.

| Tool | Description |
|------|-------------|
| `query(stateKey?)` | Read app state. WindowId resolved from AsyncLocalStorage context. |
| `command(command, params?)` | Execute an app command. WindowId resolved automatically. |
| `relay(message)` | Enqueue a message to the monitor agent for out-of-scope requests. |

Tools are defined in `mcp/app-agent/index.ts`. The windowId is set in `AgentContext` by `AppTaskProcessor` before each agent turn.

### Window subscriptions

Agents can subscribe to changes on other windows via `invoke('yaar://windows/{id}', { action: 'subscribe', events: [...] })`. When the target window changes, the subscribing agent receives a synthetic `<window:change>` message automatically.

- **Events**: `content`, `interaction`, `close`, `lock`, `unlock`, `move`, `resize`, `title`
- **Debounced** at 500ms per subscription to coalesce rapid updates (e.g., streaming appends)
- **Self-skip**: an agent modifying its own subscribed window won't trigger its own subscription
- **Cleanup**: subscriptions auto-removed on window close, agent dispose, or session teardown

### Locking

Locking prevents concurrent modification of a window's content by multiple agents:

```
window.lock(windowId, agentId)    → only this agent can modify
window.unlock(windowId, agentId)  → release (only locker can unlock)
```

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

### Server-side tracking

`WindowStateRegistry` (in `LiveSession`) maintains the server's view of all open windows. This lets agents call `list('yaar://windows/')` / `read('yaar://windows/{id}')` verb tools to inspect what's on screen without asking the frontend. (Legacy: `list_windows` / `view_window` — deprecated.)

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
