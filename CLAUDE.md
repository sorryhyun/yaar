# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notifications, etc.).

**Prerequisites:**
- Bun >= 1.1 (runtime and package manager)
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDKs:**
- **Claude:** Uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access. See [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) for API documentation.
- **Codex:** Uses `codex app-server` for JSON-RPC communication. See [docs/codex_protocol.md](./docs/codex_protocol.md) for protocol details.

## Commands

```bash
bun install                      # Install all dependencies
make dev                         # Start with auto-detected provider (opens at localhost:5173)
make claude                      # Start with Claude provider (REMOTE=1, serves from port 8000)
make codex                       # Start with Codex provider (REMOTE=1, serves from port 8000)
make claude-dev                  # Claude provider without MCP auth (local dev)
make codex-dev                   # Codex provider without MCP auth (local dev)
make build                       # Build all packages
bun run typecheck                # Type check all packages
make lint                        # Lint all packages
make clean                       # Clean generated files
make codex-types                 # Regenerate Codex protocol types (requires codex CLI)
bun run format                   # Format all files with Prettier
bun run format:check             # Check formatting without writing

# Run individual packages
make server                                  # Start server only
make frontend                                # Start frontend only

# Testing
bun run --filter @yaar/frontend test                 # Run all frontend tests
bun run --filter @yaar/server test                    # Run all server tests
bun run --filter @yaar/shared test                    # Run all shared tests

# Standalone executable (requires Bun)
bun run build:exe                # Build Windows executable
bun run build:exe:bundle:linux   # Build Linux executable
bun run build:exe:bundle:macos   # Build macOS executable
```

## Environment Variables

- `PROVIDER` - Force a specific AI provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000)
- `MAX_AGENTS` - Global agent limit (default: 10)
- `MCP_SKIP_AUTH` - Skip MCP authentication for local development
- `REMOTE` - Enable remote mode with token auth and QR code for network access. See `docs/remote_mode.md`
- `CLAUDE_CODE_PATH` - Absolute path to the `claude` binary. Overrides discovery (bundled exe → `~/.local/bin/claude` → `PATH`).
- `CLAUDE_CODE_OAUTH_TOKEN` - Inherited by the spawned `claude` CLI for non-interactive auth (alternative to `claude login`).

## Running YAAR Headlessly (Agents Driving YAAR)

YAAR can be launched and driven by an external agent — including from inside another Claude Code session. The Claude provider spawns the `claude` CLI as a subprocess; the harness scrubs nested-Claude env vars before the spawn (see `providers/claude/session-provider.ts`), so it works inside cloud sandboxes without IPC clashes.

**Launch (cloud / headless):**

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # required if not already logged in
export CLAUDE_CODE_PATH=/path/to/claude           # optional; only if not in ~/.local/bin or PATH
make claude-dev                                   # PROVIDER=claude, MCP_SKIP_AUTH=1, port 8000
# server is ready when you see "[banner] YAAR running at ..."
```

**Drive YAAR like a user — through the browser.** YAAR is a desktop UI; an external agent should use it the way a person does, via Chromium and the command palette. Internal HTTP routes (`/api/*`) and WebSocket frames (`USER_MESSAGE` etc.) are YAAR's own plumbing — used by the frontend and bundled tools — and are **not** the supported entry point for outside automation. Driving via the browser exercises the real user surface, makes failures visible (you can screenshot), and avoids coupling external agents to internal event schemas that may change.

**Recommended flow** (any CDP client works — Playwright, Puppeteer, the `claude-in-chrome` MCP tools, or YAAR's own `yaar-web` SDK from inside an app):

```
1. Launch Chromium pointed at http://127.0.0.1:8000
2. Wait for the desktop to render (the command palette textarea appears at the bottom)
3. Click/focus the textarea (it's the only <textarea> on the page)
4. Type your prompt
5. Press Enter to submit (Shift+Enter inserts a newline; Enter sends)
6. Optionally press Shift+Tab to toggle the CLI panel and watch the agent stream
```

Minimal example using the `claude-in-chrome` MCP tools available to an agent:

```
navigate("http://127.0.0.1:8000")
form_input(selector: "textarea", text: "create a memo window saying hello")
press(key: "Enter", selector: "textarea")
press(key: "Shift+Tab")                       # open CLI panel to watch streaming
```

`press()` now correctly handles modifier prefixes (`Shift+Tab`, `Ctrl+1`, `Meta+P`); navigation timeouts resolve with `null` instead of rejecting, so a stalled page doesn't crash the server.

**Caveats for agent-driven sessions:**
- Don't drive YAAR through YAAR's own Browser app — that nests YAAR inside YAAR and produces recursive rendering plus duplicate-element selectors.
- The desktop sometimes auto-opens a Browser window when YAAR detects a browsing-related need; for clean demos, drive YAAR from a separate Chromium instance you control, not from a window inside YAAR.
- Take a screenshot before each action — the AI may have moved/added windows since your last view.

**Watching the agent's reasoning:** `Shift+Tab` toggles the CLI panel (`DesktopSurface.tsx:84`), which streams every assistant token, tool call, and OS Action live. For shell-based monitoring, tail the JSONL log:

```bash
tail -f session_logs/$(ls -t session_logs | head -1)/*.jsonl
```

**Running an AI agent inside YAAR from a parent agent (Claude-in-Claude):** the parent agent (this Claude Code session) launches `make claude-dev`, opens Chromium at `http://127.0.0.1:8000`, and types prompts into the command palette like a user. YAAR's own Claude provider spawns its own `claude` subprocess to handle each prompt — that's two separate Claude sessions stacked. The env-scrub in `session-provider.ts` is what makes this stacking work; without it the inner `claude` inherits the outer's FD-based auth and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, and immediately exits with code 1.

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
├── session_logs/                # AI conversation logs, timestamp-named dirs (git-ignored)
├── storage/                     # Persistent data storage (git-ignored)
├── packages/
│   ├── shared/        # Shared types (OS Actions, WebSocket events, Component DSL)
│   ├── compiler/      # App compiler (@bundled/* resolution, Bun.build, typecheck)
│   ├── server/        # TypeScript WebSocket server
│   └── frontend/      # React frontend
└── package.json
```

### Package Dependencies

```
@yaar/frontend ──────┐
                      ├──> @yaar/shared (Zod v4 schemas, types)
@yaar/server ──┬─────┘
               └──> @yaar/compiler ──> @yaar/shared
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
2. **Session → Monitor → Window**: Three nested abstractions. Sessions own the conversation state and survive disconnections. Monitors are virtual desktops within a session, each with its own monitor agent. Windows are AI-generated UI surfaces within a monitor. See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for details.
3. **ContextPool**: Unified task orchestration — main messages processed sequentially per monitor, app window messages via AppTaskProcessor. Uses `ContextTape` for hierarchical message history by source.
4. **Pluggable providers**: `AITransport` interface with factory pattern. Claude uses Agent SDK; Codex uses JSON-RPC over WebSocket (each provider gets its own connection). Dynamic imports keep SDK dependencies lazy.
5. **Warm Pool**: Providers pre-initialized at startup for instant first response. Auto-replenishes.
6. **MCP tools**: Served via a single HTTP server using `@modelcontextprotocol/sdk`. 5 generic URI verbs (`describe`, `read`, `list`, `invoke`, `delete`) routed via `yaar://` URIs — only `system` + `verbs` namespaces active.
7. **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections. Broadcasts to all connections in a session.
8. **Flat Component DSL**: No recursive trees — flat array with CSS grid layout for LLM simplicity.
9. **AsyncLocalStorage**: Tracks which agent is running for tool action routing via `getAgentId()`.
10. **Policy pattern**: Server decomposes complex behavior into focused policy classes:
    - `session-policies/` — `StreamToEventMapper`, `ProviderLifecycleManager`, `ToolActionBridge` (handle stream mapping, provider init, and MCP action routing)
    - `context-pool-policies/` — `MainQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy`, `MonitorBudgetPolicy`, `WindowSubscriptionPolicy` (handle task queuing, prompt assembly, monitor rate limits, and window change notifications)

See [`docs/os_architecture.md`](./docs/os_architecture.md) for how YAAR maps to OS concepts (kernel, processes, syscalls, boot, etc.). See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for the Session/Monitor/Window mental model. See `docs/common_flow.md` for agent pool, context, and message flow diagrams. See `docs/claude_codex.md` for provider behavioral differences. See `docs/hooks.md` for the event-driven hooks system (`config/hooks.json`) and `docs/remote_mode.md` for network access.

### Server Subsystems

Beyond agents and providers, the server has additional subsystems:
- **`reload/`** — Fingerprint-based cache for hot-reloading window content without re-querying AI
- **`lib/`** — Standalone utilities with no server internal dependencies:
  - `browser/` — CDP browser automation (direct Chrome DevTools Protocol, conditional on Chrome availability)
  - `bundled-types/` — Per-library `.d.ts` files for `@bundled/*` imports (used by `apps/tsconfig.json`)
  - `compiler/` — Bun bundler for app development
  - `pdf/` — PDF rendering via poppler
  - `sandbox/` — Sandboxed JS/TS code execution (node:vm)
- **`logging/`** — Session logger (JSONL), session reader, context restore, and window restore. Logs stored at `session_logs/{YYYY-MM-DD_HH-MM-SS}/`

### Connection Lifecycle

```
WebSocket connects → SessionHub.getOrCreate(sessionId)
  → New session: LiveSession created with auto-generated ID
  → Reconnection: existing LiveSession returned (state preserved)
  → First message → ContextPool initialized → AgentPool created → Warm provider acquired
  → Messages routed: USER_MESSAGE → monitor's main queue (sequential), WINDOW_MESSAGE/COMPONENT_ACTION → monitor agent (plain windows) or AppTaskProcessor (app windows)
  → App window interaction → persistent app agent created on first interaction (keyed by appId)
  → WebSocket disconnects → session stays alive for reconnection
```

## Development Workflow

- `make dev` runs `scripts/dev.sh` which: builds shared package first → starts server (serves both API and frontend on single port)
- Git branch: uses `master` (not `main`)
- **Pre-commit hooks**: Husky runs `lint-staged` on commit — applies Prettier + ESLint fix to staged files automatically
- **CI** (`.github/workflows/ci.yml`): `bun install` → build shared → typecheck → test (runs on push/PR to master)

## Code Style

- All packages: TypeScript strict mode, ESM (`"type": "module"`)
- Frontend: path alias `@/` → `src/`, CSS Modules for component styles
- Shared package: Zod v4 (use getter pattern for recursive types, not `z.lazy()`)
- Server imports use `.js` extensions (ESM requirement)
- ESLint: `_`-prefixed unused args allowed, `no-explicit-any` is warning-only
- Prettier: semi, singleQuote, trailingComma all, tabWidth 2, printWidth 100

## Apps System

Convention-based: each folder in `apps/` becomes an app. `app.json` for metadata, `SKILL.md` for AI context, `protocol.json` for agent-iframe communication. See [`docs/app-development.md`](./docs/app-development.md) for full URI verbs reference and [`docs/app_protocol_reference.md`](./docs/app_protocol_reference.md) for protocol details.

### App Agent Architecture

When a user interacts with an app window, a **persistent app agent** is created (one per `appId`, reused across all windows of that app). App agents have only 3 tools: `query` (read iframe state), `command` (execute iframe action), `relay` (hand off to monitor agent).

**Prompt priority:** `AGENTS.md` (full custom prompt, replaces generic) > `SKILL.md` (appended to generic prompt). `protocol.json` manifest is always appended. Use `AGENTS.md` for apps like devtools that need precise agent behavior; `SKILL.md` for simpler apps where the generic prompt suffices. `HINT.md` is separate — its content is injected into the **monitor agent's** system prompt (not the app agent's), providing orchestration hints that auto-sync with app install/uninstall.

Key files: `agents/app-task-processor.ts` (routing), `agents/agent-pool.ts` (lifecycle), `agents/profiles/app-agent.ts` (prompt builder), `mcp/app-agent/` (query/command/relay tools).

### Compiler & Bundled Libraries

Apps are compiled via Bun into a single self-contained HTML file. Entry point is always `src/main.ts`. The compiler injects design tokens, SDK scripts (capture, storage, verb, app-protocol, etc.), and the bundled code.

**`@bundled/*` imports** — no `npm install` needed. Available libraries:
- **UI**: `solid-js`, `solid-js/html`, `solid-js/web` (preferred framework)
- **Utilities**: `uuid`, `lodash`, `date-fns`, `clsx`, `diff`, `diff2html`
- **Graphics/3D**: `three`, `konva`, `pixi.js`, `p5`, `matter-js`
- **Data/Charts**: `chart.js`, `d3`, `xlsx`
- **Animation**: `anime`
- **Audio**: `tone`
- **Parsing**: `marked`, `prismjs`, `mammoth`
- **YAAR SDK**: `yaar` — `read`, `invoke`, `list`, `describe`, `app.register()`, `appStorage`, etc.
- **Gated SDKs** (require `"bundles"` in `app.json`): `yaar-dev` (compile, typecheck, deploy), `yaar-web` (browser automation: open, click, extract, etc.)

Key files: `packages/compiler/src/compile.ts` (Bun.build + HTML wrapper), `packages/compiler/src/plugins.ts` (bundled library resolution + gated SDK enforcement), `packages/compiler/src/shims/` (yaar.ts, yaar-dev.ts, yaar-web.ts), `packages/compiler/src/extract-protocol.ts` (manifest extraction from source), `packages/compiler/src/bundled-types/` (.d.ts files for typecheck).

### Design Tokens

All compiled apps get YAAR CSS custom properties and utility classes injected automatically:
- **Colors**: `--yaar-bg`, `--yaar-bg-surface`, `--yaar-text`, `--yaar-text-muted`, `--yaar-accent`, `--yaar-border`, `--yaar-success`, `--yaar-error`
- **Spacing**: `--yaar-sp-1` through `--yaar-sp-4` (4px increments), `--yaar-sp-8` (32px)
- **Layout**: `y-app` (root container), `y-flex`, `y-flex-col`, `y-toolbar`, `y-sidebar`, `y-tabs`, `y-modal`, `y-empty` (centered placeholder with `y-empty-icon`)
- **Components**: `y-btn`, `y-btn-primary`, `y-btn-ghost`, `y-btn-danger`, `y-input`, `y-select`, `y-card`, `y-badge`, `y-spinner`, `y-toast`, `y-list-item` (interactive row with hover/`.active` states)
- **Typography**: `y-label` (uppercase muted section header), `y-truncate` (single-line), `y-clamp-2`, `y-clamp-3` (multi-line truncation)

Always use `var(--yaar-*)` for colors — never hardcode. Use `y-*` utility classes for common patterns.

### Solid.js Gotchas

Apps use Solid.js with `html` tagged templates (not JSX). Known issues:
- **Empty templates crash**: Use `null` instead of `` html`` ``
- **`flex: 1` breaks reactivity**: Use `position: absolute; inset: 0` instead
- **Closing tags**: `</${Component}>` is auto-fixed by compiler plugin to `</>`
- **Event handler props**: Can re-fire during render if passed as reactive props — bind handlers outside reactive scope
