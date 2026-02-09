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
├── websocket/         # WebSocket server + connection registry
│   ├── server.ts      # createWebSocketServer() with explicit options param
│   └── broadcast-center.ts  # BroadcastCenter — routes events to WebSocket connections
├── agents/            # Agent lifecycle, pooling, context management
├── providers/         # Pluggable AI backends (Claude, Codex)
├── mcp/               # MCP server, domain-organized tools, action emitter
│   ├── index.ts       # Module re-exports
│   ├── server.ts      # MCP server init, request handling, token
│   ├── action-emitter.ts  # ActionEmitter — decouple tools from sessions
│   ├── window-state.ts    # Per-connection window state tracking
│   ├── utils.ts       # ok(), okWithImages() response helpers
│   ├── domains.ts     # Domain allowlist for HTTP/sandbox fetch
│   ├── tools/index.ts # Aggregator: registerAllTools(), getToolNames()
│   ├── system/        # get_time, calculate, get_info, get_env_var, generate_random, memorize
│   ├── window/        # create, update, close, lock/unlock, list, view, notifications
│   │   ├── create.ts, update.ts, lifecycle.ts, notification.ts
│   ├── storage/       # read, write, list, delete
│   ├── http/          # http_get, http_post, request_allowing_domain
│   │   ├── curl.ts, request.ts, permission.ts
│   ├── sandbox/       # run_js, run_ts
│   ├── apps/          # list, load_skill, read_config, write_config
│   │   ├── discovery.ts (listApps, loadAppSkill — used by API routes)
│   │   ├── config.ts (credentials, read/write config)
│   └── app-dev/       # write_ts, apply_diff_ts, compile, deploy, clone, write_json
│       ├── helpers.ts, write.ts, compile.ts, deploy.ts
├── logging/           # Session logging (write), reading, and window restore
├── storage/           # StorageManager + permissions for persistent data
└── lib/               # Standalone utilities (no server internal imports)
    ├── compiler/      # esbuild bundler for sandbox apps
    ├── pdf/           # PDF rendering via poppler
    └── sandbox/       # Sandboxed JS/TS code execution (node:vm)
```

## Architecture

### Context-Centric Agent Architecture

```
SessionManager (per WebSocket connection)
└── ContextPool (unified pool)
    ├── ContextTape (hierarchical message history)
    │   ├── [main] user/assistant messages
    │   └── [window:id] branch messages
    └── Agents (dynamic role assignment)
        └── AgentSession → AITransport
```

Key concepts:
- **Single pool**: Agents are just agents, role determined by task
- **Hierarchical context**: Messages tagged with source (main vs window)
- **Dynamic roles**: `default` for main, `window-{id}` for windows
- **Sequential main**: USER_MESSAGE tasks processed one at a time
- **Parallel windows**: WINDOW_MESSAGE tasks run concurrently

### Message Flow

```
WebSocket → SessionManager.routeMessage()
  → ContextPool.handleTask()
  → Main queue (sequential) or Window handler (parallel)
  → AgentSession.handleMessage(content, { role, source, ... })
  → AITransport.query() [async generator]
  → Tools emit actions via actionEmitter
  → BroadcastCenter.publishToConnection()
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

**Adding a new provider:**
1. Create `src/providers/<name>/provider.ts` implementing `AITransport`
2. Create `src/providers/<name>/system-prompt.ts` with provider-specific prompt
3. Add to `providerLoaders` in `src/providers/factory.ts`
4. Export from `src/providers/<name>/index.ts`

## Tools (MCP)

Tools are organized into domain folders under `mcp/`, each with an `index.ts` that exports a `register*Tools()` function. The aggregator at `mcp/tools/index.ts` wires them to the correct MCP server namespace.

| Domain | MCP Server | Tools |
|--------|-----------|-------|
| `system/` | system | get_time, calculate, get_info, get_env_var, generate_random, memorize |
| `http/` | system | http_get, http_post, request_allowing_domain |
| `sandbox/` | system | run_js, run_ts |
| `window/` | window | create, create_component, update, update_component, close, lock, unlock, list, view, show_notification, dismiss_notification |
| `storage/` | storage | read, write, list, delete |
| `apps/` | apps | list, load_skill, read_config, write_config |
| `app-dev/` | apps | write_ts, apply_diff_ts, compile, compile_component, deploy, clone, write_json |

Tools use `actionEmitter.emitAction()` which:
- Broadcasts action to frontend
- Optionally waits for rendering feedback (e.g., iframe embed success)

Window tools support lock protection — only the locking agent can modify or unlock a locked window.

## REST API

- `GET /health` - Health check
- `GET /api/providers` - List available providers
- `GET /api/sessions` - List sessions
- `GET /api/sessions/:id/transcript` - Session transcript
- `GET /api/agents/stats` - Agent pool statistics (includes warmPool stats)
- `GET /api/storage/*` - Serve storage files
