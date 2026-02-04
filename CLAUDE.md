# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notification, etc.).

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
make claude-dev                  # Claude provider without MCP auth (local dev)
make codex-dev                   # Codex provider without MCP auth (local dev)
make server                      # Start server only
make frontend                    # Start frontend only
make build                       # Build all packages
pnpm typecheck                   # Type check all packages
make lint                        # Lint all packages
make clean                       # Clean generated files

# Testing
pnpm --filter @yaar/frontend vitest run           # Run all frontend tests
pnpm --filter @yaar/frontend vitest run store     # Run tests matching "store"

# Standalone executable (requires Bun)
pnpm build:exe                   # Build Windows executable
pnpm build:exe:bundle:linux      # Build Linux executable
pnpm build:exe:bundle:macos      # Build macOS executable
```

## Environment Variables

- `PROVIDER` - Force a specific AI provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000)
- `MAX_AGENTS` - Global agent limit (default: 10)
- `MCP_SKIP_AUTH` - Skip MCP authentication for local development

## Monorepo Structure

```
yaar/
├── apps/                        # Convention-based apps (each folder = one app)
│   └── moltbook/
│       └── SKILL.md             # Instructions for AI on how to use this app
├── config/                      # User config (git-ignored)
│   ├── permissions.json         # Saved permission decisions
│   └── curl_allowed_domains.yaml # Allowed HTTP domains
├── storage/                     # Persistent data storage
│   └── credentials/             # Centralized app credentials
│       └── moltbook.json        # (git-ignored) API credentials for moltbook
├── packages/
│   ├── shared/        # Shared types (OS Actions, WebSocket events)
│   ├── server/        # TypeScript WebSocket server
│   └── frontend/      # React frontend
├── pnpm-workspace.yaml
└── package.json
```

### Package Dependencies

```
@yaar/frontend ──┐
                     ├──> @yaar/shared
@yaar/server ────┘
```

## Architecture

```
User Input → WebSocket → TypeScript Server → Claude Agent SDK → OS Actions → Frontend Renders UI
```

### Key Packages

1. **Frontend** (`@yaar/frontend`): React + Zustand + Vite. Renders windows based on OS Actions. See `packages/frontend/CLAUDE.md`.

2. **Server** (`@yaar/server`): TypeScript + ws. WebSocket server with pluggable AI providers. See `packages/server/CLAUDE.md`.

3. **Shared** (`@yaar/shared`): Shared types for OS Actions and WebSocket events. See `packages/shared/CLAUDE.md`.

## Code Style

- All packages: TypeScript strict mode
- Frontend: path alias `@/` → `src/`

## Apps System

YAAR has a convention-based apps system. Each folder in `apps/` becomes a desktop icon automatically.

### How It Works

1. **Frontend startup**: Calls `GET /api/apps` to list apps
2. **Desktop renders**: Shows one icon per app folder
3. **User clicks icon**: Sends `<user_interaction:click>app: {appId}</user_interaction:click>`
4. **AI reads skill**: Loads `apps/{appId}/SKILL.md` as context
5. **AI responds**: Uses skill instructions to help user

### Creating a New App

1. Create folder: `apps/myapp/`
2. Create `SKILL.md` with:
   - App description
   - API endpoints and authentication
   - Available actions
   - Example workflows
3. (Optional) Use `apps_write_config` to store credentials (saved to `storage/credentials/myapp.json`, git-ignored)

### Apps Tools (MCP)

| Tool | Description |
|------|-------------|
| `apps_list` | List all available apps |
| `apps_load_skill` | Load SKILL.md for an app |
| `apps_read_config` | Read config file (credentials.json reads from `storage/credentials/{appId}.json`) |
| `apps_write_config` | Write config file (credentials.json writes to `storage/credentials/{appId}.json`) |

### Example: Moltbook App

```
apps/moltbook/
└── SKILL.md           # API docs, auth flow, example usage

storage/credentials/
└── moltbook.json      # { "api_key": "moltbook_xxx" } (git-ignored)
```

When user clicks the Moltbook icon, the AI loads `SKILL.md` and can then help with registration, posting, viewing feed, etc.

**Note:** Old credentials at `apps/{appId}/credentials.json` are automatically migrated to `storage/credentials/{appId}.json` on first read.
