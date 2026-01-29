# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeOS is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show toasts, etc.).

**Prerequisites:**
- Node.js >= 18
- pnpm >= 8
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDK:** The server uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access.

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

### Three-Layer Design

1. **Frontend** (`@claudeos/frontend`): React + Zustand + Vite. Renders windows/toasts based on OS Actions. Vite proxies `/ws` to `ws://localhost:8000` and `/api` to `http://localhost:8000`.

2. **Server** (`@claudeos/server`): TypeScript + ws. WebSocket server that connects frontend to AI providers via transport layer. Entry point: `packages/server/src/index.ts`.

3. **Transport Layer** (`packages/server/src/transports/`): Pluggable AI backends. Currently implements Claude via the Agent SDK.

### Shared Types (`@claudeos/shared`)

- `actions.ts` - OS Actions DSL (window.create, toast.show, etc.)
- `events.ts` - WebSocket event types (client→server and server→client)

### Transport System

- `types.ts` - Interfaces: `AITransport`, `StreamMessage`, `TransportOptions`
- `factory.ts` - Transport factory with availability checking and `PROVIDER` env var support
- `providers/claude/` - Claude Agent SDK implementation
- `providers/codex/` - Codex SDK implementation

### Frontend State

- `store/desktop.ts` - Zustand store with Immer; all UI state flows through `applyAction()` reducer
- `hooks/useAgentConnection.ts` - WebSocket connection with auto-reconnect

### OS Actions DSL

AI controls UI through actions like:
- `window.create`, `window.setContent`, `window.close`, `window.focus`
- `toast.show`, `notification.show`

Content types: `markdown`, `table`, `text`, `html`

## Key Files

- `packages/shared/src/` - Shared type definitions
- `packages/server/src/index.ts` - WebSocket server with CORS
- `packages/server/src/agent-session.ts` - Session management and action extraction
- `packages/server/src/transports/factory.ts` - Transport factory and provider selection
- `packages/frontend/src/store/desktop.ts` - Central state store
- `packages/frontend/vite.config.ts` - Dev server config with WebSocket/API proxy

## Code Style

- All packages: TypeScript strict mode
- Frontend: path alias `@/` → `src/`

## Adding a New AI Provider

1. Create `packages/server/src/transports/providers/<name>/transport.ts` implementing `AITransport`
2. Add loader to `providerLoaders` in `packages/server/src/transports/factory.ts`
3. Add availability check to `isProviderAvailable()` in the factory

## Adding a New OS Action

1. Define the action type in `packages/shared/src/actions.ts`
2. Handle it in `applyAction()` in `packages/frontend/src/store/desktop.ts`
3. Optionally add an MCP tool in `packages/server/src/tools/` to let the AI emit it
