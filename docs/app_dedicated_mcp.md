# App Agent MCP Tools

App agents use a dedicated `app` MCP server (`mcp__app__*`) instead of the generic `yaar://` verb tools.

## Why not `yaar://` verbs?

The verb tools (`describe`, `read`, `list`, `invoke`, `delete`) are generic — they dispatch to handler files via URI routing. App agents only need two operations (`app_query` and `app_command`), both targeting their own window. Routing these through the verb system would mean:

1. **The agent must know its windowId** to construct `invoke('yaar://windows/{windowId}', { action: "app_query", ... })`. With dedicated tools, the server resolves the window from `AsyncLocalStorage` — the agent just calls `app_query(stateKey)`.

2. **Tool filtering is coarser.** `allowedTools: ['mcp__verbs__invoke']` would grant access to *all* `invoke` targets (`yaar://storage/*`, `yaar://sandbox/*`, etc.). Dedicated tools let us restrict to exactly `app_query`, `app_command`, and `relay`.

3. **Simpler prompts.** The verb system requires explaining URI namespaces, verb semantics, and payload shapes. Dedicated tools have self-describing schemas — no discovery round-trip needed.

## Tools

| Tool | Description |
|------|-------------|
| `app_query(stateKey?)` | Read app state. WindowId resolved from AsyncLocalStorage context. |
| `app_command(command, params?)` | Execute an app command. WindowId resolved automatically. |
| `relay(message)` | Enqueue a message to the main agent for out-of-scope requests. |

## Registration

The `app` server is registered in `CORE_SERVERS` (`mcp/server.ts`) and tools are defined in `mcp/app-agent/index.ts`. The windowId is set in `AgentContext` (AsyncLocalStorage) by `AppTaskProcessor` before each agent turn, so `getWindowId()` resolves correctly inside tool handlers.
