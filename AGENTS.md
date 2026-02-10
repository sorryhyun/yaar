# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notifications, etc.).

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
make dev                         # Start with auto-detected provider (opens at localhost:5173)
make claude                      # Start with Claude provider
make codex                       # Start with Codex provider
make claude-dev                  # Claude provider without MCP auth (local dev)
make codex-dev                   # Codex provider without MCP auth (local dev)
make build                       # Build all packages
pnpm typecheck                   # Type check all packages
make lint                        # Lint all packages
make clean                       # Clean generated files
make codex-types                 # Regenerate Codex protocol types (requires codex CLI)

# Run individual packages
make server                                  # Start server only
make frontend                                # Start frontend only

# Testing
pnpm --filter @yaar/frontend vitest run           # Run all frontend tests
pnpm --filter @yaar/frontend vitest run store     # Run tests matching "store"
pnpm --filter @yaar/server vitest run              # Run all server tests
pnpm --filter @yaar/shared vitest run              # Run all shared tests

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
│   ├── credentials/             # Centralized app credentials
│   │   └── moltbook.json       # API credentials for moltbook
│   ├── permissions.json         # Saved permission decisions
│   └── curl_allowed_domains.yaml # Allowed HTTP domains
├── docs/                        # Architecture documentation
│   ├── monitor_and_windows_guide.md              # Core concepts: Session, Monitor, Window
│   ├── common_flow.md           # Agent pools, context, message flow diagrams
│   └── claude_codex.md          # Claude vs Codex provider behavioral differences
├── storage/                     # Persistent data storage (git-ignored)
├── packages/
│   ├── shared/        # Shared types (OS Actions, WebSocket events, Component DSL)
│   ├── server/        # TypeScript WebSocket server
│   └── frontend/      # React frontend
├── pnpm-workspace.yaml
└── package.json
```

### Package Dependencies

```
@yaar/frontend ──┐
                  ├──> @yaar/shared (Zod v4 schemas, types)
@yaar/server ────┘
```

## Architecture

```
User Input → WebSocket → TypeScript Server → AI Provider (Claude/Codex) → OS Actions → Frontend Renders UI
```

Each package has its own `CLAUDE.md` with detailed architecture docs:
- **`packages/server/CLAUDE.md`** — Agent lifecycle, ContextPool, providers, MCP tools, REST API
- **`packages/frontend/CLAUDE.md`** — Zustand+Immer store, WebSocket hook, content renderers
- **`packages/shared/CLAUDE.md`** — OS Actions DSL, WebSocket events, Component DSL, Zod v4 patterns

### Key Architectural Concepts

1. **AI-driven UI**: No pre-built screens. The AI generates all UI via OS Actions (JSON commands).
2. **Session → Monitor → Window**: Three nested abstractions. Sessions own the conversation state and survive disconnections. Monitors are virtual desktops within a session, each with its own main agent. Windows are AI-generated UI surfaces within a monitor. See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for details.
3. **ContextPool**: Unified task orchestration — main messages processed sequentially per monitor, window messages in parallel. Uses `ContextTape` for hierarchical message history by source.
4. **Pluggable providers**: `AITransport` interface with factory pattern. Claude uses Agent SDK; Codex uses JSON-RPC over stdio. Dynamic imports keep SDK dependencies lazy.
5. **Warm Pool**: Providers pre-initialized at startup for instant first response. Auto-replenishes.
6. **MCP tools**: 4 namespaced HTTP servers (`system`, `window`, `storage`, `apps`) using `@modelcontextprotocol/sdk`.
7. **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections. Broadcasts to all connections in a session.
8. **Flat Component DSL**: No recursive trees — flat array with CSS grid layout for LLM simplicity.
9. **AsyncLocalStorage**: Tracks which agent is running for tool action routing via `getAgentId()`.
10. **Policy pattern**: Server decomposes complex behavior into focused policy classes:
    - `session-policies/` — `StreamToEventMapper`, `ProviderLifecycleManager`, `ToolActionBridge` (handle stream mapping, provider init, and MCP action routing)
    - `context-pool-policies/` — `MainQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy` (handle task queuing and prompt assembly)

See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for the Session/Monitor/Window mental model. See `docs/common_flow.md` for agent pool, context, and message flow diagrams. See `docs/claude_codex.md` for provider behavioral differences.

### Server Subsystems

Beyond agents and providers, the server has additional subsystems:
- **`reload/`** — Fingerprint-based cache for hot-reloading window content without re-querying AI
- **`lib/`** — Standalone utilities with no server internal dependencies:
  - `compiler/` — esbuild bundler for sandbox apps
  - `pdf/` — PDF rendering via poppler
  - `sandbox/` — Sandboxed JS/TS code execution (node:vm)
- **`logging/`** — Session logger (JSONL), session reader, context restore, and window restore

### Connection Lifecycle

```
WebSocket connects → SessionHub.getOrCreate(sessionId)
  → New session: LiveSession created with auto-generated ID
  → Reconnection: existing LiveSession returned (state preserved)
  → First message → ContextPool initialized → AgentPool created → Warm provider acquired
  → Messages routed: USER_MESSAGE → monitor's main queue (sequential), WINDOW_MESSAGE → window handler (parallel)
  → Window interaction → persistent window agent created on first interaction
  → WebSocket disconnects → session stays alive for reconnection
```

## Development Workflow

- `make dev` runs `scripts/dev.sh` which: builds shared package first → starts server → polls `/health` until ready → starts frontend
- Frontend dev server (port 5173) proxies `/ws` → `ws://localhost:8000` and `/api` → `http://localhost:8000`
- Git branch: uses `master` (not `main`)

## Code Style

- All packages: TypeScript strict mode, ESM (`"type": "module"`)
- Frontend: path alias `@/` → `src/`, CSS Modules for component styles
- Shared package: Zod v4 (use getter pattern for recursive types, not `z.lazy()`)
- Server imports use `.js` extensions (ESM requirement for Node.js)
- ESLint: `_`-prefixed unused args allowed, `no-explicit-any` is warning-only

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
3. (Optional) Use `apps_write_config` to store credentials (saved to `config/credentials/myapp.json`, git-ignored)

### Apps Tools (MCP)

| Tool | Description |
|------|-------------|
| `apps_list` | List all available apps |
| `apps_load_skill` | Load SKILL.md for an app |
| `apps_read_config` | Read config file (credentials.json reads from `config/credentials/{appId}.json`) |
| `apps_write_config` | Write config file (credentials.json writes to `config/credentials/{appId}.json`) |

### Example: Moltbook App

```
apps/moltbook/
└── SKILL.md           # API docs, auth flow, example usage

config/credentials/
└── moltbook.json      # { "api_key": "moltbook_xxx" } (git-ignored)
```

When user clicks the Moltbook icon, the AI loads `SKILL.md` and can then help with registration, posting, viewing feed, etc.

**Note:** Old credentials at `apps/{appId}/credentials.json` or `storage/credentials/{appId}.json` are automatically migrated to `config/credentials/{appId}.json` on first read.
