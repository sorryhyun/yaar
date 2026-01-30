# Agent Architecture: Pools, Forks, and Message Flow

This document describes how ClaudeOS manages multiple concurrent AI agents through pooling and forking mechanisms.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WebSocket Connection                            │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         SessionManager                               │   │
│  │                                                                       │   │
│  │   ┌───────────────────────┐      ┌──────────────────────────────┐   │   │
│  │   │   DefaultAgentPool    │      │      Window Sessions         │   │   │
│  │   │                       │      │                              │   │   │
│  │   │  ┌─────┐ ┌─────┐     │      │  window-1 ──┐                │   │   │
│  │   │  │ A0  │ │ A1  │ ... │      │  window-2 ──┼── Fork from    │   │   │
│  │   │  └─────┘ └─────┘     │      │  window-3 ──┘   Default      │   │   │
│  │   │     │                 │      │                              │   │   │
│  │   │     └── Shared Logger │      │       └── Shared Logger      │   │   │
│  │   └───────────────────────┘      └──────────────────────────────┘   │   │
│  │                                                                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Agent Types

### 1. Default Agent (via DefaultAgentPool)

The primary agent that handles user input from the main input field.

- **ID**: `'default'`
- **Creation**: Automatically created when WebSocket connects
- **Pooling**: Multiple agents can exist in the pool for concurrent messages
- **Session ID**: Assigned by Claude Agent SDK on first message

```typescript
// packages/server/src/default-agent-pool.ts
const POOL_CONFIG = {
  maxAgents: 3,      // Maximum concurrent agents
  maxQueueSize: 10,  // Queue limit before backpressure
  idleTimeoutMs: 300000, // Cleanup idle agents after 5 min
};
```

### 2. Window Agent

Spawned for specific windows via button clicks or context menu actions.

- **ID**: `'window-{windowId}'`
- **Creation**: On first `COMPONENT_ACTION` (button click) or `WINDOW_MESSAGE` for that window
- **Forking**: Inherits conversation context from the default agent
- **Limit**: Maximum 5 window agents per connection

### 3. Subagent

Spawned by default/window agents via Claude Agent SDK's native subagent feature.

- **ID**: Assigned by SDK
- **Creation**: Agent SDK handles this internally via the `Task` tool
- **Context**: Inherits from parent agent's conversation

## Message Flow

### User Message → Default Agent Pool

```
Frontend                    Server                      AI Provider
   │                          │                              │
   │  USER_MESSAGE            │                              │
   ├─────────────────────────>│                              │
   │                          │  Find idle agent             │
   │                          │  or spawn new one            │
   │                          │                              │
   │                          │  query(prompt, {             │
   │                          │    sessionId,                │
   │                          │    systemPrompt              │
   │                          │  })                          │
   │                          ├─────────────────────────────>│
   │                          │                              │
   │  AGENT_THINKING          │<─────────────────────────────│
   │<─────────────────────────│  Stream messages             │
   │                          │                              │
   │  AGENT_RESPONSE          │<─────────────────────────────│
   │<─────────────────────────│                              │
   │                          │                              │
```

### Button Click → Window Agent (Fork)

```
Frontend                    Server                      AI Provider
   │                          │                              │
   │  COMPONENT_ACTION        │                              │
   │  { windowId, action }    │                              │
   ├─────────────────────────>│                              │
   │                          │                              │
   │                          │  Window agent exists?        │
   │                          │  ├─ Yes: Reuse               │
   │                          │  └─ No: Create + Fork        │
   │                          │                              │
   │  WINDOW_AGENT_STATUS     │  // First message with fork  │
   │  { status: 'created' }   │  query(action, {             │
   │<─────────────────────────│    sessionId: parentId,      │
   │                          │    forkSession: true         │
   │                          │  })                          │
   │                          ├─────────────────────────────>│
   │                          │                              │
   │  AGENT_RESPONSE          │  // SDK creates new session  │
   │<─────────────────────────│  // with parent's context    │
   │                          │                              │
```

## Session Forking

When a window agent is created, it **forks** from the default agent's session:

```typescript
// packages/server/src/agent-session.ts

// On first message of a forked session:
const shouldFork = !this.hasSentFirstMessage && !!this.forkFromSessionId;

const options: TransportOptions = {
  systemPrompt: SYSTEM_PROMPT,
  sessionId: shouldFork ? this.forkFromSessionId : this.sessionId,
  forkSession: shouldFork ? true : undefined,
};
```

### What Forking Does

1. **Context Inheritance**: The new session starts with all conversation history from the parent
2. **Independent Execution**: After forking, the window agent runs independently
3. **No Bidirectional Sync**: Changes in window agent don't propagate back to parent

### SDK Implementation

```typescript
// packages/server/src/providers/claude/provider.ts
const sdkOptions: SDKOptions = {
  resume: options.sessionId,        // Parent session ID when forking
  forkSession: options.forkSession, // Creates fork instead of continuing
  // ...
};
```

## Shared Session Logger

All agents share a single `SessionLogger` for unified history:

```typescript
// Default pool creates the logger
const firstAgent = await this.createAgent();
this.sharedLogger = firstAgent.session.getSessionLogger();

// Window agents receive the shared logger
const sharedLogger = this.defaultPool?.getSessionLogger();
session = new AgentSession(ws, undefined, windowId, defaultSessionId, sharedLogger);
```

### Log Structure

```
session_logs/
└── 2026-01-30_14-38-08/
    ├── metadata.json     # Session metadata
    └── messages.jsonl    # All messages from all agents
```

Each log entry includes `agentId` for filtering:

```json
{"timestamp":"...","type":"user","content":"Hello","agentId":"default"}
{"timestamp":"...","type":"assistant","content":"Hi!","agentId":"default"}
{"timestamp":"...","type":"user","content":"Click action","agentId":"window-abc123"}
{"timestamp":"...","type":"assistant","content":"Done","agentId":"window-abc123"}
```

## DefaultAgentPool Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                     DefaultAgentPool                              │
│                                                                   │
│   Message arrives                                                 │
│        │                                                          │
│        ▼                                                          │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│   │ Find idle   │ No  │ Pool full?  │ Yes │ Queue msg   │       │
│   │ agent       ├────>│             ├────>│ (max 10)    │       │
│   └──────┬──────┘     └──────┬──────┘     └─────────────┘       │
│          │ Yes               │ No                                 │
│          ▼                   ▼                                    │
│   ┌─────────────┐     ┌─────────────┐                            │
│   │ Assign to   │     │ Spawn new   │                            │
│   │ idle agent  │     │ agent       │                            │
│   └─────────────┘     │ (max 3)     │                            │
│                       └─────────────┘                            │
│                                                                   │
│   After completion:                                               │
│   - Start idle timer (5 min)                                     │
│   - Process queued messages                                      │
│   - Cleanup idle agents (except first)                           │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Window Agent Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                     Window Agent Lifecycle                        │
│                                                                   │
│   COMPONENT_ACTION / WINDOW_MESSAGE                               │
│        │                                                          │
│        ▼                                                          │
│   ┌─────────────┐                                                │
│   │ Agent       │ No ──> Create AgentSession                     │
│   │ exists?     │        with forkFromSessionId                  │
│   └──────┬──────┘        and sharedLogger                        │
│          │ Yes                    │                               │
│          ▼                        ▼                               │
│   ┌─────────────┐         ┌─────────────┐                        │
│   │ Agent busy? │ Yes ──> │ Queue msg   │                        │
│   └──────┬──────┘         └─────────────┘                        │
│          │ No                                                     │
│          ▼                                                        │
│   ┌─────────────┐                                                │
│   │ Process     │  First msg: fork from parent                   │
│   │ message     │  Subsequent: resume own session                │
│   └─────────────┘                                                │
│                                                                   │
│   Window closed → destroyWindowAgent()                           │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Event Types

### Client → Server

| Event | Description |
|-------|-------------|
| `USER_MESSAGE` | Main input field message → DefaultAgentPool |
| `WINDOW_MESSAGE` | Context menu "Send to window" → Window Agent |
| `COMPONENT_ACTION` | Button click in window → Window Agent |
| `INTERRUPT` | Stop all agents |
| `INTERRUPT_AGENT` | Stop specific agent by ID |

### Server → Client

| Event | Description |
|-------|-------------|
| `AGENT_THINKING` | Agent is processing (with agentId) |
| `AGENT_RESPONSE` | Agent response chunk/complete (with agentId) |
| `WINDOW_AGENT_STATUS` | Window agent created/active/idle/destroyed |
| `MESSAGE_ACCEPTED` | Message assigned to an agent |
| `MESSAGE_QUEUED` | Message queued (agent busy or pool full) |

## Key Files

| File | Purpose |
|------|---------|
| `packages/server/src/session-manager.ts` | Routes messages, manages window agents |
| `packages/server/src/default-agent-pool.ts` | Manages pool of default agents |
| `packages/server/src/agent-session.ts` | Individual agent session with fork support |
| `packages/server/src/providers/claude/provider.ts` | Claude Agent SDK integration |
| `packages/shared/src/events.ts` | Event type definitions |

## Example: Concurrent Execution

```
Timeline:
─────────────────────────────────────────────────────────────────────────────>

User types "Hello"          User clicks button in Window A
       │                              │
       ▼                              ▼
┌──────────────┐              ┌──────────────┐
│ Default Pool │              │ Window Agent │
│ Agent #0     │              │ window-A     │
│              │              │              │
│ Processing   │              │ Fork from    │
│ "Hello"      │              │ default      │
│              │              │              │
│   ...        │              │ Processing   │
│              │              │ button action│
└──────────────┘              └──────────────┘
       │                              │
       ▼                              ▼
   Response                       Response
   to user                        updates
                                  Window A
```

Both agents run in parallel, each with their own AI session but sharing the same session logger for unified history.
