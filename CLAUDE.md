# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YAAR is a reactive AI interface where the AI decides what to show and do next. Instead of pre-built screens, users type into an always-ready input field and the AI creates UI dynamically through "OS Actions" (JSON commands that open windows, show notifications, etc.).

**Prerequisites:**
- Bun >= 1.3 (runtime and package manager)
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

**SDKs:**
- **Claude:** Uses `@anthropic-ai/claude-agent-sdk` for programmatic Claude access. See [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) for API documentation.
- **Codex:** Uses `codex app-server` for JSON-RPC communication. See [docs/reference/codex_protocol.md](./docs/reference/codex_protocol.md) for protocol details. The protocol bindings are hand-generated (`make codex-types`), so a CLI older than `CODEX_MIN_VERSION` (`providers/codex/version.ts`) is **refused** rather than driven — at generation time, at provider auto-detect, and at the `initialize` handshake. Forcing `PROVIDER=codex` with an unsupported CLI refuses the boot; auto-detect just skips it. See [Version policy](./docs/reference/codex_protocol.md#version-policy).

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

# Testing
bun run --filter @yaar/frontend test                 # Run all frontend tests
bun run --filter @yaar/server test                    # Run all server tests
bun run --filter @yaar/shared test                    # Run all shared tests
bun run --filter @yaar/tests test                     # Run integration/security tests

# Standalone executable (requires Bun)
bun run build:exe                # Build Windows executable
bun run build:exe:bundle:linux   # Build Linux executable
bun run build:exe:bundle:macos   # Build macOS executable
```

Test runs are environment-pinned and process-partitioned:

- Every `bun test` preloads `scripts/test/env.ts` (wired in each `bunfig.toml`), which scrubs
  `YAAR_*` and the knobs below and points config/storage/session-logs at temp dirs — a run describes the code,
  not the machine.
- Some test files cannot share a Bun process (`REMOTE=1` pinning, `mock.module` leaks, real
  sockets/git). A run mixing partitions is **refused** by `scripts/test/partition-guard.ts`, which
  prints the correct command for each. `bun test <path>` works from the repo root for any
  single-partition path; for everything at once use `bun run test` (what CI runs).
- The full rationale lives in `scripts/test/partitions.ts` and `packages/server/CLAUDE.md` (Tests).

## Environment Variables

- `PROVIDER` - Force a specific AI provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000)
- `MAX_AGENTS` - Global agent limit (default: 10)
- `MCP_SKIP_AUTH` - Skip MCP authentication for local development
- `REMOTE` - Enable remote mode with token auth and QR code for network access. See `docs/guides/remote_mode.md`
- `YAAR_REMOTE_TOKEN` - Use this remote-mode token instead of a freshly minted one (lets a launcher know the `#remote=<token>` URL up front). Ignored under 32 chars.
- `LAUNCH_CHROME` - `1` opens a local debuggable Chrome on the desktop once the server is up (set by `make claude`/`make claude-dev`)
- `CLAUDE_CODE_PATH` - Absolute path to the `claude` binary. Overrides discovery (bundled exe → `~/.local/bin/claude` → `PATH`).
- `CLAUDE_CODE_OAUTH_TOKEN` - Inherited by the spawned `claude` CLI for non-interactive auth (alternative to `claude login`).

## Running YAAR Headlessly (Agents Driving YAAR)

YAAR can be launched and driven by an external agent — including from inside another Claude Code
session (`make claude-dev` after exporting `CLAUDE_CODE_OAUTH_TOKEN`; the harness scrubs
nested-Claude env vars before the spawn, see `providers/claude/session-provider.ts`). Drive it
**like a user, through the browser** — Chromium at `http://127.0.0.1:8000`, type into the command
palette textarea (the only `<textarea>` on the page), Enter to send, `Shift+Tab` for the CLI panel.
Internal HTTP routes and WebSocket frames are YAAR's own plumbing, **not** the supported entry
point for outside automation. Never drive YAAR through YAAR's own Browser app (recursive
rendering), and screenshot before each action — the AI may have moved windows.

Full walkthrough, caveats, log-tailing, and the Claude-in-Claude stacking details:
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
6. **MCP tools**: Served via a single HTTP server using `@modelcontextprotocol/sdk`. 5 generic URI verbs (`describe`, `read`, `list`, `invoke`, `delete`) routed via `yaar://` URIs. Active namespaces (`CORE_SERVERS`): `system`, `verbs`, `app`, `messaging`, `subagent`.
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
  - `browser/` — CDP browser automation (direct Chrome DevTools Protocol, conditional on Chrome availability)
  - `pdf/` — PDF rendering via poppler
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
  → App window interaction → persistent app agent created on first interaction (keyed by `monitorId::appId` — one per app per monitor, not shared across monitors)
  → WebSocket disconnects → session stays alive for reconnection
```

## Development Workflow

- `make dev` runs `scripts/dev/start.sh` which: builds shared package first → starts server (serves both API and frontend on single port)
- Git branches: `dev` is where work lands; `main` is the stable branch (the default, so it is what `git clone` gives you) and only receives merges from `dev`; releases are cut by publishing a GitHub draft release targeting `main`. Open PRs against `dev` unless the change is a release promotion.
- **Pre-commit hooks**: Husky runs `lint-staged` on commit — applies Prettier + ESLint fix to staged files automatically
- **CI** (`.github/workflows/ci.yml`): thin caller for `.github/workflows/checks.yml` — the one definition of "is this tree good?", shared by CI and release so they cannot drift. Three escalating tiers: `dev` gets the baseline, anything touching `main` gets `full` (adds lint, format:check, check:apps), a release adds the version-vs-tag assertion and artifact smoke test. A check that should guard every push goes in the baseline; one that need only hold at ship time goes behind `full`.
- **Branch protection**: repo rulesets (not files) block deletion/force-push on `main`/`dev` and force-update on `v*` tags; `main` requires the `ci / check` status, so `ci.yml`'s job id must stay `check`.
- **Release**: `bun run release:prepare <version>` stamps the version on `dev`; the bump is promoted to `main` like any other change, then a draft release targeting `main` is published. On publish, `release.yml` re-verifies the pinned SHA with `full: true`, builds and smoke-tests artifacts, and publishes a `SHA256SUMS` manifest.
- Full detail — ruleset rationale, the `SHA256SUMS` integrity model, `GET /api/version`'s two version sources, `.bun-version` vs `engines.bun` — in [`docs/reference/release_process.md`](./docs/reference/release_process.md).

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

Convention-based: each folder in `apps/` becomes an app. `app.json` for metadata, `protocol.json` for agent-iframe communication — AI context is generated from the two at read time, with `agent/prompt.md` as an opt-in override (see below). See [`docs/guides/app-development.md`](./docs/guides/app-development.md) for full URI verbs reference and [`docs/reference/app_protocol_reference.md`](./docs/reference/app_protocol_reference.md) for protocol details.

### App Agent Architecture

When a user interacts with an app window, a **persistent app agent** is created (one per `monitorId::appId`, reused across all windows of that app on that monitor — not shared across monitors). App agents have four scoped tools — `describe` (an app's manual: its protocol plus its `agent/SKILL.md`, the same answer `describe('yaar://apps/{id}')` gives), `query` (read iframe state), `command` (execute iframe action), `relay` (hand off to monitor agent) — plus `direct_message` when `app.json` declares `"messaging": "all"`.

**Cross-app control:** `describe`/`query`/`command` take an optional `appId`. Omitting it targets the agent's own window; passing another app's id targets that app — gated by the caller's `app.json` `controls` list (**bundled apps only**), which can also restrict which commands may be issued. The target app needn't have an open window (`resolveTarget` reuses or auto-launches one). This is direct synchronous protocol control; `direct_message` to `app:{id}` is the natural-language alternative handled by the other app's own agent. Parsing and the bundled-only guard: `features/apps/discovery.ts`.

**Agent docs (`AGENT_DOCS` in `features/apps/discovery.ts`):** three files, three readers:

- `agent/prompt.md` — **replaces** the app agent's generic base prompt entirely (no append tier); either way the `protocol.json` manifest is appended as rendered call signatures.
- `agent/hint.md` — injected into the **monitor agent's** system prompt (orchestration hints, auto-synced with install/uninstall). Legacy root `HINT.md` still read with a warning.
- `agent/SKILL.md` — injected into no prompt; it is the hand-written manual `describe('yaar://apps/{id}')` returns beside `protocol.json` (workflows, ordering, when *not* to use the app). `scripts/check/apps.ts` warns when it restates the protocol.

Paths are configurable via `app.json`'s `agent: { prompt, hint, skill }` (traversing/absolute overrides ignored). Root `AGENTS.md` is deliberately **not** read as a prompt — it keeps its ecosystem meaning (instructions to a coding agent editing that directory). Clone and deploy carry all of these; the full rules and rationale live in `discovery.ts`'s doc comments.

Key files: `agents/app-task-processor.ts` (routing), `agents/agent-pool.ts` (lifecycle), `agents/profiles/app-agent.ts` (prompt builder), `mcp/app-agent/` (describe/query/command/relay tools).

### Sub-agents / Persona Agents (app-spawned AI instances)

An app that declares `"subagents": { "max": N }` in `app.json` can spawn up to N **sub-agents** from its iframe via `yaar://apps/self/agents`: AI instances with an app-supplied system prompt, each its own provider session and memory. They hold no YAAR verbs, no permissions, and no principal, and may only be given tool names that route back to the app's own iframe (`persona:{toolName}` commands).

`subagents` and `streams` are **granted by the user at install time**, not by the manifest alone (unlike `controls`, which stays bundled-only): an installed app's declaration is a *request*, recorded in `config/app-grants.json` and applied by `discovery.ts` as a **ceiling** — see `features/apps/capabilities.ts` for why intersecting rather than trusting matters. The old `"personas"` manifest alias is retired and refused by name.

See `packages/server/CLAUDE.md` (Tools/MCP section) for the full verb surface, lifecycle, and containment details, and [`docs/architecture/agent_tree.md`](./docs/architecture/agent_tree.md) for the design record.

### Compiler & Bundled Libraries

Apps are compiled via Bun into a single self-contained HTML file. Entry point is always `src/main.ts`. The compiler injects design tokens, SDK scripts (capture, storage, verb, app-protocol, etc.), and the bundled code.

**`@bundled/*` imports** — no `npm install` needed. 30+ libraries across UI (Solid.js), utilities, graphics/3D, data/charts, animation, audio, media files (`mediabunny` — read/write/convert mp4/webm/mp3/wav, frame-accurate and not real-time-bound like `MediaRecorder`), parsing, diagrams (`mermaid` — `renderMermaid()` returns token-themed SVG that is already sanitized; at 3.3 MB it is by far the largest, so import it only where diagrams are drawn), sanitization (`dompurify` — mandatory for any externally-sourced HTML), and validation (`zod` Mini functional API). Plus the **YAAR SDK** (`@bundled/yaar` — `read`, `invoke`, `list`, `describe`, `defineApp()`, `appStorage`, `appDb`, etc.) and **gated SDKs** requiring `"bundles"` in `app.json`: `@bundled/yaar-dev` (compile/typecheck/deploy + per-app version history), `@bundled/yaar-web` (browser automation), `@bundled/yaar-ml` (in-browser ONNX inference — see [`docs/guides/yaar_ml_runtime.md`](./docs/guides/yaar_ml_runtime.md)).

The authoritative list is `BUNDLED_LIBRARIES` in `packages/compiler/src/bundled/registry.ts`, also served at `GET /api/dev/bundled-libraries` (full category breakdown in `packages/compiler/CLAUDE.md`).

Key files: `packages/compiler/src/compile.ts` (Bun.build + HTML wrapper), `packages/compiler/src/bundled/` (registry.ts = the library list, plugins.ts = resolution + gated SDK enforcement), `packages/compiler/src/shims/` (per-library shims, e.g. `yaar/` the SDK barrel, plus `yaar-dev.ts`, `yaar-web.ts`), `packages/compiler/src/protocol/` (manifest extraction from source), `packages/compiler/src/bundled-types/` (.d.ts files for typecheck).

### Design Tokens

The visual language (GitHub-dark) has a single source of truth: `packages/shared/src/design/tokens.ts` generates both the app-iframe CSS and the OS shell's `tokens.css` — never write token values by hand anywhere else. See [`docs/architecture/design_system.md`](./docs/architecture/design_system.md) for the rules (chrome vs content, exception registry) and `bun scripts/codegen/design-tokens.ts` to regenerate after token changes.

All compiled apps get YAAR CSS custom properties and utility classes injected automatically:
- **Colors**: `--yaar-bg`, `--yaar-bg-surface`, `--yaar-text`, `--yaar-text-muted`, `--yaar-accent`, `--yaar-border`, `--yaar-success`, `--yaar-error`
- **Washes** (tinted backgrounds): `--yaar-wash-{accent,success,error,warning}` and a `-strong` (16%) variant of each, plus `--yaar-wash-accent-border` (35%). `color-mix()` over the color var, so they follow `.y-light` and any accent override — never hand-write `rgba(88,166,255,.1)` for a tint. A tinted *border* pairs a wash background with the **opaque** color token (`border-color: var(--yaar-success)`), as `.y-badge-*` does.
- **Spacing**: `--yaar-sp-1` through `--yaar-sp-6` (4px increments), `--yaar-sp-8`/`-10`/`-12` (32/40/48px)
- **Layout**: `y-app` (root container), `y-flex`, `y-flex-col`, `y-toolbar`, `y-sidebar`, `y-tabs`, `y-modal`, `y-empty` (centered placeholder with `y-empty-icon`)
- **Components**: `y-btn`, `y-btn-primary`, `y-btn-ghost`, `y-btn-danger`, `y-btn-warning`, `y-input`, `y-select`, `y-card`, `y-badge`, `y-spinner`, `y-toast`, `y-list-item` (interactive row with hover/`.active` states)
- **Status**: `y-wash-*` (tinted fill), `y-dot` + `y-dot-ok`/`-warn`/`-err`/`-accent`/`-pulse`, `y-progress` + `y-progress-fill` (add `y-progress-indeterminate` to the track for a sliding bar)
- **Typography**: `y-label` (uppercase muted section header), `y-truncate` (single-line), `y-clamp-2`, `y-clamp-3` (multi-line truncation)

Always use `var(--yaar-*)` for colors — never hardcode. Use `y-*` utility classes for common patterns.

### Solid.js Gotchas

Apps use Solid.js with `html` tagged templates (not JSX). Known issues:
- **Nothing may precede the first tag**: `solid-js/html` discards top-level text that appears before the template's first tag, and a template whose only top-level node is the expression makes it emit `.firstChild` with no parent. So `` html`${x}` ``, `` html`hi ${x}` ``, and `` html`hi` `` throw a stackless `SyntaxError`/`TypeError` from `new Function`, while `` html`lead <b>x</b>` `` silently drops `lead `. Wrap content in an element (`` html`<span>hi ${x}</span>` ``), or return the accessor (`() => x`) instead of wrapping it. The compiler fails the build on all four — see `guards/solid-html-guard.ts`.
- **`flex: 1` breaks reactivity**: Use `position: absolute; inset: 0` instead
- **Closing tags**: `</${Component}>` is auto-fixed by compiler plugin to `</>`
- **Event handler props**: Can re-fire during render if passed as reactive props — bind handlers outside reactive scope
