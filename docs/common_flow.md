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
│  │  │  └────────────┘  └─────────────┘  └──────────────────┘  │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌──────────────────────────────────────────────────┐    │  │  │
│  │  │  │ Policies                                         │    │  │  │
│  │  │  │ MainQueue(per monitor) · WindowQueue ·           │    │  │  │
│  │  │  │ ContextAssembly · ReloadCache · WindowConnection │    │  │  │
│  │  │  └──────────────────────────────────────────────────┘    │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Agent Types

### 1. Main Agent

The single persistent agent handling the main conversation flow. Maintains provider session continuity across messages.

- **Role**: `main-{messageId}` (set per-message)
- **Creation**: One main agent created when ContextPool initializes (uses a pre-warmed provider)
- **Session**: Resumes the same provider session across messages for full conversation history
- **Canonical ID**: `default`

### 2. Ephemeral Agent

A temporary agent spawned when the main agent is busy and a new main task arrives. Gets a fresh provider with no conversation history, and is disposed immediately after the task completes.

- **Role**: `ephemeral-{messageId}`
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

## Message Flow

### User Message → Main Agent

```
Frontend                    Server                          AI Provider
   │                          │                                  │
   │  USER_MESSAGE            │                                  │
   ├─────────────────────────>│                                  │
   │                          │  Main agent idle?                │
   │                          │  ├─ Yes: processMainTask()       │
   │                          │  └─ No: createEphemeral()        │
   │                          │       or queue if limit reached  │
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

Main agent's turn  → timeline.format() → drain()
  Produces:
  <timeline>
  <interaction:user>close:settings-win</interaction:user>
  <interaction:AI agent="window-main-win">Created window "chart". Updated content.</interaction:AI>
  </timeline>
```

## Policies

### MainQueuePolicy
FIFO queue (max 10) for main tasks when the main agent is busy and no ephemeral agent can be created. Mutual exclusion ensures the queue is drained sequentially.

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

## AgentPool Lifecycle

```
┌───────────────────────────────────────────────────────────────┐
│                         AgentPool                             │
│                                                               │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ Main Agent (persistent, first created)                  │  │
│   │ - Created once at pool initialization                  │  │
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
| `USER_MESSAGE` | Main input → ContextPool main queue (sequential) |
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
└── 2026-02-08_14-38-08/
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
| `session/event-sequencer.ts` | EventSequencer — monotonic seq for event replay |
| `agents/context-pool.ts` | ContextPool — unified task orchestration |
| `agents/agent-pool.ts` | AgentPool — manages main (per monitor), ephemeral, and window agents |
| `agents/session.ts` | AgentSession — individual agent with provider + stream mapping |
| `agents/context.ts` | ContextTape — hierarchical message history |
| `agents/interaction-timeline.ts` | InteractionTimeline — user + AI event chronicle |
| `agents/limiter.ts` | AgentLimiter — global semaphore for agent limit |
| `agents/session-policies/` | StreamToEventMapper, ProviderLifecycleManager, ToolActionBridge |
| `agents/context-pool-policies/` | MainQueue, WindowQueue, ContextAssembly, ReloadCache, WindowConnection |
| `providers/factory.ts` | Provider auto-detection and creation |
| `providers/warm-pool.ts` | Pre-initialized providers for fast first response |
| `websocket/broadcast-center.ts` | BroadcastCenter — routes events to all connections in a session |
| `mcp/action-emitter.ts` | ActionEmitter — bridges MCP tools to agent sessions |
| `mcp/window-state.ts` | WindowStateRegistry — tracks open windows per session |
| `mcp/domains.ts` | Domain allowlist for HTTP tools and sandbox fetch |
| `mcp/guidelines/` | Dynamic reference docs (app_dev, sandbox, components) |
| `mcp/app-dev/` | App development tools (write, read, diff, compile, deploy, clone) |
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
│              │              │ (group-A)    │
│ Processing   │              │              │
│ "Hello" with │              │ First turn:  │
│ full session │              │ ContextTape  │
│ history      │              │ initial ctx  │
│              │              │              │
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
