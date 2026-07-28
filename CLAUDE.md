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

Every package's `bun test` preloads `scripts/test/env.ts` first (wired in each `bunfig.toml`),
which pins the environment before the server's `config/env.ts` can read it: `YAAR_*` and the
knobs below are scrubbed, `REMOTE` is set explicitly, `YAAR_CONFIG`/`YAAR_STORAGE` point at
throwaway temp dirs, and the root `.env` is skipped. So a test run describes the code, not the
machine — in particular, toggling remote mode on in the configurations app (which persists
`remote: true` to `config/settings.json`) no longer changes what the suite asserts.

**`bun test <path>` works from the repo root too.** Bun picks `bunfig.toml` by *current
directory*, not by the test file's package, so a root-launched run used to load no preload at
all and report silently wrong results — the same class of failure `test/env.ts` exists to
prevent. The root `bunfig.toml` closes that: it preloads `test/env.ts`, then
`scripts/test/preload-root.ts`, which loads whatever setup the anchored package needs on top
(frontend's happy-dom globals, the server's `dist/protocol.json` fixtures). It dispatches
rather than loading both because a global DOM would change what the *compiler* tests see —
`shims/yaar/define-app.ts` branches on `typeof window`. It also runs that package's own
`pretest` (`bun run` executes npm lifecycle hooks; `bun test` executes none), so a root run
builds `@yaar/shared`/`@yaar/compiler` instead of testing whatever `dist/` was lying around —
~25ms when already fresh. Both root and package bunfigs carry `pathIgnorePatterns` for
`**/dist/**`: `tsc` emits compiled `.test.js` copies next to the sources, and an unscoped run
was collecting each compiler test twice, the stale copy failing.

**A run that spans more than one partition is refused, not guessed at.** Some test files
cannot share a Bun process — the server's `src/tests/remote/` needs `REMOTE=1` pinned before
the first import, files calling `mock.module` leak a stub with no teardown, `src/tests/loopback`
and `src/integration` bind real sockets (45 of 80 files fail if they run `--parallel` with the
units), and one process holds one package's setup. `bun test packages/server` used to put all
of that in a single process and report **86 failures against a green tree**; a bare repo-wide
`bun test` was wrong the same way. `scripts/test/partitions.ts` states which files may share a
process and why; `scripts/test/partition-guard.ts` (preloaded from the root and server bunfigs)
watches what a process actually loads and stops the run the moment a second partition appears,
printing the command for each. So a mixed run is now an error that names its fix, and every
*single*-partition path still works — including `bun test packages/server/src/tests/remote/…`,
which `test/env.ts` now recognizes by location and runs in remote mode. For everything at once
use `bun run test`, which is what CI runs.

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
press(key: "Shift+Tab")                       # open CLI panel (streaming + Monitor/Session "act as me" target toggle)
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
│   └── ...                      # Other bundled apps (devtools, chitchats, etc.)
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
    - `session-policies/` — `StreamToEventMapper`, `ProviderLifecycleManager`, `ToolActionBridge` (handle stream mapping, provider init, and MCP action routing)
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
  - `image.ts` — data-URL image parsing
  - plus single-file utilities: `ids.ts`, `open-url.ts`, `pick-directory.ts`, `format-interaction.ts`, `format-verb-log.ts`, `yaar-uri-server.ts`
- **`logging/`** — Session logger (JSONL), session reader, context restore, and window restore. Logs stored at `session_logs/{YYYY-MM-DD_HH-MM-SS}/`

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
- **CI** (`.github/workflows/ci.yml`): thin caller for `.github/workflows/checks.yml` — install → build shared + compiler → typecheck → test → check:docs → check:openapi. Runs on push/PR to `dev` and `main`.
- **`checks.yml`** is the one definition of "is this tree good?", shared by CI and release so they cannot drift. Its `full` input adds lint, format:check, and check:apps. Three tiers, escalating: `dev` gets the baseline (fast inner loop), anything touching `main` gets `full` (it is the clone target), and a release gets `full` plus the version-vs-tag assertion and the artifact smoke test. A check that should guard every push goes in the baseline; one that need only hold at promotion or ship time goes behind `full`.
- **Branch protection** (repo rulesets, not files — inspect with `gh api repos/sorryhyun/yaar/rulesets`): `main` and `dev` both block deletion and force-push; `refs/tags/v*` blocks deletion and force-update, so a botched release is retried with a new patch version rather than by moving a tag. `main` additionally requires the `ci / check` status — which is why `ci.yml`'s job id must stay `check` (the reusable-workflow name is `<caller job> / <called job>`). Nothing bypasses these; the Actions bot *cannot* be given a bypass on a user-owned repo, which is what shaped the release flow below. A fast-forward `dev` → `main` push is still allowed: the commit already carries a green `ci / check` from its `dev` run. Note that push satisfies the rule with the **baseline** tier — only a PR into `main` runs `full` *before* the branch moves.
- **Release**: `bun run release:prepare <version>` stamps the version on `dev` (this replaced a workflow that committed the bump straight to `main`; it can't, now that `main` requires a status a `GITHUB_TOKEN` push never produces), the bump is promoted to `main` like any other change, then a draft release targeting `main` is published. `release-draft-check.yml` warns while the release is still a draft if the target commit's version disagrees with the tag. On publish, `release.yml`'s `resolve` pins the tag's SHA and re-asserts the version → `verify` runs `checks.yml` with `full: true` against that SHA (a draft may target any branch or SHA, so the released commit is not necessarily ruleset-gated) → `release` builds and smoke-tests the artifacts, then publishes a `SHA256SUMS` manifest alongside them. The manifest is generated after every artifact exists, so it can never describe files the release did not ship; `install.sh`/`install.ps1` verify against it, hard-failing on a mismatch and warning-but-continuing when it is absent (releases predating it, and `VERSION=` pins at those tags). It rides the same HTTPS channel as the artifacts, so it is integrity, not provenance — signing is a separate, later step. The installers are deliberately excluded from it: a user who pipes one to a shell has already trusted that URL.
- **Version at runtime**: `YAAR_VERSION` (`config/env.ts`), served by `GET /api/version` with `bundled`/`platform`/`arch`. Two sources, one per build shape — the `__YAAR_VERSION` compile-time define for the exe (which has no `package.json` beside it, since `PROJECT_ROOT` there is wherever the binary was dropped), and `PROJECT_ROOT/package.json` under `bun run`. `scripts/release/set-version.ts` stamps that file and `scripts/build/exe-bundle.js` reads it for the define, so the two agree by construction; `0.0.0-unknown` means neither answered. The route is on `PUBLIC_ENDPOINTS` (the iframe allowlist) with no permission check, so an app can read the version without declaring anything in its `app.json`.
- **Bun version**: CI/release pin the version in `.bun-version` (via setup-bun's `bun-version-file`). `engines.bun` states the supported *floor*; the two are intentionally different numbers.

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

Convention-based: each folder in `apps/` becomes an app. `app.json` for metadata, `SKILL.md` for AI context, `protocol.json` for agent-iframe communication. See [`docs/guides/app-development.md`](./docs/guides/app-development.md) for full URI verbs reference and [`docs/reference/app_protocol_reference.md`](./docs/reference/app_protocol_reference.md) for protocol details.

### App Agent Architecture

When a user interacts with an app window, a **persistent app agent** is created (one per `monitorId::appId`, reused across all windows of that app on that monitor — not shared across monitors). App agents have four scoped tools — `describe` (read an app's protocol), `query` (read iframe state), `command` (execute iframe action), `relay` (hand off to monitor agent) — plus `direct_message` when `app.json` declares `"messaging": "all"`.

**Cross-app control:** `describe`/`query`/`command` take an optional `appId`. Omitting it targets the agent's own window (no permission needed). Passing another app's id targets that app — gated by the caller's `app.json` `controls` list (bundled apps only, mirroring the `kind: "system"` guard). `controls` accepts a string shorthand (`["browser-user"]`) or object form (`[{ "appId": "browser-user", "commands": ["navigate", "click"] }]`) to restrict which commands may be issued. The target app doesn't need an open window — `resolveTarget` reuses one already open on the caller's monitor, or auto-launches one if none exists. This is direct synchronous protocol control; contrast with `direct_message` to `app:{id}`, which hands a natural-language request to the other app's own agent. E.g. devtools declares `"controls": ["browser-user"]` to drive the real browser end-to-end. The app's own protocol is injected at boot; controlled apps' protocols are discovered on demand via `describe(appId)`.

**Prompt priority:** `AGENTS.md` (full custom prompt, replaces generic) > `SKILL.md` (appended to generic prompt). `protocol.json` manifest is always appended — commands as call signatures rendered from their `params` schema, so a prompt file never has to restate param names — as is a "Controllable Apps" section when `controls` is set. Use `AGENTS.md` for apps like devtools that need precise agent behavior; `SKILL.md` for simpler apps where the generic prompt suffices. `HINT.md` is separate — its content is injected into the **monitor agent's** system prompt (not the app agent's), providing orchestration hints that auto-sync with app install/uninstall.

Key files: `agents/app-task-processor.ts` (routing), `agents/agent-pool.ts` (lifecycle), `agents/profiles/app-agent.ts` (prompt builder), `mcp/app-agent/` (describe/query/command/relay tools), `features/apps/discovery.ts` (`controls` parsing + bundled-only guard).

### Sub-agents / Persona Agents (app-spawned AI instances)

An app that declares `"personas": { "max": N }` in `app.json` (bundled apps only, like `controls`/`streams`) can spawn up to N **sub-agents** from its iframe via `yaar://apps/self/agents`: AI instances with a system prompt the app supplies at runtime, each its own provider session with its own conversation memory. This is what lets one app run several distinct characters at once rather than one agent role-playing them in turn. They hold no YAAR verbs, no permissions, and no principal, and may only be given tool names that route back to the app's own iframe (`persona:{toolName}` commands). Reference consumer: `apps/chitchats`.

See `packages/server/CLAUDE.md` (Tools/MCP section) for the full verb surface, lifecycle, and containment details, and [`docs/architecture/agent_tree.md`](./docs/architecture/agent_tree.md) for the design record.

### Compiler & Bundled Libraries

Apps are compiled via Bun into a single self-contained HTML file. Entry point is always `src/main.ts`. The compiler injects design tokens, SDK scripts (capture, storage, verb, app-protocol, etc.), and the bundled code.

**`@bundled/*` imports** — no `npm install` needed. 30+ libraries across UI (Solid.js), utilities, graphics/3D, data/charts, animation, audio, parsing, diagrams (`mermaid` — `renderMermaid()` returns token-themed SVG that is already sanitized; at 3.3 MB it is by far the largest, so import it only where diagrams are drawn), sanitization (`dompurify` — mandatory for any externally-sourced HTML), and validation (`zod` Mini functional API). Plus the **YAAR SDK** (`@bundled/yaar` — `read`, `invoke`, `list`, `describe`, `defineApp()`, `appStorage`, `appDb`, etc.) and **gated SDKs** requiring `"bundles"` in `app.json`: `@bundled/yaar-dev` (compile/typecheck/deploy + per-app version history), `@bundled/yaar-web` (browser automation), `@bundled/yaar-ml` (in-browser ONNX inference — see [`docs/guides/yaar_ml_runtime.md`](./docs/guides/yaar_ml_runtime.md)).

The authoritative list is `BUNDLED_LIBRARIES` in `packages/compiler/src/bundled/registry.ts`, also served at `GET /api/dev/bundled-libraries` (full category breakdown in `packages/compiler/CLAUDE.md`).

Key files: `packages/compiler/src/compile.ts` (Bun.build + HTML wrapper), `packages/compiler/src/bundled/` (registry.ts = the library list, plugins.ts = resolution + gated SDK enforcement), `packages/compiler/src/shims/` (per-library shims, e.g. `yaar/` the SDK barrel, plus `yaar-dev.ts`, `yaar-web.ts`), `packages/compiler/src/protocol/` (manifest extraction from source), `packages/compiler/src/bundled-types/` (.d.ts files for typecheck).

### Design Tokens

The visual language (GitHub-dark) has a single source of truth: `packages/shared/src/design/tokens.ts` generates both the app-iframe CSS and the OS shell's `tokens.css` — never write token values by hand anywhere else. See [`docs/architecture/design_system.md`](./docs/architecture/design_system.md) for the rules (chrome vs content, exception registry) and `bun scripts/codegen/design-tokens.ts` to regenerate after token changes.

All compiled apps get YAAR CSS custom properties and utility classes injected automatically:
- **Colors**: `--yaar-bg`, `--yaar-bg-surface`, `--yaar-text`, `--yaar-text-muted`, `--yaar-accent`, `--yaar-border`, `--yaar-success`, `--yaar-error`
- **Spacing**: `--yaar-sp-1` through `--yaar-sp-6` (4px increments), `--yaar-sp-8`/`-10`/`-12` (32/40/48px)
- **Layout**: `y-app` (root container), `y-flex`, `y-flex-col`, `y-toolbar`, `y-sidebar`, `y-tabs`, `y-modal`, `y-empty` (centered placeholder with `y-empty-icon`)
- **Components**: `y-btn`, `y-btn-primary`, `y-btn-ghost`, `y-btn-danger`, `y-input`, `y-select`, `y-card`, `y-badge`, `y-spinner`, `y-toast`, `y-list-item` (interactive row with hover/`.active` states)
- **Typography**: `y-label` (uppercase muted section header), `y-truncate` (single-line), `y-clamp-2`, `y-clamp-3` (multi-line truncation)

Always use `var(--yaar-*)` for colors — never hardcode. Use `y-*` utility classes for common patterns.

### Solid.js Gotchas

Apps use Solid.js with `html` tagged templates (not JSX). Known issues:
- **Nothing may precede the first tag**: `solid-js/html` discards top-level text that appears before the template's first tag, and a template whose only top-level node is the expression makes it emit `.firstChild` with no parent. So `` html`${x}` ``, `` html`hi ${x}` ``, and `` html`hi` `` throw a stackless `SyntaxError`/`TypeError` from `new Function`, while `` html`lead <b>x</b>` `` silently drops `lead `. Wrap content in an element (`` html`<span>hi ${x}</span>` ``), or return the accessor (`() => x`) instead of wrapping it. The compiler fails the build on all four — see `guards/solid-html-guard.ts`.
- **`flex: 1` breaks reactivity**: Use `position: absolute; inset: 0` instead
- **Closing tags**: `</${Component}>` is auto-fixed by compiler plugin to `</>`
- **Event handler props**: Can re-fire during render if passed as reactive props — bind handlers outside reactive scope
