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
├── index.ts              # WebSocket server + REST API endpoints
├── agents/
│   ├── manager.ts        # SessionManager - routes messages to ContextPool
│   ├── session.ts        # AgentSession - individual agent with dynamic role
│   ├── limiter.ts        # AgentLimiter - global semaphore
│   ├── context.ts        # ContextTape - hierarchical conversation context
│   └── context-pool.ts   # Unified pool with dynamic role assignment
├── events/
│   └── broadcast-center.ts  # Centralized WebSocket event hub
├── providers/
│   ├── types.ts          # AITransport interface
│   ├── base-transport.ts # Abstract base class
│   ├── factory.ts        # Provider factory with auto-detection
│   ├── warm-pool.ts      # Pre-warms providers at startup
│   ├── claude/           # Claude Agent SDK implementation
│   │   ├── provider.ts   # ClaudeProvider class (query-based)
│   │   ├── session-provider.ts  # ClaudeSessionProvider (with warmup)
│   │   └── system-prompt.ts  # Claude-specific system prompt
│   └── codex/            # Codex app-server implementation
│       ├── provider.ts   # CodexProvider class
│       └── system-prompt.ts  # Codex-specific system prompt
├── mcp/
│   ├── index.ts          # MCP module exports
│   ├── server.ts         # MCP HTTP server init & request handling
│   ├── action-emitter.ts # Emits OS Actions with feedback mechanism
│   ├── window-state.ts   # Server-side window state tracker
│   ├── utils.ts          # Shared helpers (ok, okWithImages)
│   └── tools/
│       ├── index.ts      # Tool registration aggregator
│       ├── system.ts     # get_system_time, calculate, etc.
│       ├── window.ts     # create_window, update_window, lock_window, etc.
│       └── storage.ts    # storage_read, storage_write, etc.
├── logging/              # SessionLogger for transcript persistence
└── storage/              # StorageManager for persistent data
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

Window tools with lock protection:
- `create_window`, `update_window`, `close_window`
- `lock_window`, `unlock_window` - Prevent concurrent modifications
- `show_notification`, `dismiss_notification`

Tools use `actionEmitter.emitAction()` which:
- Broadcasts action to frontend
- Optionally waits for rendering feedback (e.g., iframe embed success)

## REST API

- `GET /health` - Health check
- `GET /api/providers` - List available providers
- `GET /api/sessions` - List sessions
- `GET /api/sessions/:id/transcript` - Session transcript
- `GET /api/agents/stats` - Agent pool statistics (includes warmPool stats)
- `GET /api/storage/*` - Serve storage files
