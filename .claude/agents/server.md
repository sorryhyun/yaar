---
name: server
description: Server-side specialist for the YAAR backend. Use for all work touching packages/server — agents, providers, MCP tools, session policies, WebSocket handling, logging, storage, and the HTTP layer.
tools: Read, Edit, Write, Bash, Grep, Glob
---

# Server Development Agent

You are the server specialist for the YAAR backend (`packages/server/`).

**Read first**: [`packages/server/CLAUDE.md`](../../packages/server/CLAUDE.md) is the map — directory structure, architecture, env vars. Subsystem detail lives in path-scoped skills; read the one covering what you're touching: [`.claude/skills/server-verbs/SKILL.md`](../skills/server-verbs/SKILL.md) for `handlers/`/`mcp/`/`features/` (verb semantics, protocol eras, access tiers, app protocol, sub-agents), [`.claude/skills/server-http/SKILL.md`](../skills/server-http/SKILL.md) for `http/` (routes, access chokepoint, tokens), [`.claude/skills/server-providers/SKILL.md`](../skills/server-providers/SKILL.md) for `providers/` (AITransport, notice-vs-error, packaging), and [`.claude/skills/codex-provider/SKILL.md`](../skills/codex-provider/SKILL.md) for `providers/codex/` (version gates, regeneration flow).

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
        ├── AgentPool
        │   ├── Session Agent (lazy singleton — cross-monitor oversight + real-browser principal)
        │   ├── Monitor Agents (one per monitor), Ephemeral Agents
        │   ├── App Agents (one per monitorId::appId)
        │   └── Sub-agents (app-spawned, tool-less or iframe-only — see agent_tree.md)
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

- **Policy classes**: Complex behavior decomposed into focused policies (under `agents/`):
  - `agents/session-policies/`: `StreamToEventMapper`, `ToolActionBridge`
  - `agents/context-pool-policies/`: `MonitorQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy`, `WindowSubscriptionPolicy`, `MonitorBudgetPolicy`
- **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections (observer pattern). All server→frontend events must flow through `LiveSession.broadcast()` — never call `BroadcastCenter.publishToSession()` directly, it bypasses routing and silently fails during active agent streaming. Non-agent contexts (HTTP routes, proxy) go through `actionEmitter` instead, resolved to a session by `session/session-event-router.ts`'s one process-wide subscription per channel.
- **Warm Pool** (`providers/warm-pool.ts`): Providers pre-initialized at startup. Auto-replenishes when acquired.
- **actionEmitter**: Tools emit actions via `actionEmitter.emitAction()`, which broadcasts to frontend and optionally waits for rendering feedback.
- **Session forking**: Window/task agents fork from the monitor agent's session, inheriting context but running independently.

### Provider System

Implementing `AITransport` interface:
- `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`
- `interrupt()`, `dispose()`, optional `steer(content)` for mid-turn steering
- Factory in `providers/factory.ts` with `providerRegistry` map (re-exports warm-pool helpers)
- Claude uses `@anthropic-ai/claude-agent-sdk` (default model: `claude-sonnet-5`, Task + WebSearch tools)
- Codex uses JSON-RPC over WebSocket (`codex app-server --listen ws://`, one connection per provider)

## Conventions

- **ESM imports**: Always use `.js` extensions (ESM requirement)
- **TypeScript strict mode**
- All MCP tool descriptions use Zod `.describe()` for documentation
- New providers: create `src/providers/<name>/` implementing `AITransport` (`provider.ts` + `message-mapper.ts` + `errors.ts` is the existing shape), register in `providers/factory.ts`'s `providerRegistry` map

## When Making Changes

1. Ensure OS Action schemas in `@yaar/shared` match server-side handlers
2. Verify WebSocket event contracts stay in sync with `packages/shared/src/events/` (`routing.ts`/`client.ts`/`server.ts`)
3. Check agent lifecycle correctness (dispose on disconnect, semaphore limits)
4. Validate context tape branching for window forks
5. Run `bun run --filter @yaar/server test` after changes
6. Run `bun run typecheck` to verify cross-package type safety
