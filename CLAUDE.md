# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notifications, etc.).

**Prerequisites:**
- Bun >= 1.1 (server runtime)
- pnpm >= 10
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDKs:**
- **Claude:** Uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access. See [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) for API documentation.
- **Codex:** Uses `codex app-server` for JSON-RPC communication. See [docs/codex_protocol.md](./docs/codex_protocol.md) for protocol details.

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
pnpm format                      # Format all files with Prettier
pnpm format:check                # Check formatting without writing

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
- `REMOTE` - Enable remote mode with token auth and QR code for network access. See `docs/remote_mode.md`

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
4. **Pluggable providers**: `AITransport` interface with factory pattern. Claude uses Agent SDK; Codex uses JSON-RPC over WebSocket (each provider gets its own connection). Dynamic imports keep SDK dependencies lazy.
5. **Warm Pool**: Providers pre-initialized at startup for instant first response. Auto-replenishes.
6. **MCP tools**: 4 namespaced HTTP servers (`system`, `window`, `storage`, `apps`) using `@modelcontextprotocol/sdk`.
7. **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections. Broadcasts to all connections in a session.
8. **Flat Component DSL**: No recursive trees — flat array with CSS grid layout for LLM simplicity.
9. **AsyncLocalStorage**: Tracks which agent is running for tool action routing via `getAgentId()`.
10. **Policy pattern**: Server decomposes complex behavior into focused policy classes:
    - `session-policies/` — `StreamToEventMapper`, `ProviderLifecycleManager`, `ToolActionBridge` (handle stream mapping, provider init, and MCP action routing)
    - `context-pool-policies/` — `MainQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy` (handle task queuing and prompt assembly)

See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for the Session/Monitor/Window mental model. See `docs/common_flow.md` for agent pool, context, and message flow diagrams. See `docs/claude_codex.md` for provider behavioral differences. See `docs/hooks.md` for the event-driven hooks system (`config/hooks.json`) and `docs/remote_mode.md` for network access.

### Server Subsystems

Beyond agents and providers, the server has additional subsystems:
- **`reload/`** — Fingerprint-based cache for hot-reloading window content without re-querying AI
- **`lib/`** — Standalone utilities with no server internal dependencies:
  - `bundled-types/` — Per-library `.d.ts` files for `@bundled/*` imports (used by `apps/tsconfig.json`)
  - `compiler/` — Bun bundler for sandbox apps
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
- **Pre-commit hooks**: Husky runs `lint-staged` on commit — applies Prettier + ESLint fix to staged files automatically
- **CI** (`.github/workflows/ci.yml`): install → build shared → typecheck → test (runs on push/PR to master)

## Code Style

- All packages: TypeScript strict mode, ESM (`"type": "module"`)
- Frontend: path alias `@/` → `src/`, CSS Modules for component styles
- Shared package: Zod v4 (use getter pattern for recursive types, not `z.lazy()`)
- Server imports use `.js` extensions (ESM requirement)
- ESLint: `_`-prefixed unused args allowed, `no-explicit-any` is warning-only
- Prettier: semi, singleQuote, trailingComma all, tabWidth 2, printWidth 100

## Apps System

YAAR has a convention-based apps system. Each folder in `apps/` becomes a desktop icon automatically (unless hidden).

### How It Works

1. **Frontend startup**: Calls `GET /api/apps` to list apps
2. **Desktop renders**: Shows one icon per non-hidden app folder
3. **User clicks icon**: Sends `<ui:click>app: {appId}</ui:click>`
4. **AI reads skill**: Loads `apps/{appId}/SKILL.md` as context
5. **AI responds**: Uses skill instructions to help user

### `app.json` Schema

Each app folder can contain an `app.json` with optional metadata:

```json
{
  "name": "My App",
  "description": "Brief description of what the app does",
  "icon": "📦",
  "hidden": true,
  "appProtocol": false,
  "fileAssociations": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (defaults to title-cased folder name) |
| `description` | string | Brief description shown in `apps_list` output |
| `icon` | string | Emoji icon (overridden by `icon.png` if present) |
| `hidden` | boolean | If true, no desktop icon — AI knows about it via system prompt |
| `appProtocol` | boolean | Supports bidirectional agent-iframe communication |
| `fileAssociations` | array | File extensions this app can open |

### System Apps (Hidden)

Apps with `"hidden": true` in `app.json` don't show a desktop icon. Instead, their `SKILL.md` is automatically injected into the AI's system prompt so the AI knows about them immediately. Use this for system capabilities (like storage) that the AI should always know about.

### Creating a New App

1. Create folder: `apps/myapp/`
2. Create `SKILL.md` with:
   - App description
   - API endpoints and authentication
   - Available actions
   - Example workflows
3. (Optional) Add `app.json` with metadata (name, description, icon, hidden, etc.)
4. (Optional) Use `apps_write_config` to store credentials (saved to `config/credentials/myapp.json`, git-ignored)

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
