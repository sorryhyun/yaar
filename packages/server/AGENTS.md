# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
pnpm dev                    # Start server with ts-node
pnpm build                  # Build for production
```

## Environment Variables

- `PROVIDER` - Force provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000)
- `MAX_AGENTS` - Global agent limit (default: 10)

## Directory Structure

```
src/
├── index.ts           # Thin orchestrator (~35 lines)
├── config.ts          # Constants, paths, MIME types, PORT
├── lifecycle.ts       # initializeSubsystems(), startListening(), shutdown()
├── http/              # HTTP server and route handlers
│   ├── server.ts      # createHttpServer() — CORS, MCP dispatch, route dispatch
│   ├── utils.ts       # sendJson(), sendError(), safePath() helpers
│   └── routes/
│       ├── api.ts     # REST API routes (health, providers, apps, sessions, agents/stats)
│       ├── files.ts   # File-serving routes (pdf, sandbox, app-static, storage)
│       └── static.ts  # Frontend static serving + SPA fallback
├── session/           # Session management (LiveSession, SessionHub, EventSequencer)
├── websocket/         # WebSocket server + connection registry
│   ├── server.ts      # createWebSocketServer() with explicit options param
│   └── broadcast-center.ts  # BroadcastCenter — routes events to all connections in a session
├── agents/            # Agent lifecycle, pooling, context management
├── providers/         # Pluggable AI backends (Claude, Codex)
├── mcp/               # MCP server, domain-organized tools, action emitter
│   ├── index.ts       # Module re-exports
│   ├── server.ts      # MCP server init, request handling, token
│   ├── action-emitter.ts  # ActionEmitter — decouple tools from sessions
│   ├── window-state.ts    # WindowStateRegistry — per-session window state tracking
│   ├── utils.ts       # ok(), okWithImages() response helpers
│   ├── domains.ts     # Domain allowlist for HTTP/sandbox fetch
│   ├── register.ts    # Aggregator: registerAllTools(), getToolNames()
│   ├── system/        # get_info, get_env_var, memorize
│   ├── window/        # create, update, close, lock/unlock, list, view, notifications, app protocol
│   │   ├── create.ts, update.ts, lifecycle.ts, notification.ts, app-protocol.ts
│   ├── storage/       # read, write, list, delete
│   ├── http/          # http_get, http_post, request_allowing_domain
│   │   ├── curl.ts, request.ts, permission.ts
│   ├── sandbox/       # run_js
│   ├── apps/          # list, load_skill, read_config, write_config
│   │   ├── discovery.ts (listApps, loadAppSkill — used by API routes)
│   │   ├── config.ts (credentials, read/write config)
│   └── app-dev/       # write_ts, apply_diff_ts, compile, deploy, clone, write_json
│       ├── helpers.ts, write.ts, compile.ts, deploy.ts
├── logging/           # Session logging (write), reading, and window restore
├── storage/           # StorageManager + permissions for persistent data
└── lib/               # Standalone utilities (no server internal imports)
    ├── bundled-types/ # Per-library .d.ts files for @bundled/* imports (used by apps/tsconfig.json)
    ├── compiler/      # esbuild bundler for sandbox apps
    ├── pdf/           # PDF rendering via poppler
    └── sandbox/       # Sandboxed JS/TS code execution (node:vm)
```

## Architecture

### Session-Centric Architecture

```
SessionHub (singleton registry)
└── LiveSession (per conversation, survives disconnections)
    ├── connections: Map<ConnectionId, WebSocket>   ← multi-tab support
    ├── WindowStateRegistry                         ← server-side window tracking
    ├── ReloadCache                                 ← fingerprint-based action caching
    ├── EventSequencer                              ← monotonic seq for replay
    └── ContextPool (unified pool)
        ├── AgentPool
        │   ├── Main Agents: Map<monitorId, PooledAgent>  ← one per monitor
        │   ├── Ephemeral Agents (temporary, no context)
        │   └── Window Agents: Map<agentKey, PooledAgent>  ← persistent per window/group
        ├── ContextTape (hierarchical message history)
        │   ├── [main] user/assistant messages
        │   └── [window:id] branch messages
        └── Policies (MainQueue per monitor, WindowQueue, ContextAssembly, ...)
```

Key concepts:
- **Session > Monitor > Window**: Three nested abstractions (see `docs/monitor_and_windows_guide.md`)
- **Multi-connection**: Multiple tabs share one LiveSession via SessionHub
- **Per-monitor main agents**: Each monitor has its own main agent and sequential queue
- **Parallel windows**: Window agents run concurrently, serialized per-window
- **Hierarchical context**: Messages tagged with source (main vs window)

### Message Flow

```
WebSocket → LiveSession.routeMessage()
  → ContextPool.handleTask()
  → Monitor's main queue (sequential) or Window handler (parallel)
  → AgentSession.handleMessage(content, { role, source, ... })
  → AITransport.query() [async generator]
  → Tools emit actions via actionEmitter
  → BroadcastCenter.publishToSession()
```

### Key Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| Semaphore | `AgentLimiter` | Global agent limit with queue |
| Pool | `ContextPool` | Unified agent reuse with dynamic roles |
| Warm Pool | `providers/warm-pool.ts` | Pre-initialize providers at startup |
| Context Tape | `ContextTape` | Track messages by source for injection |
| Factory | `providers/factory.ts` | Auto-detect and create providers |
| Observer | `actionEmitter` | Decouple tools from sessions |
| AsyncLocalStorage | `AgentSession` | Track agentId in async context |

## Providers

**AITransport interface:**
- `systemPrompt` - Provider-specific system prompt
- `isAvailable()` - Check if provider can be used
- `query(prompt, options)` - Returns async iterable of StreamMessages
- `interrupt()` - Cancel ongoing query
- `dispose()` - Cleanup resources

**Provider Warm Pool:**
Providers are pre-initialized at server startup for faster first connection:
- `initWarmPool()` - Called at startup, creates and warms up provider instances
- `acquireWarmProvider()` - Gets a pre-warmed provider with session already created
- Pool auto-replenishes in background when providers are acquired
- Stats available via `GET /api/agents/stats` (warmPool field)

**Session Warmup (Claude):**
`ClaudeSessionProvider` sends a "ping" message at startup to pre-create a session:
1. Establishes MCP server connection
2. Loads system prompt into context
3. Gets session ID for resumption
The system prompt includes a handshake protocol: "ping" → "pong"

**Codex provider (`providers/codex/`):**
- `app-server.ts` — Manages `codex app-server` child process. Performs `initialize` handshake on startup. Exposes thread/turn v2 API: `threadStart()`, `threadResume()`, `threadFork()`, `turnStart()`, `turnInterrupt()`. Turn serialization via `acquireTurn()`/`releaseTurn()` (one turn at a time per process since notifications lack thread/turn IDs).
- `types.ts` — Re-exports generated v2 API types (`ThreadStart`, `ThreadResume`, `ThreadFork`, `TurnStart`, `TurnInterrupt`, notification types) from `generated/v2/`. Also provides JSON-RPC base types.
- `provider.ts` — `CodexSessionProvider` implementing `AITransport`.

**Adding a new provider:**
1. Create `src/providers/<name>/provider.ts` implementing `AITransport`
2. Create `src/providers/<name>/system-prompt.ts` with provider-specific prompt
3. Add to `providerLoaders` in `src/providers/factory.ts`
4. Export from `src/providers/<name>/index.ts`

## Tools (MCP)

Tools are organized into domain folders under `mcp/`, each with an `index.ts` that exports a `register*Tools()` function. The aggregator at `mcp/register.ts` wires them to the correct MCP server namespace.

| Domain | MCP Server | Tools |
|--------|-----------|-------|
| `system/` | system | get_info, get_env_var, memorize |
| `http/` | system | http_get, http_post, request_allowing_domain |
| `sandbox/` | system | run_js |
| `window/` | window | create, create_component, update, update_component, close, lock, unlock, list, view, show_notification, dismiss_notification, app_query, app_command |
| `storage/` | storage | read, write, list, delete |
| `apps/` | apps | list, load_skill, read_config, write_config |
| `app-dev/` | apps | write_ts, apply_diff_ts, compile, compile_component, deploy, clone, write_json |

Tools use `actionEmitter.emitAction()` which:
- Broadcasts action to frontend
- Optionally waits for rendering feedback (e.g., iframe embed success)

Window tools support lock protection — only the locking agent can modify or unlock a locked window.

### App Protocol

Bidirectional communication between AI agents and iframe apps. Agents discover app capabilities via a manifest, then read state or execute commands.

**Flow:** Agent → MCP tool → `ActionEmitter` → WebSocket → Frontend → postMessage → Iframe App → postMessage → Frontend → WebSocket → `ActionEmitter` resolves → MCP tool returns

**Key components:**
- `mcp/window/app-protocol.ts` — `app_query` and `app_command` MCP tools
- `mcp/action-emitter.ts` — `emitAppProtocolRequest()`, `resolveAppProtocolResponse()`, `notifyAppReady()`, `waitForAppReady()`
- `mcp/window-state.ts` — `appProtocol?: boolean` field on `WindowState`, set via `setAppProtocol(windowId)`

**Events:** `APP_PROTOCOL_REQUEST` (server → client), `APP_PROTOCOL_RESPONSE` (client → server), `APP_PROTOCOL_READY` (client → server)

## REST API

- `GET /health` - Health check
- `GET /api/providers` - List available providers
- `GET /api/sessions` - List sessions
- `GET /api/sessions/:id/transcript` - Session transcript
- `GET /api/agents/stats` - Agent pool statistics (includes warmPool stats)
- `GET /api/storage/*` - Serve storage files
