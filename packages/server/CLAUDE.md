# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
bun run test                   # Every suite, each in the process it needs
```

## Tests

`bun run test` is `scripts/run-tests.ts`. It globs **every** `*.test.ts` under `src/`, groups
them by `scripts/test/partitions.ts`, and spawns one process per group — concurrently, and
reporting all of them, so a unit failure no longer hides whether the other suites passed. Today
that is 94 files in 17 processes:

1. `units` — one `--parallel` process for the plain unit/component tests.
2. `remote` — `src/tests/remote/`, with `REMOTE=1` pinned for the whole process.
3. `loopback` — `src/tests/loopback/`, the loopback harness (see `tests/loopback/harness/`).
4. `realfs` — `src/tests/realfs/`, which runs real `git` against real app directories and so
   cannot share a process with the units that `mock.module` `PROJECT_ROOT` to `/mock-root`.
   The *integration* suite is not here at all: it is the separate `@yaar/tests` package.
5. one process per file that calls `mock.module` (13 of them).

The glob is `src/**`, not `src/tests/**` plus a hardcoded extra directory: a test file written
next to the module it covers used to be collected by nothing and reported by nothing (today
`src/features/update/update.test.ts` is one). `tsconfig.build.json` therefore excludes
`**/*.test.ts` as well as `src/tests`, or those colocated files compile into `dist/`.

The split is load-bearing, and `scripts/test/partition-guard.ts` (third preload in `bunfig.toml`)
enforces it rather than trusting it — `bun test src/tests` looks reasonable and quietly mixes the
mocking files into the shared process, so the guard stops the run and prints the right command.
See `scripts/test/partitions.ts` for each partition's rationale.

**Every suite starts from a pinned environment**, not the developer's. `scripts/test/env.ts` is
preloaded (`bunfig.toml`, first entry, shared by every package in the repo) before any test file
— and therefore before `config/env.ts` freezes `IS_REMOTE`. It scrubs every `YAAR_*` var and the
documented knobs (`REMOTE`, `PORT`, `PROVIDER`, `MCP_SKIP_AUTH`, …), pins `REMOTE` explicitly,
points `YAAR_CONFIG`/`YAAR_STORAGE` at throwaway temp dirs, and sets `YAAR_SKIP_DOTENV`. Without
it a developer who had toggled remote mode on in the configurations app ran the whole suite in
remote mode: `settings.json` fed `loadPersistedRemote()`, and `http-routing.test.ts` /
`app-origin-isolation.test.ts` failed locally while passing in CI, which has no such file.

`YAAR_TEST_REMOTE=1` is how that is carried, but `src/tests/remote/` **is** the opt-in: `test/env.ts`
sets the var itself when the first collected file lives there, so running one of those files by
path (`bun test packages/server/src/tests/remote/…`, the obvious move after a red CI line) cannot
silently become a local-mode run. It necessarily scopes to a **whole process**:
`IS_REMOTE` is a module-load constant, so a local-mode process cannot assert anything about the
remote gate — `checkHttpAuth` returns `null` on its first line and every assertion passes
regardless. That vacuity is not hypothetical; see the header of
`packages/tests/src/integration/ml-runtime-remote-auth.test.ts`. Hence the pairing: local-mode
rows in `app-origin-isolation.test.ts` and `http-routing.test.ts`, remote-mode rows in
`src/tests/remote/remote-mode.test.ts`, each asserting its own `IS_REMOTE` up front so a broken
wiring fails loudly instead of quietly passing.

**The unit suite is itself partitioned by process.** The split is computed from source on every
run, so there is no list to keep in sync: any file that calls `mock.module` gets its own process
(still run concurrently with the rest), everything else shares one `--parallel` process — because
`mock.module` is process-global with no teardown, so a stub is otherwise visible to every
concurrently-running file that imports the same specifier. Full rationale, including the CI
incident that forced this, is in `scripts/test/partitions.ts`.

The loopback harness runs the real stack end to end — `createWsHandlers` → `SessionHub` →
`LiveSession` → `ContextPool` → `AgentSession` → `actionEmitter` → `PendingStore` — with
exactly two fakes: the browser (`FakeClient`) and the model (`ScriptedProvider`). It needs its
own process, and a sequential one: run the 80 non-remote files together under `--parallel` and
45 fail, because this suite binds real sockets and `src/tests/realfs/` reseeds one on-disk
fixture directory across its cases. Full rationale, including
the deadlock this exists to catch, is in `tests/loopback/harness/boot.ts`'s header comment.

Three rules follow:

- **A test never depends on the machine it runs on.** If a behavior is decided by an env var,
  a `config/` file, or a path, pin it in the test (or add it to the scrub list in
  `scripts/test/env.ts`) rather than inheriting whatever the developer has. A suite that only
  passes on a clean checkout is a suite that will fail on someone's laptop and pass in review.
- **Never add `mock.module` under `src/tests/loopback/`.** The harness substitutes through real
  seams instead: the provider via `ContextPool`'s `acquireProvider`, the logger via the
  `sessionLogger` option, the deadlines via `setDeadlinesForTest()` (`config.ts`), the config
  dir via `YAAR_CONFIG`.
- **Assert against the narrowest module that holds the behavior.** A test that stubs the
  `profiles/index.js` barrel stubs everything the barrel re-exports; a test that asserts on real
  behavior should import the concrete module (`profiles/model-tiers.js`), not the barrel. The
  per-file isolation above makes leaks impossible rather than merely unlikely, but a test whose
  subject is one function reads better pointed at that function anyway.

Server→client waits (`ANSWER_EVENT_TYPES` in `@yaar/shared`) each get a loopback row: a wait the
client can only answer over a socket the server is holding is a deadlock waiting to happen.

## Environment Variables

- `PROVIDER` - Force provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000), `MAX_AGENTS` - Global agent limit (default: 10)
- `MCP_SKIP_AUTH` - Skip MCP auth (`1` for local dev), `REMOTE` - Enable remote mode (`1`)
- `YAAR_REMOTE_TOKEN` - Adopt this remote token instead of minting one, so a launcher can build the `#remote=<token>` URL before the server starts (`scripts/dev/start.sh` does this for `make claude`). Under 32 chars it is ignored with a warning — remote mode hands the token to every device that can reach the server. See `http/auth.ts`.
- `YAAR_STORAGE` / `YAAR_CONFIG` - Override storage/config directory paths
- `YAAR_SKIP_DOTENV` - `1` skips loading the root `.env` in `config/env.ts`. Set by `scripts/test/env.ts`: a test run pins every knob explicitly, and "fill in what is unset" is the one door a developer's `.env` could otherwise walk back through.
- `YAAR_TEST_REMOTE` - Test-runner only. `1` makes `scripts/test/env.ts` pin `REMOTE=1` for the process, which is how `src/tests/remote/` gets a genuine remote-mode `IS_REMOTE`.
- `YAAR_APP_ORIGIN_ISOLATION` - App-origin isolation (**on by default**; set `=0` to disable). Serves `source:'user'` app iframes from a distinct browser origin so they are cross-origin to the desktop. **Enforcing:** `resolvePrincipal` refuses a token-less request that carries the app origin, and `http/server.ts` redirects a desktop document that lands there back to the desktop origin. Closes the token-forgery escapes; being cross-origin also blocks `window.parent` DOM/memory reach, and top-level navigation is closed by the sandbox on isolated frames — see [`docs/guides/remote_mode.md`](../../docs/guides/remote_mode.md).
  **Which two origins** is `http/origin-boundary.ts`'s business, and the one place to ask: `loopback-alias` (local — desktop `localhost`, apps `127.0.0.1`, one socket) | `proxy-port` (Tailscale Serve — one MagicDNS name, `:443` desktop / `:8443` apps, **two local sockets**) | `off`. The env var is only the switch; `isAppOriginIsolationEnabled()` in `config/env.ts` answers for the loopback-alias way alone and is local-mode only. The `proxy-port` boundary is installed at runtime by `lifecycle.startTunnel()` once the transport confirms both origins are live. Over a proxy the addressed origin is unreadable from the request (`url.port` is the loopback hop, `Host`/`X-Forwarded-*` are the proxy's word), so the app-origin socket gets its own `createFetchHandler({ appOriginSocket: true })` running inside `runOnAppOriginSocket()` — which socket a request arrived on is unforgeable. `window.create` carries `appOrigin` only in that mode, since the client cannot derive `https://host:8443`; locally the frontend must derive the alias itself (a dev proxy's port is not the API's).
- `MONITOR_MAX_CONCURRENT` (default: 2), `MONITOR_MAX_ACTIONS_PER_MIN` (30), `MONITOR_MAX_OUTPUT_PER_MIN` (50000) - Background monitor budget limits
- `CODEX_WS_PORT` (default: 4510), `CHROME_PATH` (auto-detected), `MARKET_URL`
- `YAAR_BROWSER_PROVIDER` - **No longer a selector.** `POST /api/browser` is always the headless sandbox (`getHeadlessBrowser()`); the user's real Chrome is reached only through the session-agent door `yaar://session/browser` (`getLocalBrowser()`), which auto-attaches whenever a debuggable Chrome is reachable. The var survives only as a **force-headless opt-out**: set `=headless` to keep the agent away from your real browser (the session door then uses the sandbox too).
- `CHROME_DEBUG_PORT` (default: 9222) - DevTools port the local (session-door) browser provider attaches to (user launches Chrome with `--remote-debugging-port`).

## Directory Structure

```
src/
├── main.ts               # Thin orchestrator — binds the socket(s), then startTunnel(), banner, warm pool
├── config.ts             # Barrel over config/ (env, paths, assets, deadlines, limits, browser, providers/claude, providers/codex)
├── lifecycle.ts          # initializeSubsystems(), getBindHostname(), wantsAppOriginSocket(), startTunnel(), printBanner(), shutdown()
├── http/                 # HTTP server: createFetchHandler() (CORS, auth, MCP dispatch)
│   ├── access.ts         # THE ACCESS CHOKEPOINT — resolvePrincipal(), requirePermission(), requireHost(), requireBundle()
│   ├── auth.ts           # checkHttpAuth(), generateRemoteToken(), isStaticAsset(), hasValidIframeToken()
│   ├── iframe-tokens.ts  # generateIframeToken(), validateIframeToken()
│   ├── origin-boundary.ts # THE ORIGIN BOUNDARY — which two origins, and which side a request is on
│   ├── subscriptions.ts  # subscriptionRegistry — reactive verb URI subscriptions
│   └── routes/           # api.ts (REST), verb.ts (iframe verb proxy), files.ts, browse.ts, proxy.ts, static.ts
├── session/              # LiveSession (aggregate root), SessionHub, BroadcastCenter, ActionEmitter, SessionEventRouter, WindowStateRegistry, types
│   ├── monitor-registry.ts          # MonitorRegistry — authoritative monitor list, id minting, subscription + viewport, removal
│   ├── client-event-controller.ts   # ClientEventController — the total ClientEventRoutes table + frame handlers
│   ├── session-snapshot-service.ts  # SessionSnapshotService — read-only window/surface/agent snapshot building
│   └── app-window-coordinator.ts    # AppWindowCoordinator — app readiness, command replay, app-channel/bridge-event routing
├── websocket/            # WebSocket server + connection registry
├── agents/               # Agent lifecycle, pooling, context management
│   ├── agent-pool.ts     # AgentPool — per-monitor, app, and session agent registry
│   ├── context-pool.ts   # ContextPool — unified task orchestration
│   ├── context.ts        # ContextTape — hierarchical message history
│   ├── limiter.ts        # AgentLimiter — global agent semaphore
│   ├── agent-session.ts  # AgentSession + AsyncLocalStorage (getAgentId, getSessionId)
│   ├── monitor-task-processor.ts / app-task-processor.ts / session-task-processor.ts
│   ├── window-event-coordinator.ts  # subscription/notification fan-out + window-close teardown
│   ├── interaction-timeline.ts / pool-types.ts / turn-helpers.ts
│   ├── profiles/         # app-agent, session-agent, sub-agent, orchestrator, model-tiers, shared-sections, types, index (barrel)
│   ├── session-policies/       # StreamToEventMapper, ProviderLifecycleManager, ToolActionBridge
│   └── context-pool-policies/  # MonitorQueue, WindowQueue, ContextAssembly, ReloadCache, MonitorBudget, WindowSubscription
├── providers/            # Pluggable AI backends
│   ├── types.ts          # AITransport interface, StreamMessage, TransportOptions
│   ├── factory.ts        # Auto-detect provider, warm pool init
│   ├── warm-pool.ts      # WarmPool singleton
│   ├── claude/           # ClaudeSessionProvider, system-prompt, message-mapper
│   └── codex/            # CodexProvider, AppServer, JsonRpcWsClient, auth, types
├── handlers/             # PRIMARY: URI registry + 5 generic verb tool handlers
│   ├── index.ts          # registerVerbTools() — the 5 MCP tool definitions
│   ├── uri-registry.ts   # ResourceRegistry — central handler registry
│   ├── uri-resolve.ts    # Server-side URI resolution
│   ├── utils.ts          # Shared handler utilities
│   ├── agents.ts / apps.ts (barrel over apps/) / storage.ts / config.ts
│   ├── apps/             # register.ts, app-resource.ts, storage-resource.ts, db-resource.ts, paths.ts — still one yaar://apps/* registration (ResourceRegistry has no middle wildcard)
│   ├── define-actions.ts # defineActions() — one table per action-bearing handler; the enum, the docs, and the dispatch all come off it
│   ├── storage-describe.ts # describeStoragePath() — describe for a path on disk, shared by both storage doors
│   ├── session.ts / skills.ts / system.ts / user.ts / window.ts
├── mcp/                  # MCP server + tool folders (see Tools section)
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS
│   ├── system/           # Always-active: reload_cached, list_reload_options
│   ├── sub-agent/        # A sub-agent's one channel — per-caller tool list
│   └── index.ts          # Re-exports for server, system tools, verb tools
├── features/             # Domain business logic (imported by handlers/)
│   ├── apps/             # App listing, agent docs (prompt/hint/SKILL) loading, describe.ts (the app's manual), marketplace, badge
│   ├── browser/          # CDP browser automation actions
│   ├── config/           # Hooks, settings, shortcuts, mounts, app config, domains
│   ├── dev/              # Compile, typecheck, deploy, clone, git.ts (per-app version history)
│   ├── http/             # fetch.ts — proxied HTTP fetch
│   ├── update/           # Self-update: semver.ts, release.ts (GitHub + SHA256SUMS), installer.ts (download/verify/swap), updater.ts (state)
│   └── window/           # Window create/update/manage, app protocol, app query/command, subscribe/unsubscribe
├── db/                   # Per-app SQLite (appDb): AppDatabase wrapper, LRU pool, Mongo-style filter → SQL query builder
├── reload/               # Fingerprint-based action cache
├── logging/              # Session logging (JSONL), reading, context/window restore
├── storage/              # StorageManager, permissions, shortcuts, settings, mounts
└── lib/                  # Standalone utilities (no server internal imports)
    ├── browser/ pdf/ pick-directory.ts
    ├── format-interaction.ts  # formatCompactInteraction() — compact log string for UserInteraction
    └── yaar-uri-server.ts     # Server-only URI parsers: parseContentPath, parseWindowResourceUri/buildWindowResourceUri, parseConfigUri/buildConfigUri, parseSessionUri/buildSessionUri (+ associated types)
```

## Architecture

### Session-Centric Architecture

```
SessionHub (singleton registry)
└── LiveSession (per conversation, survives disconnections)
    ├── connections: Map<ConnectionId, WebSocket>   ← multi-tab support
    ├── WindowStateRegistry                         ← server-side window tracking
    ├── ReloadCache                                 ← fingerprint-based action caching
    └── ContextPool (unified pool)
        ├── AgentPool
        │   ├── Session Agent: PooledAgent | null            ← lazy singleton; cross-monitor oversight + session principal (only tier with yaar://session/* access; the only principal that drives the user's real browser via yaar://session/browser)
        │   ├── Monitor Agents: Map<monitorId, PooledAgent>  ← one per monitor
        │   ├── Ephemeral Agents (temporary, no context)
        │   ├── App Agents: Map<monitorId::appId, PooledAgent>  ← persistent per (monitor, app)
        │   └── Sub-agents: Map<monitorId::appId::subId, SubAgent>
        │        ← N per (monitor, app), prompt supplied by the app at runtime;
        │          tool-less, or holding one channel to its own app's iframe
        ├── ContextTape (hierarchical message history)
        │   ├── [main] user/assistant messages
        │   └── [window:id] branch messages
        └── Policies (MonitorQueue per monitor, WindowQueue, ContextAssembly, ...)
```

`LiveSession` is the aggregate root. It owns four collaborators, each reached only through it and given narrow callbacks rather than the session itself:

- `MonitorRegistry` — the authoritative monitor list, id minting (lowest free non-negative integer), `MAX_MONITORS` enforcement, per-connection monitor subscription + viewport, and monitor removal (unsubscribes watchers, then removes the monitor agent).
- `ClientEventController` — owns the total `ClientEventRoutes` table and every frame handler. `LiveSession.routeMessage()` is still the public entry: it lazily initializes the pool and settles message-id acceptance, then delegates to `ClientEventRouter`.
- `SessionSnapshotService` — window→`window.create` conversion, iframe-token refresh, surface snapshot, busy-agent snapshot. Strictly read-only over injected registries.
- `AppWindowCoordinator` — per-(session, window) app readiness, command replay on iframe remount, app-channel/`APP_EVENT` routing, bridge-event fan-out to Real Browser windows, and app-protocol request delivery to the frontend.

`LiveSession` still owns the registries, `broadcast()` remains the only server→frontend gateway, and it decides its own cleanup order.

### Message Flow

```
WebSocket → LiveSession.routeMessage()
  → ContextPool.handleTask()
  → Monitor's main queue (sequential) or Window handler (parallel)
  → AgentSession.handleMessage(content, { role, source, ... })
  → AITransport.query() [async generator]
  → Tools emit actions via actionEmitter
  → LiveSession.broadcast()
```

### Event Delivery Rule

**All server→frontend events must flow through `LiveSession.broadcast()`**, never directly through `BroadcastCenter.publishToSession()`. `LiveSession.broadcast()` handles monitor-scoped routing.

For non-agent contexts (HTTP routes, proxy) where there is no `LiveSession` reference, use the `actionEmitter` EventEmitter pattern. There are no per-session `actionEmitter.on(...)` listeners: `session/session-event-router.ts` holds exactly ONE process-wide subscription per channel and resolves the destination session by `sessionId`, so listener count stays constant as sessions come and go.
1. `actionEmitter.emit('my-event', { sessionId, event })` from the source
2. `SessionEventRouter`'s one subscription for that channel looks up the `sessionId` and calls the matching `SessionEventSink`
3. `LiveSession` registers a `SessionEventSink` in its constructor (`sessionEventRouter.attach()`) and detaches it in `cleanup()` (`sessionEventRouter.detach()`, which checks sink identity before removing — a session id is reused across reconnects, so a late `cleanup()` on a stale `LiveSession` must not unsubscribe its replacement)

`bridge-event` is the one deliberately-global channel — no `sessionId`, fanned out to every attached sink, each of which decides whether it has a window that cares. See `'app-protocol'`, `'action'`, and the forwarded channels (`'approval-request'`, `'verb-subscription'`, etc.) in `session-event-router.ts` as the reference implementation. Calling `BroadcastCenter.publishToSession()` directly bypasses routing and silently fails during active agent streaming.

### Event Type Constants

Use `ServerEventType` and `ClientEventType` const objects from `@yaar/shared` for all event type discriminants — never raw string literals.

### Key Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| Semaphore | `AgentLimiter` | Global agent limit with queue |
| Pool | `ContextPool` | Unified agent reuse with dynamic roles |
| Warm Pool | `providers/warm-pool.ts` | Pre-initialize providers at startup |
| Context Tape | `ContextTape` | Track messages by source for injection |
| Factory | `providers/factory.ts` | Auto-detect and create providers |
| Observer | `actionEmitter` | Decouple tools from sessions |
| AsyncLocalStorage | `AgentSession` | Track agentId in async context |

## Providers

**AITransport interface:** `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`, `interrupt()`, `dispose()`.

**Warm Pool:** Providers pre-initialized at startup. `initWarmPool()` at boot, `acquireWarmProvider()` gets a ready instance, pool auto-replenishes in background.

**Claude:** `claude-sonnet-4-6`, thinking enabled (4096 max tokens), WebSearch and Task tools, `bypassPermissions`. Each provider keeps a **persistent streaming session**: one long-lived CLI process whose MCP connections survive across turns; turns push messages into the stream and read until the SDK result. A prompt/tools/model change reopens the stream with `resume`. Monitor agents are prewarmed at WebSocket connect (`ContextPool.prewarmMonitorAgent` → `AgentSession.prewarm` → `provider.prewarm`) so the first user message starts on a live process with MCP already connected — the first turn is also gated on MCP connection (bounded 5s) because the CLI no longer waits for HTTP MCP servers in stream-json mode.

**Codex:** `codex app-server` child process with per-provider WebSocket connections (`--listen ws://`). Settings: `approval_policy=on-request`, `model_reasoning_effort=medium`, `sandbox_mode=danger-full-access`.

**Codex version policy (`providers/codex/version.ts`):** the bindings in `providers/codex/generated/` are hand-generated by `make codex-types`, so a drifted CLI compiles fine and misbehaves at runtime instead. `CODEX_MIN_VERSION` is the hand-edited floor; `CODEX_GENERATED_FROM` (in `generated/codex-version.ts`, stamped by the codegen script) records what the bindings came from. Three gates: the codegen script refuses an under-versioned binary (fails *closed*, `--force` overrides), `factory.ts` treats one as unavailable so auto-detect picks Claude, and `assertSupportedCodex` checks the `initialize` `userAgent` of whichever app-server actually answered — the only gate that catches a stale process still holding `CODEX_WS_PORT`. The last two fail *open* on an unparseable version (the format is OpenAI's to change). `CodexVersionError` is never retried by `connectAndInitialize`, and a **forced** `PROVIDER=codex` turns it into a refused boot in `lifecycle.ts` rather than a silent fallback to Claude. Covered by `tests/codex-version.test.ts` and `tests/warm-pool-codex-version.test.ts`.

## Tools (MCP)

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`, `messaging`, and `subagent`. The `verbs` server exposes 5 generic tools (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import domain logic from `features/`) via `yaar://` URIs.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs dispatching to `handlers/` via `yaar://` URIs |
| `mcp/system/` | system | reload_cached, list_reload_options |
| `mcp/sub-agent/` | subagent | app-defined tools of the *calling* sub-agent — the only namespace whose tool list depends on who connects; empty for everyone else |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for rendering feedback. Window tools support lock protection — only the locking agent can modify a locked window.

**Verb semantics: `describe` is the manual, `read` is the current value, `list` is what's addressable.** A handler that blurs the three makes a prompt offer rather than instruct — the monitor prompt used to say "use `read(...)` **or** `describe(...)`" precisely because, for apps, both doors returned the same generated reference doc. They now answer different questions:

| | `yaar://apps/{id}` — the *installed* app | `yaar://windows/{id}` — the *running* instance |
|---|---|---|
| `describe` | identity + `dist/protocol.json` verbatim + `agent/SKILL.md` + permissions + this door's `verbs`/`invokeActions`/`subPaths` | this instance's manual, tagged `source: 'live'` (the iframe's registration) or `'manifest'` (disk) |
| `read` | the effective, **post-grant** manifest from `getAppMeta` | window content + metadata |
| `list` | ✗ not a collection | this window's state keys and commands |
| sub-paths | `storage/`, `db/`, `agents/` | `state/{key}`, `commands/{key}` |

Four rules hold this together, each closing a false success:

- **`exists?(resolved)` on `ResourceHandler`** is consulted before the auto-generated `describe`, which otherwise answers from the URI *pattern* — byte-identical for a live window, a markdown window, and a window that has never existed. False → `No resource at <uri>.` `register()` **throws** when a `/*` wildcard declares neither `exists` nor `describe`: a wildcard is the one shape where the id can be wrong, and an optional field nobody remembers is how this got in. `apps/*`, `storage/*`, `mcp/*` and `user/notifications/*` own their own `describe` instead; the last is the one namespace that genuinely cannot answer (the client owns the toast), and says so.
- **The same list is declared once.** `defineActions` (`handlers/define-actions.ts`) now carries a per-action `description`, so the schema `enum`, `describe`'s `invokeActions`, and the dispatch all come off one table. The app actions were previously written three times — `describe` advertised `set_badge` alone, the switch implemented seven, and the enum named five including a `write` it never handled.
- **`yaar://apps/{id}/state/…` and `/commands/…` are refused on every verb** (`handlers/apps/register.ts`). Protocol state belongs to a running window; the same app open on two monitors is two states. Deliberately narrow — the blanket version would delete `appStorage` and `appDb`, which are built entirely on reads and lists under `yaar://apps/self/{storage,db}/`.
- **A missing directory is an error, not an empty list.** `storageList` used to return `{ success: true, entries: [] }` for a path that isn't there, so `list('yaar://storage/nope/')` read as an empty folder; it now sets `notFound`. Namespace roots opt back in explicitly (an app's `storage/` exists from the moment the app does — the directory is created by the first write).

**Access tiers (role-based URI access control):** every agent carries a principal `role` (`session` / `monitor` / `app`) on its `AgentContext`. A handler may declare `access: 'session-principal'`, and `ResourceRegistry.execute()` then rejects any caller whose role isn't `session` (default-deny — `undefined` role is non-session). `yaar://session` and all `yaar://session/*` resources are marked session-principal, so only the session agent can read/invoke them; monitor/app agents and apps (`POST /api/verb` also hard-refuses `yaar://session/*`) get a `403`. The role is resolved from the pool (`AgentPool.getRoleForAgent` via `SessionHub.findRoleForAgent`) in the MCP path and from the per-turn role string (`principalRole()`) in-process. The gate's role resolver is injected via `setAccessRoleResolver()` (wired in `lifecycle.ts`) to avoid a runtime import cycle.

**App Protocol:** Bidirectional agent-iframe communication via `query`/`command` tools (in the `app` MCP server). Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. See shared CLAUDE.md for event schemas. A fourth request kind, `describe`, documents **one** state key or command (`handleAppDescribe` in `features/window/app-protocol.ts`): the app's own `describe()` when the entry defines one, the manifest's static `description` when it doesn't, an error only when the key is absent. Erroring on a documented key would report it as missing — the same false signal `exists` exists to remove. It is requested on demand and never folded into the manifest, or every manifest read would pay for every key.

**Monitor ↔ App Agent Communication:**
- **Monitor → App**: `invoke('yaar://windows/{id}', { action: 'message', message: '...' })` — wraps message in `<monitor:{monitorId}>` tags and routes as an app task via `AppTaskProcessor`. Fire-and-forget; use `hook: 'response'` to get the app agent's reply back.
- **App → Monitor**: App agent's `relay` tool enqueues a `type: 'monitor'` task. Additionally, app agent responses are pushed to `InteractionTimeline` and drained by the monitor on its next turn.

**Sub-agents / persona agents (`yaar://apps/self/agents`):** an app that declares
`"subagents": { "max": N }` in its app.json may spawn up to N AI instances, each with a system
prompt it supplies at runtime and each its own provider session with its own memory. The verb
surface lives in `handlers/apps/agents-resource.ts` — `list` / `invoke {spawn|message|interrupt}` /
`read` / `delete` — and is callable from the app's iframe (`POST /api/verb`), never by another app:
the appId in the URI must equal the appId the *context* says the caller is, which the caller cannot
forge. `message` returns as soon as the turn is queued, so N sub-agents generate concurrently; the
answer arrives on the existing `yaar://agents/{instanceId}/stream` feed (needs `"streams": ["agents"]`),
whose `done` frame carries the turn's final text.

Sub-agents deliberately hold **no YAAR verbs, no permissions, and no principal**. A spawn with no
`tools` gets `allowedTools: []`, from which `buildSDKOptions` derives an empty MCP set and no
builtins — that empty array is the whole containment story for a runtime-supplied prompt, since
`undefined` there would mean *every* tool. Every sub-agent bypasses `ContextPool` entirely (no tape,
no queue — the app's own scheduler serializes them) and is reclaimed when the app's last window on
the monitor closes, when the monitor is removed, or on explicit `delete`. See
[`docs/architecture/agent_tree.md`](../../docs/architecture/agent_tree.md) for the design, and
`chitchats` (rooms with `skip`/`recall`/`memorize`, whose persona documents are what a
reclaimed character is respawned from) for the reference consumer — it left `apps/` for the
market, so no bundled app exercises this path in-tree today.

**Who may declare it (`features/apps/capabilities.ts`, `storage/app-grants.ts`).** `subagents` and
`streams` are gated on the *user*, not on the app's source. A bundled manifest ships with the
release and is taken at its word; an installed app's is a **request**, itemized in the install
dialog and recorded as a grant in `config/app-grants.json`, and `getAppMeta` hands back the
**intersection** of declaration and grant. Intersection rather than a boolean because an app holding
`yaar-dev` can rewrite its own app.json — a grant of `max: 2` has to stay a ceiling of 2 whatever
the file says afterwards, and a grant for an app that has since *dropped* the field must grant
nothing. Two consequences worth knowing: an update is diffed against what the app **holds** (the
grant), never against its previous manifest, or an install predating grants would be handed the
capability with no dialog at all; and uninstall clears the grant, so a reinstall asks again.
`controls` is deliberately not in this scheme — driving another app is authority over separately
installed software, and nothing is asking for it — so it stays bundled-only.

**One manifest key, not two.** `"personas": { "max": N }` was an accepted alias for `subagents` and
is no longer read. Nothing in the tree or on the market used it except `chitchats`, and two
spellings for one field meant every doc mentioning it had to mention both. The **wire** is
unchanged and still says persona — `personaId` in the URI segment, the spawn param, and every
response body — because a character is what an app spawns and a sub-agent is what YAAR runs; only
the manifest had to pick a word. Retiring an accepted key makes a working app silently inert, so it
fails loudly instead: `usesRetiredPersonasKey` drives a `[apps]` warning when the manifest is read
and a `retired-key` branch in `subAgentDenialReason`, so the refusal says "rename it" rather than
"add it" — the same trap the bundled-only gate used to set.

**The one channel (`agents/profiles/sub-agent.ts`).** The only capability a sub-agent may be given
is a reach back into the **owning app's own iframe**. `buildSubAgentProfile` is the one place that
is decided, and it runs on every sub-agent turn, so the turn's `allowedTools` come from the profile
and never from the call site. The allowlist is *derived* from the declared tool names
(`mcp__subagent__{name}`), never taken from the caller, so `buildSDKOptions` connects exactly one
MCP server; each of its tools becomes one app-protocol command (`persona:{name}`) to the app's
active window on its own monitor, with `personaId` stamped last so a model cannot answer as another
character. No window → an error *result*, never a launched window and never a dead turn. Grants to
the app *agent* (`controls`, `direct_message`) do not descend. Commands named `persona:*` are hidden
from the app agent's `describe`/manifest (`features/apps/persona-commands.ts`) because their
spawn-time descriptions are written for a character, not an operator.

In the pool a sub-agent lives in `subAgents` under `subAgentKey(monitorId, appId, subId)`. That key
extends the app agent's, which extends the monitor's — the four collections are one tree (session →
monitor → app → sub-agent), addressed through the owner and torn down with it. `buildAgentTree()`
renders the flat roster in that shape, and `list('yaar://session/agents')` returns both views
(`agents` flat, `tree` nested; a `tree` node with `id: null` is an owner slot nobody occupies — an
app whose personas exist but whose own agent was never needed). In the pool the id field is `subId`;
the **wire** keeps `personaId` (URI segment, spawn param, response bodies), and
`handlers/apps/agents-resource.ts` is the one place the two spellings meet — read `p.subId`, emit
`personaId`. See [`docs/architecture/agent_tree.md`](../../docs/architecture/agent_tree.md)
for the four laws every new node must satisfy, and the triage rule for placing a new one.

## REST API

Routes in `http/routes/`. Pattern: `GET /health`, `GET /api/version` (running version + `bundled`/`platform`/`arch`; on the iframe allowlist with no permission check, so an app reads it without an `app.json` entry — `yaar://session/*` would have been session-principal-gated and 403'd every app), `/api/providers`, `/api/apps`, `/api/sessions`, `/api/shortcuts`, `/api/settings`, `/api/domains`, `/api/agents/stats`, `/api/storage/*`, `/api/pdf/*`, `/api/browser/*`, `/api/fetch`, `/api/pick-directory`, `/api/remote-info`, `POST /api/iframe-token`, `POST /api/verb`, `POST /api/verb/subscribe`. See `routes/api.ts`, `routes/verb.ts`, and `routes/files.ts` for full signatures.

### The access chokepoint (`http/access.ts`)

**A route never invents its own permission check.** It resolves the caller to a `Principal` and names the `yaar://` URI + verb it is about to perform:

```ts
const principal = resolvePrincipal(req, url);        // host | app  (or a 403 Response)
if (principal instanceof Response) return principal;
const denied = requirePermission(principal, 'yaar://config/domains', 'invoke');
if (denied) return denied;
```

This is the same check `POST /api/verb` runs, shared rather than duplicated — the REST routes used to reach storage, config, and session logs with no check at all.

- **`host`** — the desktop (no iframe token). Unconfined; in `REMOTE=1` it has already proven the remote token in `auth.ts`.
- **`app`** — an iframe token. Confined to its app.json `permissions`, plus the auto-granted `yaar://apps/self/{storage,db,agents}/` (`SELF_GRANTS` in `iframe-tokens.ts` — `self` resolves to the token's own appId, so these can never name another app).
- `requireHost()` — routes no app can hold a permission for (`/api/iframe-token`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, `/api/dev/preview/{appId}`, session restore). The preview route serves an installed app as a *top-level* page with its own iframe token injected (the supported standalone/CDP verification path — see `docs/guides/app-development.md`); it hands out an app's identity, so it carries the same gate as the token mint.
- `requireBundle()` — gated SDK doors (`/api/dev/*` → `yaar-dev`; `/api/browser`, `/api/bridge` → `yaar-web`; `/api/ml-weights*` → `yaar-ml`). The compiler's `bundles` gate only sees an app's *source*; a hand-written `fetch()` never went near it.
- `storageUriFor()` — maps an HTTP storage path to the URI that names the same file. `/api/storage/apps/{id}/x` **is** `yaar://apps/{id}/storage/x`; only that spelling is what an app holds a permission for. `self` is resolved on both sides of the match (app.json says `apps/self`, a URI from a path says `apps/notes`).
- **The same rewrite runs inside `requirePermission`**, so a URI taken from a request body (`POST /api/verb`) is canonicalized too — `yaar://storage/apps/vault/x` is matched as `yaar://apps/vault/storage/x`. Without it, prefix matching made a declared `yaar://storage/` a permission for every app's private storage; thirteen bundled apps declare it. Applied to grants as well as targets, so either spelling works and they agree. A traversing storage URI names no resource and is refused.
- Tokens for subresources that cannot set a header (`<img src>`, `EventSource`) ride as `?__yaar_token=`.

**The origin boundary (token-forgery closed):** app-origin isolation is on by default, locally and over the network (`YAAR_APP_ORIGIN_ISOLATION`, set `=0` to disable). Installed apps are served cross-origin (from `127.0.0.1` locally, from `…ts.net:8443` over Tailscale Serve) and `resolvePrincipal` refuses a token-less request carrying the app origin, so an app cannot omit its token and be resolved as `host`. Being cross-origin the browser blocks `window.parent` DOM/memory reach, and top-level navigation (`window.top.location`) is closed by `ISOLATED_APP_SANDBOX` (IframeRenderer.tsx), which withholds only the top-navigation family. The residual is the isolation-*off* case and a tailnet **app** rule that fails to register (logged by `tailscale-tunnel.ts`; deliberately not backfilled with the loopback alias, since a remote browser resolves no `127.0.0.1` of ours and the frontend's `siblingLoopbackOrigin()` derives one only on `localhost`). A tunnel that fails to come up leaves the server loopback-only, where `startTunnel` installs the loopback-alias boundary explicitly (`isAppOriginIsolationEnabled()` is false under `IS_REMOTE`, so without that call the fallback would run with none). One consequence: an isolated app's calls authenticate with their **iframe token**, accepted by `checkHttpAuth` as a credential in its own right — a cross-origin `Referer` is trimmed to a bare origin, so the remote token cannot ride along in it. See [`docs/guides/remote_mode.md`](../../docs/guides/remote_mode.md).

**MCP principal:** each agent gets a token minted by `mcp/agent-tokens.ts` and bound to its id server-side; providers send it as `X-Agent-Token`. The shared bearer token (`getMcpToken()`) is transport auth only and says nothing about *which* agent is calling. There is deliberately no `x-agent-id` header — an agent that can name a principal can become it.

## Self-update (`features/update/`)

`yaar://system/update` is how YAAR learns about and installs its own releases; the Configurations
app's **Updates** tab is the one consumer, and it renders the server's answer rather than
re-deriving any of it. Four files: `semver.ts` (comparison), `release.ts` (GitHub's
`/releases/latest`, asset naming, `SHA256SUMS` parsing — all pure or injected-`fetch`),
`installer.ts` (download, verify, swap), `updater.ts` (status + orchestration).

Five things are load-bearing:

- **`read` never hits the network; only `invoke {action:'check'}` does.** The UI polls `read` once
  a second during an install, and the anonymous GitHub API allows 60 requests an hour per IP.
  `check` is itself cached for 5 minutes, `force: true` bypasses it.
- **`invoke {action:'install'}` returns once the work has started**, not when it finishes. A
  verified download of the binary plus the apps archive is minutes on a slow link; an HTTP request
  held open for that is indistinguishable from a hang. Refusals (nothing to install, GitHub
  unreachable, this build cannot self-update) are thrown *synchronously* so the caller learns the
  reason without reading it back out of progress state.
- **A missing or mismatched `SHA256SUMS` is a hard failure.** install.sh warns and continues,
  because it must still work against releases cut before the manifest existed and against a
  `VERSION=` pin at one of those tags; the updater only ever targets the latest release, which
  always publishes one — and a user who clicks a button and walks away has no shell to read a
  warning in.
- **Staging is a sibling of `process.execPath`, never `os.tmpdir()`.** The swap is `rename(2)`,
  which fails across filesystems, and `/tmp` frequently is one.
- **`getUpdateStatus()` reports the *first* blocker, not the last.** `source-checkout` outranks
  `no-asset`: a dev checkout is blocked whether or not the release ships its platform's binary, and
  "download it from the releases page" is the wrong advice for one. `blockedReason` maps 1:1 onto
  the hint the app shows.

Installing never restarts the server — the running process still holds the old code, and the
previous binary is left beside the new one as `yaar.previous` (Windows cannot delete a running
executable; the *next* install clears it).

Adding `system` to `YaarAuthority` (`packages/shared/src/yaar-uri.ts`) is what makes the URI
resolvable — `resolveUri`'s fallback and its bare-authority regex both list it, alongside `skills`
and `mcp`, as an authority with no dedicated parser.
