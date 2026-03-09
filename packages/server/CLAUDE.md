# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
```

## Environment Variables

- `PROVIDER` - Force provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000), `MAX_AGENTS` - Global agent limit (default: 10)
- `MCP_SKIP_AUTH` - Skip MCP auth (`1` for local dev), `REMOTE` - Enable remote mode (`1`)
- `YAAR_STORAGE` / `YAAR_CONFIG` - Override storage/config directory paths
- `MONITOR_MAX_CONCURRENT` (default: 2), `MONITOR_MAX_ACTIONS_PER_MIN` (30), `MONITOR_MAX_OUTPUT_PER_MIN` (50000) - Background monitor budget limits
- `CODEX_WS_PORT` (default: 4510), `CHROME_PATH` (auto-detected), `MARKET_URL`

## Directory Structure

```
src/
├── index.ts              # Thin orchestrator (~35 lines)
├── config.ts             # Constants, paths, MIME types, PORT, monitor budget limits
├── lifecycle.ts          # initializeSubsystems(), printBanner(), shutdown()
├── http/                 # HTTP server: createFetchHandler() (CORS, auth, MCP dispatch)
│   ├── auth.ts           # checkHttpAuth(), generateRemoteToken()
│   └── routes/           # api.ts (REST), files.ts (file-serving), proxy.ts, static.ts
├── session/              # LiveSession, SessionHub, BroadcastCenter, types
├── websocket/            # WebSocket server + connection registry
├── agents/               # Agent lifecycle, pooling, context management
│   ├── agent-pool.ts     # AgentPool — per-monitor and window agent registry
│   ├── context-pool.ts   # ContextPool — unified task orchestration
│   ├── context.ts        # ContextTape — hierarchical message history
│   ├── limiter.ts        # AgentLimiter — global agent semaphore
│   ├── session.ts        # AgentSession + AsyncLocalStorage (getAgentId, getSessionId)
│   ├── main-task-processor.ts / window-task-processor.ts
│   ├── session-policies/       # StreamToEventMapper, ProviderLifecycleManager, ToolActionBridge
│   └── context-pool-policies/  # MainQueue, WindowQueue, ContextAssembly, ReloadCache, MonitorBudget, WindowConnection
├── providers/            # Pluggable AI backends
│   ├── types.ts          # AITransport interface, StreamMessage, TransportOptions
│   ├── factory.ts        # Auto-detect provider, warm pool init
│   ├── warm-pool.ts      # WarmPool singleton
│   ├── claude/           # ClaudeSessionProvider, system-prompt, message-mapper
│   └── codex/            # CodexProvider, AppServer, JsonRpcWsClient, auth, types
├── mcp/                  # MCP server + tool folders (see Tools section)
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS + LEGACY_SERVERS
│   ├── action-emitter.ts # ActionEmitter — decouple tools from sessions
│   ├── window-state.ts   # WindowStateRegistry — per-session window state
│   ├── system/           # Always-active: info, notify, relay, sandbox, hooks
│   ├── skills/           # Always-active: skill reference doc loader
│   ├── http/             # Always-active: http_get, http_post, domain allow-list
│   ├── verbs/            # PRIMARY (verb mode): 5 generic URI tools (describe/read/list/invoke/delete)
│   │   ├── tools.ts      # registerVerbTools() — the 5 MCP tool definitions
│   │   └── handlers/     # Thin URI handler files (import from features/): apps, basic, browser, config, session, user, window, agents
│   └── legacy/           # DEPRECATED (legacy tool mode): individual named MCP tools; import from features/
│       ├── index.ts      # Re-exports all legacy registrations (@deprecated)
│       ├── apps/ basic/ browser/ config/ dev/ user/ window/
├── features/             # Domain business logic (imported by mcp/verbs/handlers/ and mcp/legacy/)
│   ├── apps/             # App listing, skill loading, marketplace, badge
│   ├── browser/          # CDP browser automation actions
│   ├── config/           # Hooks, settings, shortcuts, mounts, app config
│   ├── dev/              # Compile, typecheck, deploy, clone
│   └── window/           # Window create/update/manage, app protocol, app query/command
├── reload/               # Fingerprint-based action cache
├── logging/              # Session logging (JSONL), reading, context/window restore
├── storage/              # StorageManager, permissions, shortcuts, settings, mounts
└── lib/                  # Standalone utilities (no server internal imports)
    └── browser/ bundled-types/ compiler/ pdf/ sandbox/ pick-directory.ts
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

**AITransport interface:** `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`, `interrupt()`, `dispose()`.

**Warm Pool:** Providers pre-initialized at startup. `initWarmPool()` at boot, `acquireWarmProvider()` gets a ready instance, pool auto-replenishes in background.

**Claude:** `claude-sonnet-4-6`, thinking enabled (4096 max tokens), WebSearch and Task tools, `bypassPermissions`. Sends a "ping" warmup message to pre-create session with MCP tools loaded.

**Codex:** `codex app-server` child process with per-provider WebSocket connections (`--listen ws://`). Settings: `approval_policy=on-request`, `model_reasoning_effort=medium`, `sandbox_mode=danger-full-access`.

## Tools (MCP)

**Verb mode (default):** Only the `system` and `verbs` namespaces are active. The `verbs` server exposes 5 generic tools (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch to thin handler files in `mcp/verbs/handlers/` (which import domain logic from `features/`) via `yaar://` URIs.

**Legacy tool mode (deprecated):** All namespaces active. Individual named tools in `mcp/legacy/` domain folders. Emits a deprecation warning at startup. Will be removed in a future release.

Always-active tools (both modes):

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `system/` | system | get_info, memorize, relay_to_main, run_js, show_notification |
| `skills/` | system | skill (reference doc loader) |
| `http/` | system | http_get, http_post, request_allowing_domain |
| `reload/` | system | reload_cached, list_reload_options |
| `verbs/` | verbs | describe, read, list, invoke, delete (URI-based dispatch) |

Legacy tools (deprecated, `mcp/legacy/`):

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `config/` | config | set, get, remove (hooks, settings, shortcuts, mounts, app) |
| `window/` | window | create, update, manage, list, view, info, app_query, app_command |
| `apps/` | apps | list, load_skill, set_app_badge, marketplace ops |
| `user/` | user | ask, request |
| `dev/` | dev | compile, typecheck, deploy, clone |
| `basic/` | basic | read, write, list, delete, edit (URI-style paths) |
| `browser/` | browser | CDP automation — open, interact, navigate, content, manage (conditional — Chrome/Edge required) |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for rendering feedback. Window tools support lock protection — only the locking agent can modify a locked window.

**App Protocol:** Bidirectional agent-iframe communication via `app_query`/`app_command` tools. Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. See `mcp/legacy/window/app-protocol.ts` and shared CLAUDE.md for event schemas.

## REST API

Routes in `http/routes/`. Pattern: `GET /health`, `/api/providers`, `/api/apps`, `/api/sessions`, `/api/shortcuts`, `/api/settings`, `/api/domains`, `/api/agents/stats`, `/api/storage/*`, `/api/pdf/*`, `/api/sandbox/*`, `/api/browser/*`, `/api/fetch`, `/api/pick-directory`. See `routes/api.ts` and `routes/files.ts` for full signatures.
