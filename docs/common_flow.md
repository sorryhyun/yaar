# Agent Architecture: Pools, Context, and Message Flow

This document describes how YAAR manages concurrent AI agents through unified pooling, hierarchical context, and policy-based orchestration.

## Delegation Model

The monitor agent acts as an **orchestrator** — it understands user intent, decides the approach, and dispatches work. The design intentionally restricts the monitor agent's tool set to quick actions (windows, notifications, storage reads, memory, config) and gives it a single delegation primitive (Task tool for Claude, collaboration system for Codex).

```
User Request
     │
     ▼
┌──────────────┐
│ Monitor Agent│  Understands intent, decides approach
│ (orchestrator) │
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

**Why delegate by default?** Task agents fork the monitor agent's session (full conversation history) and run with a focused tool set matching their profile. This keeps the monitor agent responsive — it can accept the next user message while subagents work. It also reduces token waste by keeping the monitor agent's turns short and action-oriented.

**What stays on the monitor agent?** Anything that takes 1-2 tool calls using only the monitor agent's tools: showing notifications, opening/updating windows, loading app skills, reading storage, memory operations, config hooks, and cache replay.

## Agent Types

### 1. Monitor Agent

The persistent orchestrator handling the main conversation flow per monitor. Maintains provider session continuity across messages. Has a restricted tool set focused on quick actions and delegation.

- **Role**: `main-{monitorId}-{messageId}` (set per-message)
- **Creation**: One per monitor. Primary (`0`) created at pool init with a pre-warmed provider; additional monitors auto-created on demand (max 4)
- **Session**: Resumes the same provider session across messages for full conversation history
- **Canonical ID**: `main-{monitorId}`
- **URI**: `yaar://agents/{instanceId}` — see [URI-Based Resource Addressing](./verbalized-with-uri.md)
- **Tools**: Windows, notifications, storage read/list, memory, skills, config hooks, cache replay, Task (delegation)

### 2. Ephemeral Agent

A temporary agent spawned when the monitor agent is busy and a new main task arrives. Gets a fresh provider with no conversation history, and is disposed immediately after the task completes.

- **Role**: `ephemeral-{monitorId}-{messageId}`
- **Creation**: On demand when monitor agent is busy (limited by global `AgentLimiter`)
- **Context**: No conversation history — receives open windows + reload options + task content
- **Lifecycle**: Created → process task → push to InteractionTimeline → disposed

### 3. App Agent

A persistent agent for handling interactions within app windows. One agent per app (`appId`), surviving window close and reopen.

- **Role**: `app-{appId}-{messageId}` (set per-message)
- **Creation**: On first `COMPONENT_ACTION` or `WINDOW_MESSAGE` targeting an app window
- **Context**: First interaction bootstraps with app skill and manifest; subsequent interactions use provider session continuity
- **Scope**: Scoped to the app's `appId` — all windows for the same app share one agent
- **Canonical ID**: `app-{appId}`
- **URI**: `yaar://agents/{instanceId}` — see [URI-Based Resource Addressing](./verbalized-with-uri.md)

### 4. Task Agent

A temporary agent spawned by the monitor agent to handle delegated work. Forks the monitor agent's provider session (inheriting full conversation context) and runs with a profile-specific tool subset and system prompt.

- **Role**: `task-{messageId}-{timestamp}`
- **Creation**: Via Task tool (Claude) or collaboration system (Codex). Limited by global `AgentLimiter`
- **Context**: Forks monitor agent's session — inherits full conversation history
- **Profiles**: `default` (all tools), `web` (HTTP + search), `code` (code execution), `app` (dev + deploy)
- **Lifecycle**: Created → process objective → push to InteractionTimeline → disposed
- **Parallel**: Multiple task agents can run concurrently for independent sub-tasks

### 5. Session Agent

A lazy, on-demand supervisor for cross-monitor oversight and coordination. Singleton per session, created on first invocation via `yaar://sessions/current/agents/session`.

- **Role**: `session-{action}-{timestamp}`
- **Creation**: Lazy — created when first invoked (audit, coordinate, or query). Not present at session start.
- **Context**: Maintains provider session continuity across invocations (like monitor agents)
- **Tools**: Verb tools only (describe, read, list, invoke, delete) — no WebSearch, no Task
- **Scope**: Session-wide. Can read all monitor states and invoke control actions (suspend/resume/interrupt)
- **No monitor**: Doesn't belong to any monitor. No windows — communicates via tool results and relay messages.

## Monitor Agent ↔ App Agent: Division of Responsibility

The monitor agent and app agents have complementary roles with a clear boundary: the monitor agent is the **generalist orchestrator** that knows the user and conversation; app agents are **specialist operators** that know their app's internal state and commands.

### What the Monitor Agent Knows

- **Full conversation history** — provider session continuity across all messages
- **All open windows** — markdown summary of every window on its monitor
- **User intent** — receives user messages first, decides how to route them
- **App catalog** — can load any app's SKILL.md, create app windows, install/uninstall apps
- **System state** — storage, memory, config, shortcuts, hooks

### What the Monitor Agent Does NOT Know

- App-internal state (spreadsheet cells, browser URL, slide deck contents)
- App-specific commands (how to set cells, navigate browser, insert slides)
- How to communicate with an iframe via app protocol

### What the App Agent Knows

- **App manifest** — state keys and commands declared by the app at registration
- **App skill** — SKILL.md loaded on first interaction (domain knowledge, API docs, workflows)
- **Conversation within the app** — provider session continuity for the app's interaction history

### What the App Agent Does NOT Know

- Other windows, user's broader conversation, system state
- How to search the web, run code, or access tools outside the app's scope
- It uses `relay()` to hand off anything outside its domain to the monitor agent

### The Handoff Pattern

```
User clicks app icon
       │
       ▼
Monitor Agent                          App Agent (created lazily)
  │                                      │
  │  Loads SKILL.md                      │
  │  Creates iframe window               │
  │  (appId, appProtocol: true)          │
  │                                      │
  │  [done — monitor returns to idle]    │
  │                                      │
  │  User clicks button in app ────────> │  First interaction:
  │                                      │  • Bootstrap with SKILL.md + manifest
  │                                      │  • query() app state
  │                                      │  • command() app actions
  │                                      │  • Subsequent interactions reuse session
  │                                      │
  │  <── relay("search the web for X") ──│  Outside app's domain
  │                                      │
  │  Monitor handles the relay           │
  │  (enqueued as a monitor task)        │
  │                                      │
```

### App Protocol: How Agent Talks to Iframe

Apps with `appProtocol: true` in `app.json` declare a self-describing contract — state keys to query and commands to invoke. The agent discovers and uses these dynamically.

```
App Protocol Communication Chain:

Agent calls query('cells') or command('setCells', { data })
  │
  ▼
MCP app-agent tool handler
  │
  ▼
ActionEmitter.emitAppProtocolRequest(windowId, request)
  │  (5-second timeout)
  ▼
WebSocket: APP_PROTOCOL_REQUEST → Frontend
  │
  ▼
Frontend: postMessage → Iframe
  │  yaar:app-query-request / yaar:app-command-request
  ▼
Iframe processes request, responds via postMessage
  │  yaar:app-query-response / yaar:app-command-response
  ▼
Frontend: APP_PROTOCOL_RESPONSE → WebSocket → Server
  │
  ▼
ActionEmitter resolves pending promise → result returned to agent
```

**Registration flow**: When an iframe loads, apps import `{ app } from '@bundled/yaar'` and call `app.register(manifest)` with their capabilities (state keys + commands). The server stores readiness per window, and subsequent `query`/`command` calls proceed without waiting.

### App Agent Tools (Minimal by Design)

App agents have only 3 tools, keeping them focused:

| Tool | Purpose |
|------|---------|
| `query(stateKey?)` | Read app state — omit key for manifest, pass key for specific state |
| `command(command, params?)` | Invoke an app command (e.g., `setCells`, `refresh`, `setTheme`) |
| `relay(message)` | Hand off to monitor agent for anything outside app's domain |

### Complex App Example: DevTool-style Apps

Apps like the browser or slides editor use app protocol for rich bidirectional communication:

```
Browser App (appProtocol: true):
  State: currentUrl, browserId
  Commands: refresh, clear, attach

  Agent flow:
  1. User: "Go to example.com"
  2. App agent: command('refresh', { url: 'https://example.com' })
  3. Iframe: navigates Chrome via CDP, takes screenshot, responds
  4. App agent: sees result, can query('currentUrl') to verify

Slides App (appProtocol: true):
  State: deck, activeSlide, theme, slideCount, ...
  Commands: setDeck, appendSlides, setActiveIndex, setTheme, ...

  Agent flow:
  1. User: "Add 3 slides about AI"
  2. App agent: query('deck') to see current state
  3. App agent: command('appendSlides', { slides: [...] })
  4. Iframe: renders new slides, responds with updated deck
```

The monitor agent never needs to understand these app internals — it just opens the window and lets the app agent handle all interactions.

## Message Flow

### User Message → Monitor Agent

When a user message arrives, the system tries strategies in priority order:

```
USER_MESSAGE arrives for monitorId
│
├─ Monitor agent idle → processMainTask() directly
│
└─ Monitor agent busy:
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
         Success: MESSAGE_QUEUED, processed when monitor agent finishes
         Fail: queue full (10 per monitor)
```

Full flow for direct processing:

```
Frontend                    Server                          AI Provider
   │                          │                                  │
   │  USER_MESSAGE            │                                  │
   ├─────────────────────────>│                                  │
   │                          │  Budget check (background only)  │
   │                          │  Monitor agent idle?             │
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

### Button Click → Monitor Agent or App Agent

```
Frontend                    Server                          AI Provider
   │                          │                                  │
   │  COMPONENT_ACTION        │                                  │
   │  { windowId, action,     │                                  │
   │    actionId?, formData?} │                                  │
   ├─────────────────────────>│                                  │
   │                          │                                  │
   │                          │  App window?                     │
   │                          │  ├─ No: route to monitor agent   │
   │                          │  │   (monitor's main queue)      │
   │                          │  └─ Yes: AppTaskProcessor        │
   │                          │      App agent exists?           │
   │                          │      ├─ Yes: Reuse               │
   │                          │      └─ No: Create (fresh prov.) │
   │                          │                                  │
   │  WINDOW_AGENT_STATUS     │  App agent first message?        │
   │  { status: 'active' }    │  ├─ Yes: bootstrap with skill    │
   │<─────────────────────────│  └─ No: session continuity       │
   │                          │                                  │
   │                          │  provider.query(prompt, {        │
   │                          │    sessionId                     │
   │                          │  })                              │
   │                          ├─────────────────────────────────>│
   │                          │                                  │
   │  AGENT_RESPONSE          │  After completion:               │
   │<─────────────────────────│  - Record to InteractionTimeline │
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
- **Monitor agent prompt**: Does not inject ContextTape (relies on provider session continuity)
- **App agent first turn**: Injects skill context and manifest via `AppTaskProcessor`
- **Window close**: Prunes that window's messages from the tape
- **Session restore**: ContextTape can be restored from a previous session's log

## InteractionTimeline

A chronological timeline interleaving user-originated events and AI agent action summaries. The monitor agent drains this on its next turn to see everything that happened while it was idle.

```
User closes window → pushUser({ type: 'window.close', windowId: '...' })
App agent runs     → pushAI(role, task, actions, windowId)
Ephemeral agent    → pushAI(role, task, actions)
Task agent runs    → pushAI(role, task, actions)

Monitor agent's turn  → timeline.format() → drain()
  Produces:
  <timeline>
  <ui:close>settings-win</ui:close>
  <ai agent="window-main-win">Created window "chart". Updated content.</ai>
  </timeline>
```

## Example: Concurrent Execution

```
Timeline:
──────────────────────────────────────────────────────────────────────────>

User types "Hello"          User clicks Save in App Window
       │                              │
       ▼                              ▼
┌──────────────┐              ┌──────────────┐
│Monitor Agent │              │ App Agent    │
│ (monitor 0)  │              │ (app-notes)  │
│              │              │              │
│ Processing   │              │ First turn:  │
│ "Hello" with │              │ skill + mani-│
│ full session │              │ fest context │
│ history      │              │              │
│              │              │ Processing   │
│              │              │ Save action  │
└──────┬───────┘              └──────┬───────┘
       │                              │
       ▼                              ▼
   Response                    Response updates
   to user                     App window
                                    │
                                    ▼
                         InteractionTimeline records:
                         "app-notes: Updated content"
                         (monitor agent sees this next turn)
```
