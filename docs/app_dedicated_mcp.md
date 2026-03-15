# App Agents

## Background

Window agents created unnecessary complexity and context disconnects:

1. **Context disconnect for plain windows**: A window agent handled button clicks and form submissions separately from the monitor agent that created the window. The monitor agent had full conversation context; the window agent started fresh with only a few recent turns.

2. **Context bloat for app windows**: An app's window agent bootstrapped with main conversation history and all verb tools across every `yaar://` namespace. Two discovery round-trips were burned before the agent could do real work.

3. **No app continuity**: Window agents were keyed by windowId. Close the window, lose the agent.

**Solution**: Window agents were removed. Plain window interactions now route to the **monitor agent** (full conversation context). App windows route to persistent **app agents** (keyed by appId, session lifetime) via `AppTaskProcessor`.

## Architecture

| Agent type | Scoped to | Lifecycle |
|------------|-----------|-----------|
| **Monitor agent** | A monitor (virtual desktop) | Monitor lifetime |
| **App agent** | An app (by appId) | Session lifetime |

App agents are persistent per-app — closing and reopening the same app reuses the same agent with full conversation history.

## App Agent MCP Tools

App agents use a dedicated `app` MCP server (`mcp__app__*`) instead of the generic `yaar://` verb tools.

### Why not `yaar://` verbs?

The verb tools (`describe`, `read`, `list`, `invoke`, `delete`) are generic — they dispatch to handler files via URI routing. App agents only need two operations (`query` and `command`), both targeting their own window. Routing these through the verb system would mean:

1. **The agent must know its windowId** to construct `invoke('yaar://windows/{windowId}', { action: "query", ... })`. With dedicated tools, the server resolves the window from `AsyncLocalStorage` — the agent just calls `query(stateKey)`.

2. **Tool filtering is coarser.** `allowedTools: ['mcp__verbs__invoke']` would grant access to *all* `invoke` targets (`yaar://storage/*`, `yaar://sandbox/*`, etc.). Dedicated tools let us restrict to exactly `query`, `command`, and `relay`.

3. **Simpler prompts.** The verb system requires explaining URI namespaces, verb semantics, and payload shapes. Dedicated tools have self-describing schemas — no discovery round-trip needed.

### Tools

| Tool | Description |
|------|-------------|
| `query(stateKey?)` | Read app state. WindowId resolved from AsyncLocalStorage context. |
| `command(command, params?)` | Execute an app command. WindowId resolved automatically. |
| `relay(message)` | Enqueue a message to the monitor agent for out-of-scope requests. |

### Registration

The `app` server is registered in `CORE_SERVERS` (`mcp/server.ts`) and tools are defined in `mcp/app-agent/index.ts`. The windowId is set in `AgentContext` (AsyncLocalStorage) by `AppTaskProcessor` before each agent turn, so `getWindowId()` resolves correctly inside tool handlers.

## Remaining Work

The "main agent" → "monitor agent" rename has been completed. No pending work.
