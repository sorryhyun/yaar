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
├── system-prompt.ts      # System prompt for Claude
├── agents/
│   ├── manager.ts        # SessionManager - routes messages to pools
│   ├── session.ts        # AgentSession - individual agent with provider
│   ├── limiter.ts        # AgentLimiter - global semaphore
│   ├── default-pool.ts   # Pool for main user messages
│   └── window-pool.ts    # Pool for window-specific agents
├── events/
│   └── broadcast-center.ts  # Centralized WebSocket event hub
├── providers/
│   ├── types.ts          # AITransport interface
│   ├── base-transport.ts # Abstract base class
│   ├── factory.ts        # Provider factory with auto-detection
│   ├── claude/           # Claude Agent SDK implementation
│   └── codex/            # Codex app-server implementation
├── tools/
│   ├── window.ts         # create_window, update_window, lock_window, etc.
│   ├── storage.ts        # storage_read, storage_write, etc.
│   ├── system.ts         # get_system_time, calculate, etc.
│   └── action-emitter.ts # Emits OS Actions with feedback mechanism
├── logging/              # SessionLogger for transcript persistence
└── storage/              # StorageManager for persistent data
```

## Architecture

### Agent Hierarchy

```
SessionManager (per WebSocket connection)
├── DefaultAgentPool (1-3 agents for user messages)
│   └── AgentSession → AITransport
└── WindowAgentPool (per-window agents, forked from default)
    └── AgentSession → AITransport
```

### Message Flow

```
WebSocket → SessionManager.routeMessage()
  → DefaultAgentPool or WindowAgentPool
  → AgentSession.handleMessage()
  → AITransport.query() [async generator]
  → Tools emit actions via actionEmitter
  → BroadcastCenter.publishToConnection()
```

### Key Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| Semaphore | `AgentLimiter` | Global agent limit with queue |
| Pool | `DefaultAgentPool` | Reuse agents, handle concurrency |
| Factory | `providers/factory.ts` | Auto-detect and create providers |
| Observer | `actionEmitter` | Decouple tools from sessions |
| AsyncLocalStorage | `AgentSession` | Track agentId in async context |

## Providers

**AITransport interface:**
- `isAvailable()` - Check if provider can be used
- `query(prompt, options)` - Returns async iterable of StreamMessages
- `interrupt()` - Cancel ongoing query
- `dispose()` - Cleanup resources

**Adding a new provider:**
1. Create `src/providers/<name>/provider.ts` implementing `AITransport`
2. Add to `providerLoaders` in `src/providers/factory.ts`
3. Export from `src/providers/<name>/index.ts`

## Tools (MCP)

Window tools with lock protection:
- `create_window`, `update_window`, `close_window`
- `lock_window`, `unlock_window` - Prevent concurrent modifications
- `show_toast`

Tools use `actionEmitter.emitAction()` which:
- Broadcasts action to frontend
- Optionally waits for rendering feedback (e.g., iframe embed success)

## REST API

- `GET /health` - Health check
- `GET /api/providers` - List available providers
- `GET /api/sessions` - List sessions
- `GET /api/sessions/:id/transcript` - Session transcript
- `GET /api/agents/stats` - Agent pool statistics
- `GET /api/storage/*` - Serve storage files
