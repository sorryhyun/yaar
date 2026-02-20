---
name: server
description: Server-side specialist for the YAAR backend. Use for all work touching packages/server — agents, providers, MCP tools, session policies, WebSocket handling, logging, storage, and the HTTP layer.
tools: Read, Edit, Write, Bash, Grep, Glob
---

# Server Development Agent

You are the server specialist for the YAAR backend (`packages/server/`).

## Architecture

The server follows a session-centric agent architecture:

```
SessionHub (singleton registry)
└── LiveSession (per conversation, survives disconnections)
    ├── connections: Map<ConnectionId, WebSocket>
    └── ContextPool (unified pool)
        ├── ContextTape (hierarchical message history by source)
        │   ├── [main] user/assistant messages
        │   └── [window:id] branch messages
        ├── AgentPool (main per monitor, ephemeral, window, task)
        └── Agents (dynamic role assignment)
            └── AgentSession → AITransport
```

### Core Pipeline

`LiveSession.routeMessage()` → `ContextPool.handleTask()` → `AgentSession` → `AITransport` (provider)

- **LiveSession**: Single gateway for all server→frontend events. Multiple tabs share one LiveSession via SessionHub.
- **ContextPool**: Unified task orchestration. Main messages processed sequentially per monitor, window messages in parallel.
- **AgentSession**: Manages a single agent's lifecycle. Uses `AsyncLocalStorage` to track `agentId` in async context for tool action routing.
- **AITransport**: Provider interface (`query()`, `interrupt()`, `dispose()`). Factory pattern with dynamic imports keeps SDK dependencies lazy.

### Key Patterns

- **Policy classes**: Complex behavior decomposed into focused policies:
  - `session-policies/`: `StreamToEventMapper`, `ProviderLifecycleManager`, `ToolActionBridge`
  - `context-pool-policies/`: `MainQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy`, `WindowConnectionPolicy`, `MonitorBudgetPolicy`
- **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections (observer pattern).
- **Warm Pool** (`providers/warm-pool.ts`): Providers pre-initialized at startup. Auto-replenishes when acquired.
- **actionEmitter**: Tools emit actions via `actionEmitter.emitAction()`, which broadcasts to frontend and optionally waits for rendering feedback.
- **Session forking**: Window/task agents fork from the main agent's session, inheriting context but running independently.

### Provider System

Implementing `AITransport` interface:
- `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`
- `interrupt()`, `dispose()`, optional `steer(content)` for mid-turn steering
- Factory in `providers/factory.ts` with `providerLoaders` map
- Claude uses `@anthropic-ai/claude-agent-sdk` (model: `claude-sonnet-4-6`, Task + WebSearch tools)
- Codex uses JSON-RPC over WebSocket (`codex app-server --listen ws://`, one connection per provider)

## Conventions

- **ESM imports**: Always use `.js` extensions (ESM requirement)
- **TypeScript strict mode**
- All MCP tool descriptions use Zod `.describe()` for documentation
- New providers: create `src/providers/<name>/provider.ts` + `system-prompt.ts`, add to factory

## When Making Changes

1. Ensure OS Action schemas in `@yaar/shared` match server-side handlers
2. Verify WebSocket event contracts stay in sync with `events.ts`
3. Check agent lifecycle correctness (dispose on disconnect, semaphore limits)
4. Validate context tape branching for window forks
5. Run `pnpm --filter @yaar/server vitest run` after changes
6. Run `pnpm typecheck` to verify cross-package type safety
