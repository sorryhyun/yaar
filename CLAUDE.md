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
make claude                      # Start with Claude provider (REMOTE=1, serves from port 8000)
make codex                       # Start with Codex provider (REMOTE=1, serves from port 8000)
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
pnpm --filter @yaar/frontend test                 # Run all frontend tests
pnpm --filter @yaar/frontend exec vitest run store  # Run tests matching "store"
pnpm --filter @yaar/server test                    # Run all server tests
pnpm --filter @yaar/shared test                    # Run all shared tests

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
│   ├── dock/                    # Taskbar/dock panel app
│   ├── storage/                 # File storage browser app
│   └── ...                      # Other bundled apps (github-manager, pdf-viewer, etc.)
├── config/                      # User config (git-ignored)
│   ├── credentials/             # Centralized app credentials (git-ignored)
│   ├── permissions.json         # Saved permission decisions
│   ├── hooks.json               # Event-driven hooks config
│   └── curl_allowed_domains.yaml # Allowed HTTP domains
├── docs/                        # Architecture documentation
│   ├── monitor_and_windows_guide.md              # Core concepts: Session, Monitor, Window
│   ├── common_flow.md           # Agent pools, context, message flow diagrams
│   └── claude_codex.md          # Claude vs Codex provider behavioral differences
├── sandbox/                     # Temporary app development workspace (git-ignored)
├── session_logs/                # AI conversation logs, timestamp-named dirs (git-ignored)
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
6. **MCP tools**: 8 namespaced MCP endpoints (`system`, `window`, `storage`, `apps`, `user`, `dev`, `basic`, `browser`) served via a single HTTP server using `@modelcontextprotocol/sdk`.
7. **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections. Broadcasts to all connections in a session.
8. **Flat Component DSL**: No recursive trees — flat array with CSS grid layout for LLM simplicity.
9. **AsyncLocalStorage**: Tracks which agent is running for tool action routing via `getAgentId()`.
10. **Policy pattern**: Server decomposes complex behavior into focused policy classes:
    - `session-policies/` — `StreamToEventMapper`, `ProviderLifecycleManager`, `ToolActionBridge` (handle stream mapping, provider init, and MCP action routing)
    - `context-pool-policies/` — `MainQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy`, `WindowConnectionPolicy`, `MonitorBudgetPolicy` (handle task queuing, prompt assembly, and monitor rate limits)

See [`docs/os_architecture.md`](./docs/os_architecture.md) for how YAAR maps to OS concepts (kernel, processes, syscalls, boot, etc.). See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for the Session/Monitor/Window mental model. See `docs/common_flow.md` for agent pool, context, and message flow diagrams. See `docs/claude_codex.md` for provider behavioral differences. See `docs/hooks.md` for the event-driven hooks system (`config/hooks.json`) and `docs/remote_mode.md` for network access.

### Server Subsystems

Beyond agents and providers, the server has additional subsystems:
- **`reload/`** — Fingerprint-based cache for hot-reloading window content without re-querying AI
- **`lib/`** — Standalone utilities with no server internal dependencies:
  - `browser/` — CDP browser automation (direct Chrome DevTools Protocol, conditional on Chrome availability)
  - `bundled-types/` — Per-library `.d.ts` files for `@bundled/*` imports (used by `apps/tsconfig.json`)
  - `compiler/` — Bun bundler for sandbox apps
  - `pdf/` — PDF rendering via poppler
  - `sandbox/` — Sandboxed JS/TS code execution (node:vm)
- **`logging/`** — Session logger (JSONL), session reader, context restore, and window restore. Logs stored at `session_logs/{YYYY-MM-DD_HH-MM-SS}/`

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
  "fileAssociations": [],
  "variant": "standard",
  "dockEdge": "bottom",
  "frameless": false,
  "windowStyle": {},
  "protocol": { "state": {}, "commands": {} }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (defaults to title-cased folder name) |
| `description` | string | Brief description shown in `apps_list` output |
| `icon` | string | Emoji icon (overridden by `icon.png` if present) |
| `createShortcut` | boolean | Create desktop shortcut on install (default: true). `hidden: true` treated as `createShortcut: false` for backward compat |
| `appProtocol` | boolean | Supports bidirectional agent-iframe communication |
| `fileAssociations` | array | File extensions this app can open |
| `variant` | `'standard' \| 'widget' \| 'panel'` | Window layer when the app opens (default: `'standard'`) |
| `dockEdge` | `'top' \| 'bottom'` | Dock edge for panel variant |
| `frameless` | boolean | Hide the titlebar when the app opens |
| `windowStyle` | object | Custom CSS styles applied to the window element |
| `protocol` | object | Static manifest (`{ state, commands }`) appended to SKILL.md for agent discovery |

### System Apps

All apps are listed in the AI system prompt. Apps with `"createShortcut": false` in `app.json` won't get a desktop shortcut on install, but they're still fully accessible via `apps_list` and `load_skill`. Use this for system capabilities (like the dock or storage) that should run without a desktop icon.

### Creating a New App

1. Create folder: `apps/myapp/`
2. Create `SKILL.md` with:
   - App description
   - API endpoints and authentication
   - Available actions
   - Example workflows
3. (Optional) Add `app.json` with metadata (name, description, icon, hidden, etc.)
4. (Optional) Use `set_config(section: "app", appId, appConfig)` to store credentials (saved to `config/{appId}.json`, git-ignored)

### Apps Tools (MCP)

| Tool | Description |
|------|-------------|
| `apps_list` | List all available apps |
| `apps_load_skill` | Load SKILL.md for an app |
| `apps_set_app_badge` | Set badge count on a desktop app icon |
| `apps_market_list` | List apps available in the marketplace |
| `apps_market_get` | Download and install an app from the marketplace |
| `apps_market_delete` | Uninstall an app and its credentials |

App config (credentials, preferences) is managed via `system` config tools:
- `set_config(section: "app", appId, appConfig)` — merge config into `config/{appId}.json`
- `get_config(section: "app", appId?)` — read app config
- `remove_config(appId, appConfigKey?)` — remove app config key or entire file

### Example: GitHub Manager App

```
apps/github-manager/
├── SKILL.md           # API docs, auth flow, example usage
└── app.json           # { "icon": "🐙", "name": "GitHub Manager", "protocol": {...} }

config/
└── github-manager.json  # { "api_key": "ghp_xxx" } (git-ignored)
```

When user clicks the GitHub Manager icon, the AI loads `SKILL.md` and can then help with repos, issues, etc.

**Note:** Old credentials at `config/credentials/{appId}.json`, `apps/{appId}/credentials.json`, or `storage/credentials/{appId}.json` are automatically migrated to `config/{appId}.json` on first read.
