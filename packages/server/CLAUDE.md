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
- `MCP_SKIP_AUTH` - Skip MCP authentication (set to `1` for local dev)
- `REMOTE` - Enable remote mode with token auth (set to `1`)
- `YAAR_STORAGE` - Override storage directory path
- `YAAR_CONFIG` - Override config directory path
- `MONITOR_MAX_CONCURRENT` - Max concurrent background monitors (default: 2)
- `MONITOR_MAX_ACTIONS_PER_MIN` - Max actions/min per background monitor (default: 30)
- `MONITOR_MAX_OUTPUT_PER_MIN` - Max output bytes/min per background monitor (default: 50000)
- `CODEX_WS_PORT` - Codex app-server WebSocket port (default: 4510)
- `CHROME_PATH` - Path to Chrome/Edge binary for browser tools (auto-detected if not set)
- `MARKET_URL` - YAAR marketplace base URL (default: `https://yaarmarket.vercel.app`)

## Directory Structure

```
src/
├── index.ts           # Thin orchestrator (~35 lines)
├── config.ts          # Constants, paths, MIME types, PORT, monitor budget limits
├── lifecycle.ts       # initializeSubsystems(), startListening(), shutdown()
├── http/              # HTTP server and route handlers
│   ├── server.ts      # createHttpServer() — CORS, MCP dispatch, route dispatch
│   ├── utils.ts       # sendJson(), sendError(), safePath() helpers
│   └── routes/
│       ├── api.ts     # REST API routes (health, providers, apps, sessions, shortcuts, settings, domains)
│       ├── files.ts   # File-serving routes (pdf, sandbox, app-static, storage)
│       └── static.ts  # Frontend static serving + SPA fallback
├── session/           # Session management (LiveSession, SessionHub, BroadcastCenter)
│   ├── live-session.ts    # LiveSession — single gateway for all server→frontend events
│   ├── broadcast-center.ts  # BroadcastCenter — routes events to WebSocket connections
│   └── types.ts           # SessionId type, generateSessionId()
├── websocket/         # WebSocket server + connection registry
│   └── server.ts      # createWebSocketServer() with explicit options param
├── agents/            # Agent lifecycle, pooling, context management
├── providers/         # Pluggable AI backends (Claude, Codex)
├── mcp/               # MCP server, domain-organized tools, action emitter
│   ├── index.ts       # Module re-exports
│   ├── server.ts      # MCP server init, request handling, token (7 namespaces)
│   ├── action-emitter.ts  # ActionEmitter — decouple tools from sessions
│   ├── window-state.ts    # WindowStateRegistry — per-session window state tracking
│   ├── utils.ts       # ok(), okWithImages() response helpers
│   ├── domains.ts     # Domain allowlist for HTTP/sandbox fetch
│   ├── register.ts    # Aggregator: registerAllTools(), getToolNames()
│   ├── system/        # get_info, get_env_var, memorize, set_config, get_config, remove_config
│   ├── skills/        # skill tool — loads reference docs (app_dev, sandbox, components, host_api, app_protocol)
│   ├── desktop/       # create_shortcut, remove_shortcut, update_shortcut, list_shortcuts
│   ├── window/        # create, create_component, update, update_component, close, lock/unlock, list, view, notifications, app protocol
│   │   ├── create.ts, update.ts, lifecycle.ts, notification.ts, app-protocol.ts
│   ├── storage/       # read, write, list, delete
│   ├── http/          # http_get, http_post, request_allowing_domain
│   ├── sandbox/       # run_js
│   ├── apps/          # list, load_skill, read_config, write_config, set_app_badge, market_list, market_get, market_delete
│   │   ├── discovery.ts (listApps, loadAppSkill — used by API routes)
│   │   ├── config.ts (credentials, read/write config)
│   │   ├── badge.ts (set_app_badge)
│   │   └── market.ts (marketplace: list, get, delete)
│   ├── user/          # ask, request (user prompt tools — live on the `user` MCP server)
│   ├── browser/       # open, click, type, press, scroll, screenshot, extract, close (conditional — Chrome required)
│   └── dev/           # write_ts, apply_diff_ts, read_ts, compile, compile_component, typecheck, deploy, clone, write_json
│       ├── write.ts, read.ts, compile.ts, deploy.ts
├── reload/            # Fingerprint-based action cache
├── logging/           # Session logging (write), reading, context restore, and window restore
│   └── session_logs stored at PROJECT_ROOT/session_logs/{sessionId}/
├── storage/           # StorageManager + permissions + shortcuts + settings
└── lib/               # Standalone utilities (no server internal imports)
    ├── browser/       # CDP browser automation (headless Chromium via Puppeteer)
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
  → LiveSession.broadcast()
```

### Event Delivery Rule

**All server→frontend events must flow through `LiveSession.broadcast()`**, never directly through `BroadcastCenter.publishToSession()`. `LiveSession.broadcast()` handles monitor-scoped routing.

For non-agent contexts (HTTP routes, proxy) where there is no `LiveSession` reference, use the `actionEmitter` EventEmitter pattern:
1. `actionEmitter.emit('my-event', { sessionId, event })` from the source
2. `actionEmitter.on('my-event', handler)` in the `LiveSession` constructor → `this.broadcast(event)`
3. Clean up listener in `LiveSession.cleanup()`

See `'app-protocol'` and `'approval-request'` listeners in `live-session.ts` as reference implementations. Calling `BroadcastCenter.publishToSession()` directly bypasses routing and silently fails during active agent streaming.

### Event Type Constants

Use `ServerEventType` and `ClientEventType` const objects from `@yaar/shared` for all event type discriminants — never raw string literals.

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

Model: `claude-sonnet-4-6`, thinking enabled (4096 max tokens), WebSearch and Task tools enabled, `bypassPermissions`.

**Codex provider (`providers/codex/`):**
- `app-server.ts` — Manages `codex app-server` child process with WebSocket transport (`--listen ws://`). Spawns the process, maintains a control client for auth, and exposes `createConnection()` so each provider gets its own WS connection with `initialize` handshake.
- `jsonrpc-ws-client.ts` — WebSocket-based JSON-RPC client. Each provider instance gets a dedicated connection, enabling parallel turns without serialization.
- `types.ts` — Re-exports generated v2 API types (`ThreadStart`, `ThreadResume`, `ThreadFork`, `TurnStart`, `TurnInterrupt`, notification types) from `generated/v2/`. Also provides JSON-RPC base types.
- `provider.ts` — `CodexSessionProvider` implementing `AITransport`.

Codex settings: `approval_policy=on-request`, `model_reasoning_effort=medium`, `sandbox_mode=danger-full-access`, `features.collaboration_modes=true` (subagent delegation).

**Adding a new provider:**
1. Create `src/providers/<name>/provider.ts` implementing `AITransport`
2. Create `src/providers/<name>/system-prompt.ts` with provider-specific prompt
3. Add to `providerLoaders` in `src/providers/factory.ts`
4. Export from `src/providers/<name>/index.ts`

## Tools (MCP)

Tools are organized into domain folders under `mcp/`, each with an `index.ts` that exports a `register*Tools()` function. The aggregator at `mcp/register.ts` wires them to the correct MCP server namespace. There are 7 MCP namespaces: `system`, `window`, `storage`, `apps`, `user`, `dev`, `browser`.

| Domain | MCP Server | Tools |
|--------|-----------|-------|
| `system/` | system | get_info, get_env_var, memorize, set_config, get_config, remove_config |
| `skills/` | system | skill (loads reference docs: app_dev, sandbox, components, host_api, app_protocol) |
| `desktop/` | system | create_shortcut, remove_shortcut, update_shortcut, list_shortcuts |
| `http/` | system | http_get, http_post, request_allowing_domain |
| `sandbox/` | system | run_js |
| `window/` | window | create, create_component, update, update_component, close, lock, unlock, list, view, show_notification, dismiss_notification, app_query, app_command |
| `storage/` | storage | read, write, list, delete |
| `apps/` | apps | list, load_skill, read_config, write_config, set_app_badge, market_list, market_get, market_delete |
| `user/` | user | ask, request |
| `dev/` | dev | write_ts, apply_diff_ts, read_ts, compile, compile_component, typecheck, deploy, clone, write_json |
| `browser/` | browser | open, click, type, press, scroll, screenshot, extract, close (conditional — Chrome/Edge required) |
| `reload/` | system | reload_cached |

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
- `GET /api/apps` - List installed apps (with onboardingCompleted, language)
- `GET /api/shortcuts` - List desktop shortcuts
- `PATCH /api/settings` - Update user settings (language, onboardingCompleted)
- `GET /api/domains` - Get domain allowlist settings
- `GET /api/sessions` - List sessions
- `GET /api/sessions/:id/transcript` - Session transcript
- `GET /api/sessions/:id/messages` - Raw session messages (JSONL parsed)
- `POST /api/sessions/:id/restore` - Restore session (window actions + context)
- `GET /api/agents/stats` - Agent pool statistics (includes warmPool stats)
- `GET /api/storage/*` - Serve storage files
- `GET /api/browser/:sessionId/events` - Browser SSE stream (screenshot updates)
