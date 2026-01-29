# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeOS is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show toasts, etc.).

**Prerequisites:**
- Node.js >= 18
- pnpm >= 8
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDKs:**
- **Claude:** Uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access. See [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) for API documentation.
- **Codex:** Uses `codex app-server` for JSON-RPC communication. See [CODEX_CLI_TIPS.md](./CODEX_CLI_TIPS.md) for protocol details.

## Commands

```bash
pnpm install                     # Install all dependencies
make claude                      # Start with Claude provider
make codex                       # Start with Codex provider
make dev                         # Start with auto-detected provider
make server                      # Start server only
make frontend                    # Start frontend only
make build                       # Build all packages
pnpm typecheck                   # Type check all packages
make lint                        # Lint all packages
make clean                       # Clean generated files

# Testing (frontend only)
cd packages/frontend && pnpm vitest          # Run tests in watch mode
cd packages/frontend && pnpm vitest run      # Run tests once
cd packages/frontend && pnpm vitest run src/__tests__/store/desktop.test.ts  # Single test file
```

## Environment Variables

- `PROVIDER` - Force a specific AI provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000)

## Monorepo Structure

```
claudeos/
├── packages/
│   ├── shared/        # Shared types (OS Actions, WebSocket events)
│   ├── server/        # TypeScript WebSocket server
│   └── frontend/      # React frontend
├── pnpm-workspace.yaml
└── package.json
```

### Package Dependencies

```
@claudeos/frontend ──┐
                     ├──> @claudeos/shared
@claudeos/server ────┘
```

## Architecture

```
User Input → WebSocket → TypeScript Server → Claude Agent SDK → OS Actions → Frontend Renders UI
```

### Two-Layer Design

1. **Frontend** (`@claudeos/frontend`): React + Zustand + Vite. Renders windows/toasts based on OS Actions. Vite proxies `/ws` to `ws://localhost:8000` and `/api` to `http://localhost:8000`.

2. **Server** (`@claudeos/server`): TypeScript + ws. WebSocket server with pluggable AI providers. Entry point: `packages/server/src/index.ts`.

### Server Structure (`packages/server/src/`)

```
server/src/
├── index.ts              # WebSocket server entry point
├── session-manager.ts    # Manages default + window agents per connection
├── agent-session.ts      # Individual agent session (transport, logging)
├── system-prompt.ts      # System prompt configuration
├── providers/            # Pluggable AI backends
│   ├── factory.ts        # Provider factory with auto-detection
│   ├── types.ts          # AITransport interface
│   ├── base-transport.ts # Base transport implementation
│   ├── claude/           # Claude Agent SDK implementation
│   └── codex/            # Codex app-server implementation
├── tools/                # MCP tools the AI can use
│   ├── window.ts         # Window management tools (with lock feedback)
│   ├── storage.ts        # Persistent storage tools
│   ├── system.ts         # System tools
│   └── action-emitter.ts # Emits OS actions to frontend (with feedback)
├── sessions/             # Session logging (shared across agents)
└── storage/              # Persistent storage utilities
```

### Shared Types (`@claudeos/shared`)

- `actions.ts` - OS Actions DSL (window.create, toast.show, etc.)
- `events.ts` - WebSocket event types (client→server and server→client)

### Frontend State

- `store/desktop.ts` - Zustand store with Immer; all UI state flows through `applyAction()` reducer
- `hooks/useAgentConnection.ts` - WebSocket connection with auto-reconnect

### Agent Types

| Agent | ID Format | Description |
|-------|-----------|-------------|
| **Default agent** | `'default'` | Primary agent for the session, handles user input from main input field |
| **Window agent** | `'window-{windowId}'` | Spawned for specific windows via context menu, runs in parallel with default agent |
| **Subagent** | SDK-assigned | Spawned by default/window agents via Claude Agent SDK's native subagent feature |

**Session management:**
- `SessionManager` manages all agents for a WebSocket connection
- Window agents fork from the default agent's context and share its session log
- Window locking prevents concurrent modifications (`window.lock`, `window.unlock`)
- Tools return feedback when blocked (e.g., "Window is locked, use unlock_window...")

### OS Actions DSL

AI controls UI through actions like:
- `window.create`, `window.setContent`, `window.close`, `window.focus`
- `window.lock`, `window.unlock` - Prevent concurrent modifications
- `window.updateContent` - Diff-based content updates (append, prepend, replace, etc.)
- `toast.show`, `notification.show`

Content renderers: `markdown`, `table`, `text`, `html`, `iframe`

## Key Files

- `packages/shared/src/actions.ts` - OS Actions type definitions
- `packages/server/src/index.ts` - WebSocket server entry point
- `packages/server/src/session-manager.ts` - Multi-agent session management
- `packages/server/src/agent-session.ts` - Individual agent session (transport, logging)
- `packages/server/src/providers/factory.ts` - Provider factory and selection
- `packages/server/src/tools/window.ts` - Window management tools (with lock feedback)
- `packages/server/src/tools/action-emitter.ts` - Action emission with feedback mechanism
- `packages/frontend/src/store/desktop.ts` - Central state store (handles locking)
- `packages/frontend/src/components/windows/ContentRenderer.tsx` - Window content rendering

## Code Style

- All packages: TypeScript strict mode
- Frontend: path alias `@/` → `src/`

## Adding a New AI Provider

1. Create `packages/server/src/providers/<name>/transport.ts` implementing `AITransport`
2. Add loader to `providerLoaders` in `packages/server/src/providers/factory.ts`
3. Add availability check to `isProviderAvailable()` in the factory

## Adding a New OS Action

1. Define the action type in `packages/shared/src/actions.ts`
2. Handle it in `applyAction()` in `packages/frontend/src/store/desktop.ts`
3. Optionally add an MCP tool in `packages/server/src/tools/` to let the AI emit it

## Adding a New Content Renderer

1. Create `packages/frontend/src/components/windows/renderers/<Name>Renderer.tsx`
2. Add the case in `packages/frontend/src/components/windows/ContentRenderer.tsx`
3. Add styles in `packages/frontend/src/styles/renderers.module.css`
4. Update renderer enum in `packages/server/src/tools/window.ts`
