# Main Orchestrator: Splitting the Monolithic Agent

## Problem Statement

Today's main agent is a monolith. A single, long-lived provider session interprets user intent, creates windows, fetches HTTP data, executes JavaScript, manages storage, reads app skills, and builds interactive UI — all within one heavyweight context.

This causes three concrete problems:

1. **Token bloat.** Every tool's schema, every guideline, and every cached action sequence sits in the main agent's context window for every turn — even when the user just says "hello." The system prompt alone runs thousands of tokens before any conversation begins, and it grows as tool descriptions get richer.

2. **Serialization bottleneck.** The main agent processes messages sequentially (via `MainQueuePolicy`). While it spends 10+ seconds fetching an API, rendering markdown, and building a window, the user's next message waits in the queue. Ephemeral agents exist as an escape hatch, but they lack conversation history and produce disjointed responses.

3. **Unclear responsibility boundaries.** The main agent decides *what* to do and *how* to do it in the same turn. When it fails at HTTP fetching, it's unclear whether the problem is misunderstood intent or a transient network error. Retries, fallbacks, and error recovery all happen in one undifferentiated stream.

The goal: redesign the main agent as a slim **orchestrator** that interprets intent and delegates execution to focused **task agents**.

---

## Design Overview

```
                         ┌─────────────────────────┐
                         │      Orchestrator        │
                         │  (lightweight, persistent)│
                         │                          │
                         │  - Interprets intent     │
                         │  - Fast-paths trivial    │
                         │  - Dispatches tasks      │
                         │  - Synthesizes results   │
                         └────────┬────────┬────────┘
                                  │        │
                    ┌─────────────┘        └──────────────┐
                    ▼                                      ▼
          ┌──────────────────┐                  ┌──────────────────┐
          │   Task Agent A   │                  │   Task Agent B   │
          │  (ephemeral)     │                  │  (ephemeral)     │
          │                  │                  │                  │
          │  - HTTP fetch    │                  │  - run_js        │
          │  - Window create │                  │  - Window create │
          │  - Storage write │                  │  - Storage write │
          └──────────────────┘                  └──────────────────┘
```

The orchestrator keeps the conversation. Task agents do the work. The split is clean: the orchestrator never calls `http_get` or `run_js`; task agents never see the conversation history.

This fits naturally into the existing `ContextPool` architecture. The orchestrator *is* the main agent (persistent, session-continuous). Task agents are a new category alongside ephemeral and window agents — short-lived, objective-scoped, and disposable.

---

## Agent Taxonomy

| Property | Orchestrator | Task Agent | Window Agent |
|---|---|---|---|
| **Lifetime** | Persistent (session) | Ephemeral (one task) | Persistent (window group) |
| **Context** | Full conversation via provider session continuity | Objective string only (self-contained) | First turn: recent main context from ContextTape; then session continuity |
| **Tools** | `dispatch_task`, `window.*` (read-only), `memorize`, `get_info`, `guideline` | Domain-specific subset (see Tool Assignment) | Full tool set (same as today) |
| **Concurrency** | Sequential per monitor (unchanged) | Parallel — multiple task agents can run simultaneously | Parallel across windows, sequential within |
| **Provider session** | Resumed across turns | Fresh provider, no history | Resumed across turns within window group |
| **InteractionTimeline** | Drains on each turn (unchanged) | Pushes summary on completion | Pushes summary on completion |
| **Identity** | `main-{monitorId}-{messageId}` (unchanged) | `task-{messageId}-{index}` (new) | `window-{windowId}` (unchanged) |

Window agents are **unchanged** by this design. They continue to handle `COMPONENT_ACTION` and `WINDOW_MESSAGE` events with their own persistent provider sessions.

---

## Tool Assignment

### Orchestrator keeps

These tools support intent interpretation and lightweight responses:

| Tool | Why |
|---|---|
| `dispatch_task` | **New.** Core dispatch mechanism |
| `window.list` | Read current desktop state for decision-making |
| `window.view` | Inspect window content before deciding what to do |
| `window.close` | Close windows directly (simple, no computation) |
| `show_notification` | Quick user feedback without a task agent |
| `dismiss_notification` | Notification management |
| `get_info` | Session metadata, environment info |
| `memorize` | Persist user preferences / facts |
| `guideline` | Load reference docs to inform dispatch decisions |
| `reload_cached` | Replay cached action sequences directly |
| `list_reload_options` | Check cache before dispatching |
| `set_config` / `get_config` / `remove_config` | Config hooks |

### Task agents receive (per-dispatch)

Task agents receive a **subset** of tools based on the dispatch objective. The orchestrator doesn't explicitly pick tools — the task agent's system prompt and MCP server configuration determine what's available. Initially, all task agents get the same full execution tool set:

| Tool | Purpose |
|---|---|
| `window.create` | Build UI |
| `window.create_component` | Build interactive component UI |
| `window.update` | Modify existing windows |
| `window.update_component` | Modify existing component windows |
| `window.lock` / `window.unlock` | Prevent concurrent modification |
| `window.list` / `window.view` | Inspect desktop state |
| `show_notification` / `dismiss_notification` | User feedback |
| `http_get` / `http_post` | External API calls |
| `request_allowing_domain` | Domain allowlisting |
| `run_js` | Sandboxed JavaScript execution |
| `storage.read` / `storage.write` / `storage.list` / `storage.delete` | Persistent storage |
| `apps.list` / `apps.load_skill` / `apps.read_config` / `apps.write_config` | App system |
| `apps.write_ts` / `apps.compile` / `apps.deploy` / ... | App development |
| `guideline` | Reference docs |
| `get_info` / `get_env_var` | Environment info |

**Not available to task agents:** `dispatch_task` (no recursive dispatch), `memorize` (orchestrator-only), `set_config` / `get_config` / `remove_config` (orchestrator-only), `reload_cached` / `list_reload_options` (orchestrator-only, cache operates at the turn level).

---

## Decision Model

The orchestrator classifies each user message into one of two paths:

```
User message arrives
       │
       ▼
┌──────────────────┐
│ Is this trivial / │     Yes    ┌────────────────────┐
│ conversational?   ├──────────>│  FAST PATH          │
│                   │           │  Respond directly    │
└────────┬─────────┘           │  (no dispatch)       │
         │ No                  └────────────────────────┘
         ▼
┌──────────────────┐
│ Single objective  │     Yes    ┌────────────────────┐
│ or multiple?      ├──────────>│  SINGLE DISPATCH    │
│                   │           │  dispatch_task(...)  │
└────────┬─────────┘           └────────────────────────┘
         │ Multiple
         ▼
┌────────────────────┐
│  PARALLEL DISPATCH  │
│  dispatch_task(...) │
│  dispatch_task(...) │
└─────────────────────┘
```

### Fast path criteria

The orchestrator handles the message directly (no task agent) when:

- **Conversational**: greetings, clarifying questions, chitchat ("hello", "what can you do?")
- **Memory**: "remember that I prefer dark mode" → `memorize` tool
- **Status queries**: "what windows are open?" → `window.list`
- **Cache hits**: reload options match with high similarity → `reload_cached`
- **Simple window management**: "close that window" → `window.close`
- **Notifications**: "remind me in 5 minutes" → `show_notification`
- **Config**: "run moltbook on startup" → `set_config`

### Dispatch criteria

The orchestrator dispatches when the message requires **execution** — tool calls that produce output, fetch data, or build UI:

- "Show me the weather" → dispatch: HTTP fetch + window create
- "Run this code: ..." → dispatch: `run_js` + window create
- "Open moltbook" → dispatch: `load_skill` + follow skill instructions
- "Build me a todo app" → dispatch: `write_ts` + `compile` + `deploy`
- "Fetch the API and show results in a table" → dispatch: HTTP + window create

### Parallel dispatch

When the user's request decomposes into independent sub-tasks:

- "Show me the weather in Tokyo and the news from BBC" → two dispatches (HTTP+window each)
- "Create a settings window and a dashboard window" → two dispatches (window create each)

The orchestrator uses its judgment. Not every multi-part request needs parallel dispatch — "fetch data and display it" is a single sequential task.

---

## `dispatch_task` Interface

A new MCP tool registered on the `system` server.

### Schema

```typescript
{
  name: "dispatch_task",
  description: "Dispatch an objective to a task agent for execution. " +
    "The task agent receives the objective string as its complete context — " +
    "include all relevant details (URLs, IDs, user preferences, window IDs to update). " +
    "The task agent has access to execution tools (HTTP, JS, window create/update, storage, apps) " +
    "but no conversation history.",
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description:
          "Self-contained task description. Must include everything the task agent " +
          "needs: what to do, relevant data, target window IDs, formatting preferences. " +
          "The task agent has no access to conversation history."
      },
      hint: {
        type: "string",
        description:
          "Optional short label for logging/debugging (e.g., 'weather-fetch', 'code-runner'). " +
          "Does not affect behavior.",
      },
    },
    required: ["objective"],
  },
}
```

### Return type

The tool returns a structured result to the orchestrator:

```typescript
interface DispatchResult {
  status: "completed" | "failed" | "interrupted";
  /** Summary of actions taken (same format as InteractionTimeline entries) */
  summary: string;
  /** List of OS actions emitted (window.create, notification.show, etc.) */
  actions: { type: string; windowId?: string; title?: string }[];
  /** Error message if status is "failed" */
  error?: string;
}
```

Example return (success):
```json
{
  "status": "completed",
  "summary": "Created window \"weather-tokyo\" (markdown). Fetched weather data from api.weather.com.",
  "actions": [
    { "type": "window.create", "windowId": "weather-tokyo", "title": "Tokyo Weather" }
  ]
}
```

Example return (failure):
```json
{
  "status": "failed",
  "summary": "HTTP request to api.weather.com failed with 503.",
  "actions": [],
  "error": "Service unavailable (503). The weather API is temporarily down."
}
```

The orchestrator can then decide whether to relay the error, retry, or try a different approach — decisions that belong to the intent layer, not the execution layer.

---

## Task Agent Lifecycle

```
Orchestrator calls dispatch_task(objective, hint?)
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ 1. ACQUIRE                                                │
│    AgentPool.createTaskAgent()                            │
│    - Acquire slot from AgentLimiter                       │
│    - Get warm provider from WarmPool                      │
│    - No session resumption (always fresh)                 │
│                                                           │
│ 2. CONFIGURE                                              │
│    - Assign role: "task-{messageId}-{index}"              │
│    - Set task agent system prompt (execution-focused)     │
│    - Register with SessionLogger                          │
│                                                           │
│ 3. EXECUTE                                                │
│    AgentSession.handleMessage(objective, { role, ... })   │
│    - Task agent processes objective                       │
│    - Calls tools (HTTP, window, storage, etc.)            │
│    - Actions broadcast to frontend via BroadcastCenter    │
│    - Orchestrator is NOT blocked — can process other      │
│      dispatch_task calls in parallel (provider allows     │
│      concurrent tool calls)                               │
│                                                           │
│ 4. REPORT                                                 │
│    - Collect recorded actions from AgentSession           │
│    - Summarize actions (same logic as InteractionTimeline) │
│    - Return DispatchResult to orchestrator                │
│                                                           │
│ 5. DISPOSE                                                │
│    AgentPool.disposeTaskAgent(agent)                      │
│    - Release AgentLimiter slot                            │
│    - Dispose provider                                     │
│    - Push summary to InteractionTimeline                  │
└──────────────────────────────────────────────────────────┘
```

### Concurrency

Multiple task agents can run in parallel when the orchestrator issues multiple `dispatch_task` calls. This is possible because:

- The AI provider supports parallel tool execution (Claude calls multiple tools in one turn)
- Each task agent has its own provider session
- `AgentLimiter` gates the total concurrent agent count (default: 10)

If the agent limit is reached, the `dispatch_task` call blocks until a slot frees up, or returns a failure if the timeout expires.

### Connection to existing types

Task agents slot into the `AgentPool` alongside the existing three types:

```
AgentPool
├── Main Agents: Map<monitorId, PooledAgent>    ← persistent (now "orchestrator")
├── Ephemeral Agents: Set<PooledAgent>           ← existing (may be phased out)
├── Task Agents: Set<PooledAgent>                ← NEW
└── Window Agents: Map<agentKey, PooledAgent>    ← unchanged
```

Task agents differ from ephemeral agents in that:
- They're spawned **by the orchestrator** (not by `ContextPool` when the main is busy)
- They return a structured result to the caller
- They have a focused system prompt (not the full orchestrator prompt)
- They're the primary execution mechanism, not a fallback

Ephemeral agents may eventually be removed once the orchestrator handles all dispatch internally.

---

## Context Strategy: Objective-Only

Task agents receive **no conversation history**. The orchestrator packs all necessary context into the `objective` string passed to `dispatch_task`.

### Why objective-only

1. **Simplicity.** No session forking, no context sharing, no provider-specific thread management.
2. **Token efficiency.** Task agents only see what they need for their specific objective.
3. **Isolation.** Task agent failures don't corrupt the orchestrator's conversation state.
4. **Provider-agnostic.** Works identically with Claude (session resumption) and Codex (thread forking) without provider-specific plumbing.

### What the orchestrator includes in the objective

The orchestrator is responsible for distilling the conversation into a self-contained objective string. Examples:

**User says:** "Can you check the weather in Tokyo?"

**Orchestrator dispatches:**
```
Fetch the current weather for Tokyo, Japan using a public weather API.
Display the result in a new window with ID "weather-tokyo" using the markdown renderer.
Include: temperature, conditions, humidity, wind speed.
Format as a clean card with the city name as heading.
```

**User says:** "Update that window with the forecast for the next 3 days"

**Orchestrator dispatches (includes window context):**
```
Fetch the 3-day weather forecast for Tokyo, Japan.
Update window "weather-tokyo" (currently showing current weather in markdown format)
with the forecast data appended below the existing content.
Format each day as: date, high/low temperatures, conditions, precipitation chance.
```

The orchestrator knows the window ID from `window.list`, the current content topic from its conversation history, and the user's preference for Tokyo from the earlier turn. It folds all of this into the objective.

### What the task agent's prompt looks like

The task agent receives:
1. A focused system prompt (see System Prompt Sketches below)
2. The open windows context (formatted by `ContextAssemblyPolicy`, assembled by `ContextPool`)
3. The reload options prefix (if any cached matches exist)
4. The objective string

No timeline, no conversation history, no ContextTape content.

---

## Message Flow Diagrams

### Fast Path (direct response)

```
Frontend                 Orchestrator
   │                         │
   │  USER_MESSAGE           │
   │  "hello"                │
   ├────────────────────────>│
   │                         │
   │  MESSAGE_ACCEPTED       │  Classify: conversational
   │<────────────────────────│  → fast path
   │                         │
   │  AGENT_RESPONSE         │  "Hello! How can I help
   │  "Hello! How can..."    │   you today?"
   │<────────────────────────│
   │                         │
```

No task agent created. No tools called. Minimal latency.

### Single Dispatch

```
Frontend               Orchestrator              Task Agent           AI Provider
   │                       │                         │                     │
   │  USER_MESSAGE         │                         │                     │
   │  "show weather        │                         │                     │
   │   in Tokyo"           │                         │                     │
   ├──────────────────────>│                         │                     │
   │                       │                         │                     │
   │  MESSAGE_ACCEPTED     │  Classify: execution    │                     │
   │<──────────────────────│  → dispatch             │                     │
   │                       │                         │                     │
   │  AGENT_THINKING       │  dispatch_task(         │                     │
   │<──────────────────────│   objective: "Fetch..." │                     │
   │                       │   hint: "weather")      │                     │
   │                       │                         │                     │
   │                       │  ┌──── createTaskAgent ─┤                     │
   │                       │  │                      │                     │
   │                       │  │                      │  provider.query()   │
   │                       │  │                      ├────────────────────>│
   │                       │  │                      │                     │
   │  TOOL_PROGRESS        │  │                      │  http_get(weather)  │
   │  "http_get running"   │  │                      │<────────────────────│
   │<──────────────────────│──┘                      │                     │
   │                       │                         │                     │
   │  ACTIONS              │                         │  window.create()    │
   │  [window.create]      │                         │<────────────────────│
   │<──────────────────────│─────────────────────────│                     │
   │                       │                         │                     │
   │                       │  DispatchResult {       │                     │
   │                       │   status: "completed",  │                     │
   │                       │   summary: "Created..." │                     │
   │                       │  }                      │                     │
   │                       │<────────────────────────│                     │
   │                       │                         │                     │
   │                       │  disposeTaskAgent()     │                     │
   │                       │                         │                     │
   │  AGENT_RESPONSE       │                         │                     │
   │  "Here's the weather  │                         │                     │
   │   for Tokyo."         │                         │                     │
   │<──────────────────────│                         │                     │
```

The orchestrator's turn includes: thinking → `dispatch_task` tool call → wait for result → text response. The user sees tool progress and window creation in real time during the dispatch.

### Parallel Dispatch

```
Frontend               Orchestrator           Task Agent A        Task Agent B
   │                       │                       │                    │
   │  USER_MESSAGE         │                       │                    │
   │  "weather in Tokyo    │                       │                    │
   │   and news from BBC"  │                       │                    │
   ├──────────────────────>│                       │                    │
   │                       │                       │                    │
   │  MESSAGE_ACCEPTED     │  Classify: parallel   │                    │
   │<──────────────────────│  → 2 dispatches       │                    │
   │                       │                       │                    │
   │                       │  dispatch_task(       │                    │
   │                       │   "Fetch weather...")  │                    │
   │                       │  dispatch_task(       │                    │
   │                       │   "Fetch BBC news...") │                    │
   │                       │──────────────────────>│                    │
   │                       │─────────────────────────────────────────>│
   │                       │                       │                    │
   │  ACTIONS [window A]   │         http_get()    │     http_get()     │
   │<──────────────────────│<──────────────────────│                    │
   │                       │                       │                    │
   │  ACTIONS [window B]   │                       │                    │
   │<──────────────────────│<──────────────────────────────────────────│
   │                       │                       │                    │
   │                       │  Result A             │                    │
   │                       │<──────────────────────│                    │
   │                       │  Result B             │                    │
   │                       │<──────────────────────────────────────────│
   │                       │                       │                    │
   │  AGENT_RESPONSE       │  dispose A, dispose B │                    │
   │  "Here's Tokyo weather│                       │                    │
   │   and BBC news."      │                       │                    │
   │<──────────────────────│                       │                    │
```

Both task agents run concurrently. The orchestrator collects both results before composing its final response.

### Window Interaction (unchanged)

```
Frontend               Orchestrator              Window Agent
   │                       │                         │
   │  COMPONENT_ACTION     │                         │
   │  { windowId, action } │                         │
   ├───────────────────────│────────────────────────>│
   │                       │                         │
   │  (routed directly by  │                         │
   │   ContextPool, not    │                         │
   │   through orchestrator)                         │
   │                       │                         │
   │  ACTIONS              │                         │
   │  [window.update]      │                         │
   │<────────────────────────────────────────────────│
   │                       │                         │
   │                       │  InteractionTimeline:   │
   │                       │  "window-X: Updated..." │
   │                       │  (orchestrator sees     │
   │                       │   this next turn)       │
```

Window interactions bypass the orchestrator entirely — they go through `ContextPool.handleWindowTask()` as they do today. The orchestrator learns about window agent activity through the InteractionTimeline on its next turn.

---

## System Prompt Sketches

### Orchestrator prompt

```
You are the orchestrator for YAAR, a reactive AI-driven desktop interface.

## Your Role
You interpret user intent and either respond directly or dispatch tasks
to specialized task agents. You maintain the conversation — task agents
handle execution.

## When to respond directly (fast path)
- Greetings, questions, conversation
- Memory operations (memorize tool)
- Simple window management (close, list, view)
- Notifications
- Cache replay (reload_cached)
- Config hooks (set_config, get_config, remove_config)

## When to dispatch
- Anything requiring HTTP requests, code execution, or complex UI building
- Use dispatch_task with a self-contained objective string
- Include ALL context the task agent needs: URLs, IDs, preferences, format
- Task agents have no conversation history — your objective IS their context
- For independent sub-tasks, dispatch multiple tasks in parallel

## After dispatch
- Report results naturally to the user
- If a dispatch fails, decide whether to retry, try differently, or explain
- You can see what windows were created via window.list

## Interaction Timeline
[same as current system prompt]

## Desktop Apps
App icon clicks arrive as messages. Load the skill first (via guideline or
dispatch to a task agent) to understand the app before responding.
```

### Task agent prompt

```
You are a task agent for YAAR, a reactive AI-driven desktop interface.

## Your Role
Execute the objective you receive. You have access to tools for building UI,
fetching data, running code, and managing storage. Focus on completing the
objective efficiently.

## Guidelines
- Create windows to display results (prefer visual output)
- Use appropriate renderers: markdown for text, component for interactive UI,
  iframe for web content
- If the objective mentions a window ID, update that window instead of creating new
- Handle errors gracefully — report what failed and why

## Content Rendering
[same renderer guidance as current system prompt]

## Available Context
- You receive open windows state and reload cache options automatically
- You have NO conversation history — your objective contains all context
- If the objective is unclear, do your best with what's given

## Storage
Persistent storage available for user data and files.

## HTTP Access
Use http_get/http_post for API calls. Domains require allowlisting.

## Guidelines
Use guideline(topic) for reference docs: app_dev, sandbox, components.
```

The task agent prompt is significantly shorter than the orchestrator prompt — it doesn't need guidance on intent classification, dispatch strategy, timeline interpretation, memory management, or config hooks.

---

## Error Handling

### Task agent failure

When a task agent encounters an error (HTTP 500, sandbox crash, provider timeout), it returns a `DispatchResult` with `status: "failed"` and an `error` string. The orchestrator then decides:

1. **Relay** — tell the user what happened ("The weather API is down, try again later")
2. **Retry** — dispatch the same objective again (useful for transient errors)
3. **Adapt** — dispatch a modified objective ("Try a different weather API")
4. **Compensate** — clean up partial state (close a half-built window)

The orchestrator has full context to make this decision. The task agent does not.

### Agent limit reached

When `AgentLimiter` blocks a `dispatch_task` call:

1. The orchestrator's tool call blocks until a slot opens (same as current `createEphemeral` behavior)
2. If blocked beyond a reasonable timeout, the tool returns `status: "failed"` with `error: "Agent limit reached"`
3. The orchestrator can queue the task for later, inform the user, or try a lighter approach

### Orchestrator interrupted

When the user sends `INTERRUPT`:

1. The orchestrator is interrupted (same as today)
2. All running task agents spawned by this orchestrator are also interrupted
3. Task agents in progress return `status: "interrupted"` to their pending dispatch calls
4. The orchestrator's turn ends; partial results may be lost

### Task agent hangs

If a task agent doesn't complete within a reasonable time:

1. The orchestrator's `dispatch_task` call has an internal timeout
2. On timeout, the task agent is interrupted and disposed
3. The tool returns `status: "failed"` with `error: "Task timed out"`
4. Any windows or state created by the task agent persist (they were already broadcast)

---

## Open Questions

### Session forking as a future option

The objective-only context strategy is simpler but limits what task agents know. A future enhancement could allow the orchestrator to optionally fork its provider session when dispatching, giving the task agent full conversation history. This would be useful for tasks that require deep conversational context (e.g., "continue what we were working on in a background tab").

Session forking is provider-specific:
- **Claude**: Not natively supported. Would require replaying messages into a new session.
- **Codex**: Natively supports `threadFork()` for branching conversations.

This is explicitly deferred — objective-only covers the majority of use cases.

### Ephemeral agent replacement

Today's ephemeral agents serve as overflow when the main agent is busy. With the orchestrator model, the orchestrator is rarely "busy" in the same way — it classifies and dispatches quickly, then waits for results. The main source of blocking is the provider round-trip for classification itself.

Options:
- **Keep ephemeral agents** as a fallback for when the orchestrator is mid-turn and a new message arrives
- **Remove ephemeral agents** and rely on `MainQueuePolicy` — messages queue until the orchestrator's current turn completes
- **Hybrid** — fast-path messages (greetings, simple queries) can be handled by an ephemeral agent while the orchestrator is dispatching

Leaning toward: keep ephemeral agents initially, evaluate removal after measuring orchestrator turn latency.

### Reload cache interaction

The reload cache currently operates at the main agent turn level — it fingerprints the user message + window state and caches the full action sequence. With the orchestrator model:

- **Orchestrator-level cache** — cache the fact that "show weather in Tokyo" maps to a `dispatch_task` call with a specific objective. The orchestrator can replay this via `reload_cached` without dispatching.
- **Task-level cache** — cache the task agent's action sequence (HTTP response + window create). The task agent can replay via its own reload options.
- **Both** — orchestrator-level for exact matches, task-level for partial matches.

The current architecture supports both levels. The orchestrator receives `<reload_options>` and can call `reload_cached` on the fast path. Task agents also receive reload options via `ContextAssemblyPolicy`.

### Dispatch nesting and recursion

Task agents explicitly cannot call `dispatch_task` — no recursive dispatch. If a task agent's objective turns out to require sub-delegation, the design is:

1. The task agent completes what it can and reports partial results
2. The orchestrator inspects the result and dispatches follow-up tasks if needed

This keeps the execution graph flat (depth 1) and avoids runaway agent spawning.

### Orchestrator-to-window-agent boundary

When the orchestrator dispatches a task that creates a window, and the user later clicks a button in that window, the window agent handles it — not the orchestrator or the original task agent (which is already disposed). This is unchanged from today's behavior.

The question is: should the orchestrator be able to dispatch a task *to* an existing window agent? For now, no. Window agents handle `COMPONENT_ACTION` and `WINDOW_MESSAGE` events. The orchestrator dispatches objectives to fresh task agents. These are separate paths through `ContextPool`.
