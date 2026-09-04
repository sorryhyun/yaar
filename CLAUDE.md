# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notifications, etc.).

**Prerequisites:**
- Bun >= 1.4 (runtime and package manager)
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDKs:**
- **Claude:** Uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access. See [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) for API documentation.
- **Codex:** Uses `codex app-server` for JSON-RPC communication, with hand-generated protocol bindings (`make codex-types`); a CLI older than `CODEX_MIN_VERSION` is **refused** rather than driven. Regeneration workflow and the refusal gates: the `codex-provider` skill. Protocol details: [docs/reference/codex_protocol.md](./docs/reference/codex_protocol.md).

## Commands

```bash
bun install                      # Install all dependencies
make dev                         # Start with auto-detected provider (single port, default localhost:8000)
make claude                      # Start with Claude provider (REMOTE=1, serves from port 8000)
make codex                       # Start with Codex provider (REMOTE=1, serves from port 8000)
make claude-dev                  # Claude provider without MCP auth (local dev)
make codex-dev                   # Codex provider without MCP auth (local dev)
make build                       # Build all packages
bun run typecheck                # Type check all packages
make lint                        # Lint all packages
make clean                       # Clean generated files
make codex-types                 # Regenerate Codex protocol types (requires codex CLI >= CODEX_MIN_VERSION)
bun run format                   # Format all files with Prettier
bun run format:check             # Check formatting without writing

# Run individual packages
make server                                  # Start server only

# Apps (workflows: the app-dev skill)
bun run build:apps [appId...] [--typecheck]  # Compile stale apps, or the named ids stale or not
bun run check:apps                           # App guardrail lint (no localStorage, etc.)

# Testing (details: the yaar-testing skill)
bun run --filter @yaar/<pkg> test    # Per-package: frontend, server, shared, compiler, tests
bun run test                         # Everything (what CI runs)

# Standalone executable (requires Bun)
bun run build:exe                # Build Windows executable
bun run build:exe:bundle:linux   # Build Linux executable
bun run build:exe:bundle:macos   # Build macOS executable
```

Test runs are environment-pinned (every `bun test` preloads `scripts/test/env.ts`, so a run
describes the code, not the machine) and process-partitioned (a run mixing partitions is
**refused**, printing the correct command for each). Commands, partition rationale, and
happy-dom caveats: the `yaar-testing` skill and `scripts/test/partitions.ts`.

## Environment Variables

- `PROVIDER` - Force a specific AI provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000)
- `MAX_AGENTS` - Global agent limit (default: 10)
- `APP_AGENT_IDLE_MINUTES` - Idle minutes before an app agent is reclaimed (default: 15, `0` disables). See `packages/server/CLAUDE.md`.
- `MCP_SKIP_AUTH` - Skip MCP authentication for local development
- `YAAR_WORKSPACE` - Run against an isolated state bundle: storage, config, session logs, and user-apps all under `workspaces/<name>/` (git-ignored), and new app deploys land there instead of `apps/`. See `docs/reference/server_env.md`.
- `REMOTE` - Enable remote mode with token auth and QR code for network access. See `docs/guides/remote_mode.md`
- `YAAR_REMOTE_TOKEN` - Use this remote-mode token instead of a freshly minted one (lets a launcher know the `#remote=<token>` URL up front). Ignored under 32 chars.
- `LAUNCH_CHROME` - `1` opens a local debuggable Chrome on the desktop once the server is up (set by `make claude`/`make claude-dev`)
- `YAAR_FREEDPI` - routes outbound TLS through a local fragmenting CONNECT proxy to get past SNI-matching DPI. **On by default**, `0` turns it off; hosts are learned, not configured, so an unblocked network pays a loopback hop and nothing else. See `docs/reference/server_env.md`
- `CLAUDE_CODE_PATH` - Absolute path to the `claude` binary. Overrides discovery (bundled exe → `~/.local/bin/claude` → `PATH`).
- `CLAUDE_CODE_OAUTH_TOKEN` - Inherited by the spawned `claude` CLI for non-interactive auth (alternative to `claude login`).

## Running YAAR Headlessly (Agents Driving YAAR)

YAAR can be launched and driven by an external agent — including from inside another Claude Code
session. Drive it **like a user, through the browser**; internal HTTP routes and WebSocket frames
are YAAR's own plumbing, **not** the supported entry point, and never drive YAAR through YAAR's
own Browser app. Workflow and hard rules: the `headless-driving` skill; full walkthrough:
[`docs/guides/headless_driving.md`](./docs/guides/headless_driving.md).

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
2. **Session → Monitor → Window**: Three nested abstractions. Sessions own the conversation state and survive disconnections. Monitors are virtual desktops within a session, each with its own monitor agent. Windows are AI-generated UI surfaces within a monitor. See [`docs/architecture/monitor_and_windows_guide.md`](./docs/architecture/monitor_and_windows_guide.md) for details.
3. **ContextPool**: Unified task orchestration — main messages processed sequentially per monitor, app window messages via AppTaskProcessor. Uses `ContextTape` for hierarchical message history by source.
4. **Pluggable providers**: `AITransport` interface with factory pattern. Claude uses Agent SDK; Codex uses JSON-RPC over WebSocket (each provider gets its own connection). Dynamic imports keep SDK dependencies lazy.
5. **Warm Pool**: Providers pre-initialized at startup for instant first response. Auto-replenishes.
6. **MCP tools**: Served via a single HTTP server using `@modelcontextprotocol/server`. 5 generic URI verbs (`describe`, `read`, `list`, `invoke`, `delete`) routed via `yaar://` URIs. Active namespaces (`CORE_SERVERS`): `system`, `verbs`, `app`, `messaging`, `subagent`. The endpoint serves **one protocol era** — the stateless 2026-07-28 revision, which both providers are asked to negotiate. The 2025-era stateful leg that used to catch a CLI that couldn't is gone, so such a client is now refused with a message naming its provider's opt-in gate. See `mcp/server.ts`'s `getModernHandler`.
7. **BroadcastCenter**: Singleton event hub decoupling agent lifecycle from WebSocket connections. Broadcasts to all connections in a session.
8. **Flat Component DSL**: No recursive trees — flat array with CSS grid layout for LLM simplicity.
9. **AsyncLocalStorage**: Tracks which agent is running for tool action routing via `getAgentId()`.
10. **Policy pattern**: Server decomposes complex behavior into focused policy classes:
    - `session-policies/` — `StreamToEventMapper`, `ToolActionBridge` (handle stream mapping and MCP action routing)
    - `context-pool-policies/` — `MonitorQueuePolicy`, `WindowQueuePolicy`, `ContextAssemblyPolicy`, `ReloadCachePolicy`, `MonitorBudgetPolicy`, `WindowSubscriptionPolicy` (handle task queuing, prompt assembly, monitor rate limits, and window change notifications)

See [`docs/architecture/os_architecture.md`](./docs/architecture/os_architecture.md) for how YAAR maps to OS concepts (kernel, processes, syscalls, boot, etc.). See [`docs/architecture/monitor_and_windows_guide.md`](./docs/architecture/monitor_and_windows_guide.md) for the Session/Monitor/Window mental model. See `docs/architecture/common_flow.md` for agent pool, context, and message flow diagrams. See `docs/reference/claude_codex.md` for provider behavioral differences. See `docs/guides/hooks.md` for the event-driven hooks system (`config/hooks.json`) and `docs/guides/remote_mode.md` for network access.

### Server Subsystems

Beyond agents and providers, the server has additional subsystems:
- **`reload/`** — Fingerprint-based cache for hot-reloading window content without re-querying AI
- **`lib/`** — Standalone utilities with no server internal dependencies:
  - `browser/` — CDP browser automation (direct Chrome DevTools Protocol, conditional on Chrome availability). Sessions are named and process-shaped: a persisted profile, a record that outlives the socket (`session-store.ts`), an idle sweep that spares a watched tab, and crash-restart with URL replay. Listed and killable at `yaar://system/browsers`
  - `pdf/` — PDF rendering via poppler
  - `ytdlp/` — optional yt-dlp binary wrapper (discovered on PATH/`~/.local/bin`/`YTDLP_PATH`, never bundled) behind `yaar://system/ytdlp`: YouTube audio download into the storage commons, with async jobs in `features/ytdlp/`
  - `tunnel/` — Tailscale Serve tunnel setup for remote mode
  - `download/` — chunked file download handling
  - `ssrf.ts` — SSRF protection (URL validation, safe fetch with redirect following)
  - `image.ts` — data-URL image parsing, plus `toWebPForModel()` — the WebP re-encode storage image reads and PDF rasterization apply on the way into a model context
  - plus single-file utilities: `ids.ts`, `open-url.ts`, `pick-directory.ts`, `format-interaction.ts`, `format-verb-log.ts`, `yaar-uri-server.ts`
- **`logging/`** — Session logger (JSONL), session reader, context restore, and window restore. Logs stored at `session_logs/{YYYY-MM-DD_HH-MM-SS}/`. Each launch mints one eagerly, so each launch also prunes the ones that recorded nothing first (`logging/prune.ts`, `YAAR_KEEP_EMPTY_SESSIONS=1` to keep them)

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
- Git branches: `dev` is where work lands; `main` is the stable branch (the default, so it is what `git clone` gives you) and only receives merges from `dev`; releases are cut by publishing a GitHub draft release targeting `main`. Open PRs against `dev` unless the change is a release promotion.
- **Pre-commit hooks**: Husky runs `lint-staged` on commit — applies Prettier + ESLint fix to staged files automatically
- **CI & release**: `.github/workflows/checks.yml` is the one definition of "is this tree good?" (three escalating tiers; its job id must stay `check`, and `ci.yml`'s must stay `ci`). Releases: `bun run release:prepare <version>` on `dev`, promote to `main`, publish a draft release targeting `main`. Tiers, rulesets, and the full flow: the `release` skill and [`docs/reference/release_process.md`](./docs/reference/release_process.md).

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

## Apps System

Convention-based: each folder in `apps/` becomes an app (`app.json` metadata, `protocol.json`
agent-iframe protocol, compiled via Bun into one self-contained HTML file). Conventions —
app-agent architecture, agent docs, design tokens, Solid gotchas, bundled libraries — live in
[`apps/CLAUDE.md`](./apps/CLAUDE.md); build/verify workflows in the `app-dev` skill. Guides:
[`docs/guides/app-development.md`](./docs/guides/app-development.md) (URI verbs),
[`docs/reference/app_protocol_reference.md`](./docs/reference/app_protocol_reference.md).

The authoritative bundled-library list is `BUNDLED_LIBRARIES` in
`packages/compiler/src/bundled/registry.ts` — linted by `scripts/check/doc-freshness.ts`; don't
keep a second copy anywhere.

