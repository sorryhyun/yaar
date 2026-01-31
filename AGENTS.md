# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeOS is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notification, etc.).

**Prerequisites:**
- Node.js >= 24
- pnpm >= 10
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
├── apps/                        # Convention-based apps (each folder = one app)
│   └── moltbook/
│       ├── SKILL.md             # Instructions for AI on how to use this app
│       └── credentials.json     # (git-ignored) API credentials
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

1. **Frontend** (`@claudeos/frontend`): React + Zustand + Vite. Renders windows based on OS Actions. See `packages/frontend/CLAUDE.md`.

2. **Server** (`@claudeos/server`): TypeScript + ws. WebSocket server with pluggable AI providers. See `packages/server/CLAUDE.md`.

3. **Shared** (`@claudeos/shared`): Shared types for OS Actions and WebSocket events. See `packages/shared/CLAUDE.md`.

## Code Style

- All packages: TypeScript strict mode
- Frontend: path alias `@/` → `src/`

## Apps System

ClaudeOS has a convention-based apps system. Each folder in `apps/` becomes a desktop icon automatically.

### How It Works

1. **Frontend startup**: Calls `GET /api/apps` to list apps
2. **Desktop renders**: Shows one icon per app folder
3. **User clicks icon**: Sends `"user clicked app: {appId}"`
4. **AI reads skill**: Loads `apps/{appId}/SKILL.md` as context
5. **AI responds**: Uses skill instructions to help user

### Creating a New App

1. Create folder: `apps/myapp/`
2. Create `SKILL.md` with:
   - App description
   - API endpoints and authentication
   - Available actions
   - Example workflows
3. (Optional) Store credentials in `credentials.json` (git-ignored)

### Apps Tools (MCP)

| Tool | Description |
|------|-------------|
| `apps_list` | List all available apps |
| `apps_load_skill` | Load SKILL.md for an app |
| `apps_read_config` | Read config file (default: credentials.json) |
| `apps_write_config` | Write config file |

### Example: Moltbook App

```
apps/moltbook/
├── SKILL.md           # API docs, auth flow, example usage
└── credentials.json   # { "api_key": "moltbook_xxx" }
```

When user clicks the Moltbook icon, the AI loads `SKILL.md` and can then help with registration, posting, viewing feed, etc.
