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
pnpm --filter @claudeos/frontend vitest run  # Run frontend tests
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

### Key Packages

1. **Frontend** (`@claudeos/frontend`): React + Zustand + Vite. Renders windows/toasts based on OS Actions. See `packages/frontend/CLAUDE.md`.

2. **Server** (`@claudeos/server`): TypeScript + ws. WebSocket server with pluggable AI providers. See `packages/server/CLAUDE.md`.

3. **Shared** (`@claudeos/shared`): Shared types for OS Actions and WebSocket events. See `packages/shared/CLAUDE.md`.

## Code Style

- All packages: TypeScript strict mode
- Frontend: path alias `@/` → `src/`
