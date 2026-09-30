# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notifications, etc.).

**Prerequisites:**
- Bun >= 1.4.2 (runtime and package manager)
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDKs:**
- **Claude:** Uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access. See [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) for API documentation.
- **Codex:** Uses `codex app-server` over JSON-RPC, with hand-generated protocol bindings (`make codex-types`). A CLI older than `CODEX_MIN_VERSION` is **refused**, not driven — see the `codex-provider` skill and [docs/reference/codex_protocol.md](./docs/reference/codex_protocol.md).

## Commands

```bash
bun install                      # Install all dependencies
make dev                         # Start with auto-detected provider (single port, default localhost:8000)
make claude                      # Start with Claude provider (REMOTE=1, serves from port 8000)
make codex                       # Start with Codex provider (REMOTE=1, serves from port 8000)
make claude-dev                  # Claude provider without MCP auth (local dev)
make claude-dev-mobile           # Same, but the browser is a phone (see MOBILE below)
make codex-dev                   # Codex provider without MCP auth (local dev)
make termux                      # Claude provider on Android/Termux (docs/guides/termux.md)
make build                       # Build all packages
bun run typecheck                # Type check all packages
make lint                        # Lint all packages
make clean                       # Clean generated files
make mobile-bench                # Phone-shell perf: mock agent, N monitors × M windows (bench/mobile/report.md)
make screencast-bench            # Live-browser stream: JPEG vs WebCodecs on a recorded scroll (bench/screencast/)
make codex-types                 # Regenerate Codex protocol types (requires codex CLI >= CODEX_MIN_VERSION)
bun run format                   # Format all files with Prettier
bun run format:check             # Check formatting without writing

# Run individual packages
make server                                  # Start server only

# Apps (workflows: the app-dev skill)
bun run build:apps [appId...] [--typecheck]  # Compile stale apps, or the named ids stale or not
bun run check:apps                           # App guardrail lint (no localStorage, etc.)

# Testing (details: the yaar-testing skill)
bun run --filter @yaar/<pkg> test    # Per-package: frontend, server, shared, lib, compiler, tests
bun run test                         # Everything (what CI runs)

# Standalone executable (requires Bun)
bun run build:exe                # Build Windows executable
bun run build:exe:bundle:linux   # Build Linux executable
bun run build:exe:bundle:macos   # Build macOS executable (on a Mac: also dist/YAAR.app)
bun scripts/build/webview-native.ts  # Build the exe's native WebView library (macOS; build:exe:bundle:macos runs it)
```

Every `bun test` is environment-pinned (preloads `scripts/test/env.ts`), and a run mixing test
partitions is **refused** with the correct command for each. Details: the `yaar-testing` skill.

## Environment Variables

One line each; defaults, rationale and the full list: [`docs/reference/server_env.md`](./docs/reference/server_env.md) and the table in `packages/server/CLAUDE.md`.

- `PROVIDER` - Force `claude` or `codex` (auto-detected if unset)
- `FABLE` - `1`: monitor agent on Fable, every agent below it on Opus
- `PORT` - Server port (default 8000)
- `MAX_AGENTS` - Global agent limit (default 10)
- `APP_AGENT_IDLE_MINUTES` - Idle minutes before an app agent is reclaimed (default 60, `0` disables)
- `MCP_SKIP_AUTH` - Skip MCP authentication for local development
- `YAAR_WORKSPACE` - Isolated state bundle under `workspaces/<name>/` (storage, config, session logs, user-apps, new deploys)
- `REMOTE` - Remote mode with token auth and QR code ([`docs/guides/remote_mode.md`](./docs/guides/remote_mode.md))
- `YAAR_REMOTE_TOKEN` - Use this remote token instead of minting one (ignored under 32 chars)
- `LAUNCH_CHROME` - `1` opens a local debuggable Chrome on the desktop once the server is up (set by the `make claude*`/`codex*` targets)
- `YAAR_COMPANION_TAB` - Park a second, always-visible desktop in a server-side browser so page round trips answer while the user's client is backgrounded (on for Android, off elsewhere; `1`/`0` force)
- `YAAR_ML_COMPUTE` - Where `@bundled/yaar-ml` sessions run: `auto` (default), `chrome`, `local`
- `MOBILE` - `1` makes the launched Chrome a phone: own profile, phone-shaped window, and mouse drags turned into real touch events over CDP by `scripts/dev/emulate-mobile.ts`. Nothing pins `?ui=` — a desktop layout means the emulation did not land. Viewport `YAAR_MOBILE_VIEWPORT=WxH` (default `412x915`); turns on `YAAR_COMPANION_TAB`; `curl -X POST localhost:9231/background` (then `/foreground`) backgrounds the phone the way Android does. Works on any target (`MOBILE=1 make codex-dev`)
- `YAAR_FREEDPI` - Route outbound TLS through a local fragmenting proxy past SNI-matching DPI (**on** by default, `0` disables)
- `YAAR_WEBVIEW` - Bundled exe only: `0` opens Chrome/Edge `--app` instead of YAAR's own WebView window
- `CLAUDE_CODE_PATH` - Absolute path to the `claude` binary; overrides discovery (bundled exe → `~/.local/bin/claude` → `PATH`)
- `CLAUDE_CODE_OAUTH_TOKEN` - Inherited by the spawned `claude` CLI for non-interactive auth (alternative to `claude login`)

## Running YAAR Headlessly (Agents Driving YAAR)

Drive YAAR **like a user, through the browser** — internal HTTP routes and WebSocket frames are
not the supported entry point, and never drive YAAR through YAAR's own Browser app. Workflow: the
`headless-driving` skill; walkthrough: [`docs/guides/headless_driving.md`](./docs/guides/headless_driving.md).

## Monorepo Structure

```
yaar/
├── apps/                        # Convention-based apps (each folder = one app)
│   ├── dock/                    # Taskbar/dock panel app
│   ├── storage/                 # File storage browser app
│   └── ...                      # Other bundled apps (devtools, browser, memo, etc.)
├── config/                      # User config (git-ignored)
│   ├── credentials/             # Centralized app credentials (git-ignored)
│   ├── permissions.json         # Saved permission decisions
│   ├── hooks.json               # Event-driven hooks config
│   └── curl_allowed_domains.yaml # Allowed HTTP domains
├── scripts/                     # Repo tooling, one folder per job
│   ├── bench/ build/ check/     # benchmarks; build+prebundle; app & doc lint
│   ├── codegen/ dev/ release/   # generated files; launchers; version+release
│   ├── test/                    # test env pinning, root preload, partition rule+guard
│   └── lib/                     # helpers shared between scripts
├── docs/                        # Documentation
│   ├── architecture/            # Concept & rationale docs (intuition-first)
│   ├── reference/               # Precise schemas, protocols, API tables
│   └── faq.md                   # Why-is-it-like-this introduction
├── session_logs/                # AI conversation logs, timestamp-named dirs (git-ignored)
├── storage/                     # Persistent data storage (git-ignored)
├── packages/
│   ├── shared/        # Shared types (OS Actions, WebSocket events, Component DSL)
│   ├── lib/           # Generic utilities with no YAAR domain knowledge (fonts, pdf, ssrf, freedpi, tunnel, ytdlp)
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
               ├──> @yaar/compiler ──> @yaar/shared
               └──> @yaar/lib ──────> @yaar/shared
```

`@yaar/lib` holds utilities that are **not about YAAR**; nothing in it may import from the server.
The rule and the inversion pattern for config-reading modules: `packages/lib/CLAUDE.md`.

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
2. **Session → Monitor → Window**: Sessions own the conversation state and survive disconnections. Monitors are virtual desktops within a session, each with its own monitor agent. Windows are AI-generated UI surfaces within a monitor. See [`docs/architecture/monitor_and_windows_guide.md`](./docs/architecture/monitor_and_windows_guide.md).
3. **ContextPool**: Unified task orchestration — main messages processed sequentially per monitor, app window messages via AppTaskProcessor. Uses `ContextTape` for hierarchical message history by source.
4. **Pluggable providers**: `AITransport` interface with factory pattern. Claude uses Agent SDK; Codex uses JSON-RPC over WebSocket (each provider gets its own connection). Dynamic imports keep SDK dependencies lazy.
5. **Warm Pool**: Providers pre-initialized at startup for instant first response. Auto-replenishes.
6. **MCP tools**: One HTTP server (`@modelcontextprotocol/server`), 5 generic URI verbs (`describe`, `read`, `list`, `invoke`, `delete`) routed via `yaar://` URIs. Namespaces (`CORE_SERVERS`): `system`, `verbs`, `app`, `messaging`, `subagent`. Serves only the stateless 2026-07-28 protocol revision; a client that cannot negotiate it is refused (`getModernHandler` in `mcp/server.ts`, the `server-verbs` skill).
7. **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections. Broadcasts to all connections in a session.
8. **Flat Component DSL**: No recursive trees — flat array with CSS grid layout for LLM simplicity.
9. **AsyncLocalStorage**: Tracks which agent is running for tool action routing via `getAgentId()`.
10. **Policy pattern**: Server decomposes complex behavior into focused policy classes:
    - `session-policies/` — `StreamToEventMapper` (maps a provider stream to server events; emitted OS Actions are delivered by `LiveSession.handleEmittedAction`)
    - `context-pool-policies/` — `MonitorQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy`, `MonitorBudgetPolicy`, `WindowSubscriptionPolicy` (handle task queuing, prompt assembly, monitor rate limits, and window change notifications)

More: [`os_architecture.md`](./docs/architecture/os_architecture.md) (YAAR as an OS), [`monitor_and_windows_guide.md`](./docs/architecture/monitor_and_windows_guide.md) (agent tree, message flow, what each agent remembers), `docs/reference/claude_codex.md` (provider differences), `docs/guides/hooks.md` (`config/hooks.json`), `docs/guides/remote_mode.md`.

### Server Subsystems

Beyond agents and providers (directory map: `packages/server/CLAUDE.md`):
- **`reload/`** — Fingerprint-based cache for hot-reloading window content without re-querying AI
- **`lib/`** — Utilities that need server internals, e.g. `browser/` (CDP automation, see [`docs/architecture/browser_automation.md`](./docs/architecture/browser_automation.md)) and the `yaar://` URI/protocol/log helpers. The generic half is `@yaar/lib` (`packages/lib/`, imported by subpath such as `@yaar/lib/ssrf`) — contents table in `packages/lib/CLAUDE.md`.
- **`logging/`** — Session logger (JSONL), session reader, context restore, and window restore. Logs at `session_logs/{YYYY-MM-DD_HH-MM-SS}/`; each launch prunes logs that recorded nothing (`logging/prune.ts`, `YAAR_KEEP_EMPTY_SESSIONS=1` keeps them)

### Connection Lifecycle

```
WebSocket connects → SessionHub.getOrCreate(sessionId)
  → New session: LiveSession created with auto-generated ID
  → Reconnection: existing LiveSession returned (state preserved)
  → First message → ContextPool initialized → AgentPool created → Warm provider acquired
  → Messages routed: USER_MESSAGE → monitor's main queue (sequential), WINDOW_MESSAGE/COMPONENT_ACTION → monitor agent (plain windows) or AppTaskProcessor (app windows)
  → App window interaction → app agent created on first interaction (keyed by `monitorId::appId` — one per app per monitor, not shared across monitors), retired when the app's last window on that monitor closes
  → WebSocket disconnects → session stays alive for reconnection
```

## Development Workflow

- `make dev` runs `scripts/dev/start.sh` which: builds shared package first → starts server (serves both API and frontend on single port)
- Git branches: `dev` is where work lands; `main` is the stable, clone-default branch and only receives merges from `dev`. Open PRs against `dev` unless the change is a release promotion.
- **Pre-commit hooks**: Husky runs `lint-staged` on commit — applies Prettier + ESLint fix to staged files automatically
- **CI & release**: `.github/workflows/checks.yml` is the one definition of "is this tree good?" (three escalating tiers). Its job id must stay `check`, and `ci.yml`'s must stay `ci` (branch protection requires `ci / check`). Release flow and tiers: the `release` skill and [`docs/reference/release_process.md`](./docs/reference/release_process.md).

### Subagent Model Selection

When the main agent is **Fable**, always pass an explicit `model` to the `Agent` tool — one of `opus`, `sonnet`, or `haiku`. Omitting it makes the subagent inherit Fable, which is not what we want for delegated work.

- **`sonnet`** — the default choice for almost everything (code search, edits, tests, docs).
- **`opus`** — hard debugging, architecture design, tricky multi-file refactors.
- **`haiku`** — trivial mechanical work (renames, one-line lookups, formatting sweeps).

## Code Style

- All packages: TypeScript strict mode, ESM (`"type": "module"`)
- Frontend: path alias `@/` → `src/`, CSS Modules for component styles
- Shared package: Zod v4 (use getter pattern for recursive types, not `z.lazy()`)
- Server imports use `.js` extensions (ESM requirement)
- ESLint: `_`-prefixed unused args allowed, `no-explicit-any` is warning-only
- Prettier: semi, singleQuote, trailingComma all, tabWidth 2, printWidth 100

## Design System

Token values are hand-written only in `packages/shared/src/design/tokens.ts`; every other surface
is generated from it (a frontend test fails if `tokens.css` drifts). `make design` regenerates
tokens and preview cards. Rules, exception registry, and the design-canvas review loop:
[`docs/architecture/design_system.md`](./docs/architecture/design_system.md).

## Apps System

Each folder in `apps/` is an app (`app.json` metadata, `protocol.json` agent-iframe protocol,
compiled via Bun into one self-contained HTML file). Conventions: [`apps/CLAUDE.md`](./apps/CLAUDE.md);
build/verify workflows: the `app-dev` skill; pipeline, SDK, manifest and protocol docs are linked
from `apps/CLAUDE.md`.

The authoritative bundled-library list is `BUNDLED_LIBRARIES` in
`packages/compiler/src/bundled/registry.ts` — linted by `scripts/check/doc-freshness.ts`; don't
keep a second copy anywhere.
