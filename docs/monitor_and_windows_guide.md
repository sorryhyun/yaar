# Core Concepts: Session, Monitor, and Window

YAAR's runtime is organized into three nested abstractions. Understanding them is key to working with the codebase.

```
Session
├── Monitor 0 ("Desktop 1")
│   ├── Main Agent (persistent, sequential)
│   ├── Window A ──── Window Agent (persistent, parallel)
│   ├── Window B ──── Window Agent
│   └── CLI history
├── Monitor 1 ("Desktop 2")
│   ├── Main Agent (independent)
│   ├── Window C
│   └── CLI history
└── Event log (messages.jsonl)
```

---

## Session

A **session** is the top-level container for one complete conversation. It owns all state — agents, windows, monitors, context history, and the on-disk log. Sessions survive individual WebSocket disconnections.

### Identity

Sessions are identified by `ses-{timestamp}-{random}` IDs (e.g., `ses-1707000000000-abc1234`), generated in `session/types.ts`.

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
4. **Persistence** — `SessionLogger` writes all messages to `storage/sessions/{sessionDir}/messages.jsonl`. Sessions are browsable via `GET /api/sessions` and restorable via `POST /api/sessions/:id/restore`.
5. **Event sequencing** — `EventSequencer` stamps every outgoing event with a monotonic `seq` number. Late-joining clients can replay missed events or fall back to a full snapshot.

### Key types

| Type | Location | Purpose |
|------|----------|---------|
| `LiveSession` | `server/session/live-session.ts` | Session container — owns pool, window state, reload cache, sequencer |
| `SessionHub` | `server/session/live-session.ts` | Singleton registry of all active sessions |
| `EventSequencer` | `server/session/event-sequencer.ts` | Ring buffer for monotonic event sequencing + replay |
| `SessionLogger` | `server/logging/session-logger.ts` | Writes messages.jsonl to disk |
| `SessionMetadata` | `server/logging/types.ts` | On-disk metadata (provider, agent hierarchy, thread IDs) |

---

## Monitor

A **monitor** is a virtual desktop workspace within a session. Think Linux workspaces or macOS Spaces — each monitor holds an independent set of windows and runs its own main agent.

### Why monitors exist

Monitors enable parallel, independent AI workflows. A user can run a long background task on Monitor 2 while continuing to interact on Monitor 1. Each monitor maintains its own:

- **Main agent** — persistent agent with its own provider session
- **Main queue** — sequential message processing, independent of other monitors
- **CLI history** — per-monitor command log
- **Windows** — each window belongs to exactly one monitor

### Identity

Monitors use IDs like `monitor-0`, `monitor-1`, etc. The default monitor is always `monitor-0` ("Desktop 1").

### Frontend

Monitors are managed in `monitorSlice.ts`:

```typescript
interface Monitor {
  id: string;        // "monitor-0"
  label: string;     // "Desktop 1"
  createdAt: number;
}
```

- **Taskbar tabs** — when more than one monitor exists, tabs appear on the left side of the taskbar
- **Keyboard** — `Ctrl+1` through `Ctrl+9` to switch monitors
- **Window filtering** — `selectVisibleWindows` filters by `activeMonitorId`
- **Removal** — deleting a monitor deletes all its windows

### Server

Each monitor gets its own main agent and queue:

```typescript
// agent-pool.ts
private mainAgents = new Map<string, PooledAgent>();  // Key: monitorId

// context-pool.ts — per-monitor main queue
private getOrCreateMainQueue(monitorId: string): MainQueuePolicy
```

When the server receives a `USER_MESSAGE` with a `monitorId` it hasn't seen before, it auto-creates a new main agent for that monitor.

### Event plumbing

`USER_MESSAGE`, `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, and `TOOL_PROGRESS` events all carry an optional `monitorId` field for routing.

---

## Window

A **window** is an AI-generated rectangular UI surface on the desktop. Windows are not pre-built screens — they are created and controlled entirely by the AI through OS Actions (JSON commands).

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

The `component` renderer uses a flat Component DSL (no recursive nesting) designed for LLM simplicity. Components support forms (`formId`/`submitForm`), buttons with `action` strings sent to the window agent, and CSS grid layout (`cols`, `gap`).

### Window agents

Each window can have a **persistent window agent** — a dedicated AI agent that handles interactions specific to that window:

- **Created** on the first `WINDOW_MESSAGE` or `COMPONENT_ACTION` for that window
- **First turn** receives recent main conversation context from `ContextTape`
- **Subsequent turns** use provider session continuity
- **Window groups** — child windows created by a window agent share the parent's agent
- **Cleanup** — agent disposed when last window in its group closes

Window agents run **in parallel** with the main agent and with each other. Same-window tasks are serialized via `WindowQueuePolicy`.

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
  → Server: routed to window agent (if interaction needs AI), recorded in InteractionTimeline

AI emits window.close / user clicks X
  → Frontend: removed from store
  → Server: window agent disposed, reload cache invalidated
```

### Server-side tracking

`WindowStateRegistry` (in `LiveSession`) maintains the server's view of all open windows. This lets agents call `list_windows` / `view_window` MCP tools to inspect what's on screen without asking the frontend.

---

## How They Relate

```
Session (1 per conversation)
 ├── owns SessionHub registration, EventSequencer, SessionLogger
 ├── has 1+ Monitors (defaults to 1)
 │    ├── each has 1 Main Agent (persistent, sequential within monitor)
 │    ├── each has N Windows (AI-created, user-interactable)
 │    │    └── each may have 1 Window Agent (persistent, parallel)
 │    └── each has its own CLI history
 ├── has 1 WindowStateRegistry (tracks all windows across all monitors)
 ├── has 1 ReloadCache (fingerprint-based action caching)
 └── supports N WebSocket connections (multi-tab)
```

**Session** is about persistence and connectivity — it survives tab closes and supports multi-tab.
**Monitor** is about workspace isolation — independent agent contexts for parallel workflows.
**Window** is about visualization and interaction — the AI's canvas for showing content and receiving user actions.
