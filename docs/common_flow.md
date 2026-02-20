# Agent Architecture: Pools, Context, and Message Flow

This document describes how YAAR manages concurrent AI agents through unified pooling, hierarchical context, and policy-based orchestration.

## Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                   SessionHub (singleton registry)                     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                LiveSession (per conversation)                   │  │
│  │         survives disconnections, supports multi-tab             │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │                      ContextPool                         │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │  │
│  │  │  │ AgentPool  │  │ ContextTape │  │ InteractionTime- │  │  │  │
│  │  │  │            │  │ (message    │  │ line (user +     │  │  │  │
│  │  │  │ Main(1/mon)│  │  history by │  │ AI events,       │  │  │  │
│  │  │  │ Ephemeral* │  │  source)    │  │ drained on main  │  │  │  │
│  │  │  │ Window*    │  │             │  │ agent's turn)    │  │  │  │
│  │  │  │ Task*      │  │             │  │                  │  │  │  │
│  │  │  └────────────┘  └─────────────┘  └──────────────────┘  │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌──────────────────────────────────────────────────┐    │  │  │
│  │  │  │ Policies                                         │    │  │  │
│  │  │  │ MainQueue(per monitor) · WindowQueue ·           │    │  │  │
│  │  │  │ ContextAssembly · ReloadCache · WindowConnection │    │  │  │
│  │  │  │ MonitorBudget                                    │    │  │  │
│  │  │  └──────────────────────────────────────────────────┘    │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Delegation Model

The main agent acts as an **orchestrator** — it understands user intent, decides the approach, and dispatches work. The design intentionally restricts the main agent's tool set to quick actions (windows, notifications, storage reads, memory, config) and gives it a single delegation primitive (Task tool for Claude, collaboration system for Codex).

```
User Request
     │
     ▼
┌──────────────┐
│  Main Agent  │  Understands intent, decides approach
│ (orchestrator)│
└──────┬───────┘
       │
       ├─ Trivial? ──────────────────────> Handle directly (1-2 tool calls)
       │  • greeting/ack → notification    • open app → load skill + window
       │  • read file → storage + window   • replay → reload_cached
       │
       ├─ Web/API work? ─────────────────> Task(profile: "web")
       │  • search, fetch, API calls
       │
       ├─ Computation? ──────────────────> Task(profile: "code")
       │  • run JS, data processing
       │
       ├─ App dev? ──────────────────────> Task(profile: "app")
       │  • write, compile, deploy apps
       │
       └─ Multi-part? ──────────────────> Parallel Task agents
          • "research X and build Y"       (web + app simultaneously)
```

**Why delegate by default?** Task agents fork the main agent's session (full conversation history) and run with a focused tool set matching their profile. This keeps the main agent responsive — it can accept the next user message while subagents work. It also reduces token waste by keeping the main agent's turns short and action-oriented.

**What stays on the main agent?** Anything that takes 1-2 tool calls using only the main agent's tools: showing notifications, opening/updating windows, loading app skills, reading storage, memory operations, config hooks, and cache replay.

## Agent Types

### 1. Main Agent

The persistent orchestrator handling the main conversation flow per monitor. Maintains provider session continuity across messages. Has a restricted tool set focused on quick actions and delegation.

- **Role**: `main-{monitorId}-{messageId}` (set per-message)
- **Creation**: One per monitor. Primary (`monitor-0`) created at pool init with a pre-warmed provider; additional monitors auto-created on demand (max 4)
- **Session**: Resumes the same provider session across messages for full conversation history
- **Canonical ID**: `main-{monitorId}`
- **Tools**: Windows, notifications, storage read/list, memory, skills, config hooks, cache replay, Task (delegation)

### 2. Ephemeral Agent

A temporary agent spawned when the main agent is busy and a new main task arrives. Gets a fresh provider with no conversation history, and is disposed immediately after the task completes.

- **Role**: `ephemeral-{monitorId}-{messageId}`
- **Creation**: On demand when main agent is busy (limited by global `AgentLimiter`)
- **Context**: No conversation history — receives open windows + reload options + task content
- **Lifecycle**: Created → process task → push to InteractionTimeline → disposed

### 3. Window Agent

A persistent agent for handling window-specific interactions (button clicks, context menu messages). Each window (or window group) gets its own agent with its own provider session.

- **Role**: `window-{windowId}` or `window-{windowId}/{actionId}` (for parallel button actions)
- **Creation**: On first `COMPONENT_ACTION` or `WINDOW_MESSAGE` for that window
- **Context**: First interaction receives recent main conversation from ContextTape; subsequent interactions use provider session continuity
- **Grouping**: Child windows created by a window agent join the parent's group, sharing one agent
- **Canonical ID**: `window-{agentKey}` (where agentKey = groupId or windowId)

### 4. Task Agent

A temporary agent spawned by the main agent to handle delegated work. Forks the main agent's provider session (inheriting full conversation context) and runs with a profile-specific tool subset and system prompt.

- **Role**: `task-{messageId}-{timestamp}`
- **Creation**: Via Task tool (Claude) or collaboration system (Codex). Limited by global `AgentLimiter`
- **Context**: Forks main agent's session — inherits full conversation history
- **Profiles**: `default` (all tools), `web` (HTTP + search), `code` (sandbox), `app` (dev + deploy)
- **Lifecycle**: Created → process objective → push to InteractionTimeline → disposed
- **Parallel**: Multiple task agents can run concurrently for independent sub-tasks

## Multi-Monitor Architecture

Monitors are virtual desktops within a single session. Each has its own main agent and sequential queue.

- **Primary monitor** (`monitor-0`): Always exists, never throttled
- **Background monitors** (`monitor-1`, `monitor-2`, ...): Auto-created on demand when a `USER_MESSAGE` targets a new monitorId, up to 4 total
- **Independence**: Each monitor has its own main agent and main queue, but all monitors share the same window state, context tape, timeline, and reload cache
- **Budget limits**: Background monitors are rate-limited by `MonitorBudgetPolicy` (concurrent tasks, actions/min, output/min). The primary monitor bypasses all limits.

## Message Flow

### User Message → Main Agent

When a user message arrives, the system tries strategies in priority order:

```
USER_MESSAGE arrives for monitorId
│
├─ Main agent idle → processMainTask() directly
│
└─ Main agent busy:
   │
   ├─ 1. Steer → inject into active turn (Codex: turn/steer, Claude: streamInput)
   │     Success: AI incorporates new input mid-response, MESSAGE_ACCEPTED
   │     Fail: provider doesn't support it, or turn just ended
   │
   ├─ 2. Ephemeral → fresh provider, parallel response
   │     Success: user gets a second response from a disposable agent
   │     Fail: global agent limit reached
   │
   └─ 3. Queue → MainQueuePolicy.enqueue()
         Success: MESSAGE_QUEUED, processed when main agent finishes
         Fail: queue full (10 per monitor)
```

Full flow for direct processing:

```
Frontend                    Server                          AI Provider
   │                          │                                  │
   │  USER_MESSAGE            │                                  │
   ├─────────────────────────>│                                  │
   │                          │  Budget check (background only)  │
   │                          │  Main agent idle?                │
   │                          │  ├─ Yes: processMainTask()       │
   │                          │  └─ No: steer / ephemeral / queue│
   │                          │                                  │
   │  MESSAGE_ACCEPTED        │  Build prompt:                   │
   │<─────────────────────────│  timeline + openWindows +        │
   │                          │  reloadOptions + content         │
   │                          │                                  │
   │                          │  provider.query(prompt, {        │
   │                          │    sessionId,                    │
   │                          │    systemPrompt                  │
   │                          │  })                              │
   │                          ├─────────────────────────────────>│
   │                          │                                  │
   │  AGENT_THINKING          │<─────────────────────────────────│
   │<─────────────────────────│  Stream messages                 │
   │                          │                                  │
   │  AGENT_RESPONSE          │<─────────────────────────────────│
   │<─────────────────────────│  (actions recorded for cache)    │
   │                          │                                  │
   │                          │  Drain main queue if pending     │
   │                          │                                  │
```

### Button Click → Window Agent

```
Frontend                    Server                          AI Provider
   │                          │                                  │
   │  COMPONENT_ACTION        │                                  │
   │  { windowId, action,     │                                  │
   │    actionId?, formData?} │                                  │
   ├─────────────────────────>│                                  │
   │                          │                                  │
   │                          │  Resolve group: windowId →       │
   │                          │  agentKey (groupId or windowId)  │
   │                          │                                  │
   │                          │  Agent exists for agentKey?      │
   │                          │  ├─ Yes: Reuse                   │
   │                          │  └─ No: Create (fresh provider)  │
   │                          │                                  │
   │  WINDOW_AGENT_STATUS     │  First message?                  │
   │  { status: 'active' }    │  ├─ Yes: inject recent main      │
   │<─────────────────────────│  │  context from ContextTape     │
   │                          │  └─ No: session continuity       │
   │                          │                                  │
   │                          │  provider.query(prompt, {        │
   │                          │    sessionId                     │
   │                          │  })                              │
   │                          ├─────────────────────────────────>│
   │                          │                                  │
   │  AGENT_RESPONSE          │  After completion:               │
   │<─────────────────────────│  - Record to InteractionTimeline │
   │                          │  - Track child window groups     │
   │                          │  - Cache actions for reload      │
   │                          │                                  │
```

## ContextTape: Hierarchical Message History

Messages are tagged with their source for hierarchical tracking:

```typescript
type ContextSource = 'main' | { window: string };

interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  source: ContextSource;
}
```

**Usage:**
- **Main agent prompt**: Does not inject ContextTape (relies on provider session continuity)
- **Window agent first turn**: Injects last 3 main conversation turns via `buildWindowInitialContext()`
- **Window close**: Prunes that window's messages from the tape
- **Session restore**: ContextTape can be restored from a previous session's log

## InteractionTimeline

A chronological timeline interleaving user-originated events and AI agent action summaries. The main agent drains this on its next turn to see everything that happened while it was idle.

```
User closes window → pushUser({ type: 'window.close', windowId: '...' })
Window agent runs  → pushAI(role, task, actions, windowId)
Ephemeral agent    → pushAI(role, task, actions)
Task agent runs    → pushAI(role, task, actions)

Main agent's turn  → timeline.format() → drain()
  Produces:
  <timeline>
  <ui:close>settings-win</ui:close>
  <ai agent="window-main-win">Created window "chart". Updated content.</ai>
  </timeline>
```

## Policies

### MainQueuePolicy
FIFO queue (max 10) per monitor for main tasks when the main agent is busy and no ephemeral agent can be created. Mutual exclusion ensures the queue is drained sequentially.

### WindowQueuePolicy
Per-window queues. Tasks for the same window are serialized (one active at a time). Tasks for different windows run in parallel. Parallel button actions (`actionId`) bypass the queue.

### ContextAssemblyPolicy
Builds prompts for both main and window agents:
- **Main**: `timeline + openWindows + reloadOptions + content`
- **Window (first turn)**: `recentMainContext + openWindows + reloadOptions + content`
- **Window (subsequent)**: `openWindows + reloadOptions + content`

### ReloadCachePolicy
Fingerprint-based caching of action sequences. After each task, the actions are recorded with a fingerprint (content hash + window state hash). On the next similar task, matching cached actions are injected as `<reload_options>` so the AI can replay them instantly.

### WindowConnectionPolicy
Tracks window groups. When a window agent creates a child window, the child joins the parent's group. All windows in a group share one agent. The group's agent is only disposed when the last window closes.

### MonitorBudgetPolicy
Per-monitor rate limiting for background monitors. Three budget dimensions:
1. **Concurrent task semaphore** (default: 2, `MONITOR_MAX_CONCURRENT`) — max background monitors running queries simultaneously. Primary monitor bypasses.
2. **Action rate limit** (default: 30 actions/min, `MONITOR_MAX_ACTIONS_PER_MIN`) — sliding 60-second window per monitor.
3. **Output rate limit** (default: 50,000 bytes/min, `MONITOR_MAX_OUTPUT_PER_MIN`) — sliding 60-second window per monitor.

## AgentPool Lifecycle

```
┌───────────────────────────────────────────────────────────────┐
│                         AgentPool                             │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ Main Agents (persistent, one per monitor)              │  │
│   │ - Primary (monitor-0) created at pool init             │  │
│   │ - Additional monitors auto-created on demand (max 4)   │  │
│   │ - Provider session continuity across messages          │  │
│   │ - Recreated on pool reset                              │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ Ephemeral Agents (temporary)                           │  │
│   │ - Created when main is busy + global limit allows      │  │
│   │ - Fresh provider, no conversation context              │  │
│   │ - Disposed immediately after task                      │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ Window Agents (persistent per group/window)            │  │
│   │ - Created on first interaction for a window            │  │
│   │ - Keyed by agentKey (groupId for grouped, windowId     │  │
│   │   for standalone)                                      │  │
│   │ - Disposed when last window in group closes            │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ Task Agents (temporary, forked context)                │  │
│   │ - Created via Task tool (Claude) / collab (Codex)     │  │
│   │ - Forks main agent's provider session                  │  │
│   │ - Profile-specific tools (default/web/code/app)       │  │
│   │ - Disposed immediately after task                      │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                               │
│   Global limit: AgentLimiter (default: 10 concurrent agents)  │
└───────────────────────────────────────────────────────────────┘
```

## Window Agent Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                     Window Agent Lifecycle                        │
│                                                                   │
│   COMPONENT_ACTION / WINDOW_MESSAGE                               │
│        │                                                          │
│        ▼                                                          │
│   WindowConnectionPolicy: resolve agentKey                        │
│   (groupId if window belongs to group, else windowId)             │
│        │                                                          │
│        ▼                                                          │
│   ┌─────────────┐                                                │
│   │ Agent exists │ No ──> getOrCreateWindowAgent(agentKey)        │
│   │ for key?    │        + acquireWarmProvider()                  │
│   └──────┬──────┘                                                │
│          │ Yes                                                    │
│          ▼                                                        │
│   ┌─────────────┐                                                │
│   │ Key busy?   │ Yes ──> WindowQueuePolicy.enqueue()            │
│   │ (non-par.)  │        → MESSAGE_QUEUED                        │
│   └──────┬──────┘                                                │
│          │ No                                                     │
│          ▼                                                        │
│   ┌─────────────────────────────────────────────┐                │
│   │ Process:                                     │                │
│   │  First msg → ContextTape initial context     │                │
│   │  Later msgs → provider session continuity    │                │
│   │                                              │                │
│   │  After completion:                           │                │
│   │  - Record actions → ReloadCache              │                │
│   │  - Connect child windows → group             │                │
│   │  - Push to InteractionTimeline               │                │
│   └─────────────────────────────────────────────┘                │
│                                                                   │
│   Window closed → WindowConnectionPolicy.handleClose()            │
│     ├─ Last in group → disposeWindowAgent() + prune ContextTape  │
│     └─ Others remain → agent survives, prune window's context    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Event Types

### Client → Server

| Event | Description |
|-------|-------------|
| `USER_MESSAGE` | Main input → ContextPool main queue (sequential per monitor) |
| `WINDOW_MESSAGE` | Context menu "Send to window" → Window agent |
| `COMPONENT_ACTION` | Button click with optional formData, componentPath → Window agent |
| `INTERRUPT` | Stop all agents |
| `INTERRUPT_AGENT` | Stop specific agent by role |
| `RESET` | Interrupt all, clear context, recreate main agent |
| `SET_PROVIDER` | Switch AI provider (claude/codex) |
| `RENDERING_FEEDBACK` | Frontend reports window render success/failure |
| `DIALOG_FEEDBACK` | User response to approval dialog |
| `TOAST_ACTION` | User dismisses reload toast (marks cache entry failed) |
| `USER_INTERACTION` | Batch of user interactions (close, focus, move, resize, draw) |
| `APP_PROTOCOL_RESPONSE` | Iframe app's response to an agent query/command |
| `APP_PROTOCOL_READY` | Iframe app has registered with the App Protocol |
| `USER_PROMPT_RESPONSE` | User response to a prompt request |
| `SUBSCRIBE_MONITOR` | Subscribe to events for a specific monitor |
| `REMOVE_MONITOR` | Remove a background monitor |

### Server → Client

| Event | Description |
|-------|-------------|
| `ACTIONS` | Array of OS Actions to execute |
| `AGENT_THINKING` | Agent thinking stream (with agentId) |
| `AGENT_RESPONSE` | Agent response text stream (with agentId, messageId) |
| `CONNECTION_STATUS` | connected/disconnected/error (with provider name) |
| `TOOL_PROGRESS` | Tool execution status (running/complete/error) |
| `ERROR` | Error message (with optional agentId) |
| `WINDOW_AGENT_STATUS` | Window agent lifecycle: assigned/active/released |
| `MESSAGE_ACCEPTED` | Message assigned to an agent |
| `MESSAGE_QUEUED` | Message queued (agent busy or limit reached) |
| `APPROVAL_REQUEST` | Permission dialog for user approval |
| `APP_PROTOCOL_REQUEST` | Agent requesting state/command from an iframe app |

## Shared Session Logger

All agents share a single `SessionLogger` for unified history:

```
session_logs/
└── ses-1739000000000-abc1234/
    ├── metadata.json     # Session metadata (provider, threadIds)
    └── messages.jsonl    # All messages from all agents
```

Each log entry includes `agentId` for filtering:

```json
{"type":"user","content":"Hello","agentId":"main-msg-1","source":"main"}
{"type":"assistant","content":"Hi!","agentId":"main-msg-1","source":"main"}
{"type":"user","content":"Click Save","agentId":"window-settings","source":{"window":"settings"}}
{"type":"assistant","content":"Saved","agentId":"window-settings","source":{"window":"settings"}}
```

## Key Files

| File | Purpose |
|------|---------|
| `session/live-session.ts` | LiveSession + SessionHub — session lifecycle, multi-connection |
| `agents/context-pool.ts` | ContextPool — unified task orchestration |
| `agents/agent-pool.ts` | AgentPool — manages main (per monitor), ephemeral, window, and task agents |
| `agents/session.ts` | AgentSession — individual agent with provider + stream mapping |
| `agents/context.ts` | ContextTape — hierarchical message history |
| `agents/interaction-timeline.ts` | InteractionTimeline — user + AI event chronicle |
| `agents/limiter.ts` | AgentLimiter — global semaphore for agent limit |
| `agents/session-policies/` | StreamToEventMapper, ProviderLifecycleManager, ToolActionBridge |
| `agents/context-pool-policies/` | MainQueue, WindowQueue, ContextAssembly, ReloadCache, WindowConnection, MonitorBudget |
| `providers/factory.ts` | Provider auto-detection and creation |
| `providers/warm-pool.ts` | Pre-initialized providers for fast first response |
| `session/broadcast-center.ts` | BroadcastCenter — routes events to all connections in a session |
| `mcp/action-emitter.ts` | ActionEmitter — bridges MCP tools to agent sessions |
| `mcp/window-state.ts` | WindowStateRegistry — tracks open windows per session |
| `mcp/domains.ts` | Domain allowlist for HTTP tools and sandbox fetch |
| `mcp/skills/` | Dynamic reference docs via `skill` tool (app_dev, sandbox, components, host_api, app_protocol) |
| `mcp/dev/` | App development tools (write_ts, read_ts, apply_diff_ts, compile, typecheck, deploy, clone, write_json) |
| `mcp/browser/` | Browser automation tools via CDP (open, click, type, press, scroll, screenshot, extract, close) |
| `mcp/user/` | User prompt tools (ask, request) |
| `mcp/window/app-protocol.ts` | App Protocol tools (app_query, app_command) |

## Example: Concurrent Execution

```
Timeline:
──────────────────────────────────────────────────────────────────────────>

User types "Hello"          User clicks Save in Window A
       │                              │
       ▼                              ▼
┌──────────────┐              ┌──────────────┐
│ Main Agent   │              │ Window Agent │
│ (monitor-0)  │              │ (group-A)    │
│              │              │              │
│ Processing   │              │ First turn:  │
│ "Hello" with │              │ ContextTape  │
│ full session │              │ initial ctx  │
│ history      │              │              │
│              │              │ Processing   │
│              │              │ Save action  │
└──────┬───────┘              └──────┬───────┘
       │                              │
       ▼                              ▼
   Response                    Response updates
   to user                     Window A
                                    │
                                    ▼
                         InteractionTimeline records:
                         "window-A: Updated content"
                         (main agent sees this next turn)
```
