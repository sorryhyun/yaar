# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
bun run test                   # Every suite, each in the process it needs
```

## Tests

`bun run test` is `scripts/run-tests.ts`. It globs **every** `*.test.ts` under `src/` (colocated
files included — which is why `tsconfig.build.json` excludes `**/*.test.ts`), groups them by
`scripts/test/partitions.ts`, and spawns one process per group, concurrently. The partitions:

1. `units` — one `--parallel` process for the plain unit/component tests.
2. `remote` — `src/tests/remote/`, with `REMOTE=1` pinned for the whole process (`IS_REMOTE` is a
   module-load constant, so remote-gate assertions are vacuous in a local-mode process).
3. `loopback` — `src/tests/loopback/`, the real stack end to end with exactly two fakes
   (`FakeClient` for the browser, `ScriptedProvider` for the model); sequential, binds real
   sockets. See `tests/loopback/harness/boot.ts`'s header for the deadlock it exists to catch.
4. `realfs` — `src/tests/realfs/`, real `git` over a shared fixture dir. (The *integration* suite
   is the separate `@yaar/tests` package.)
5. one process per file that calls `mock.module` — the stub is process-global with no teardown.

The split is load-bearing and enforced: `scripts/test/partition-guard.ts` (preloaded via
`bunfig.toml`) stops any run that mixes partitions and prints the right command for each.
Every suite starts from a pinned environment — `scripts/test/env.ts` scrubs `YAAR_*` and the
documented knobs and points config/storage/session-logs at temp dirs, and sets `YAAR_TEST_REMOTE=1` itself
when the collected files live under `src/tests/remote/`, so a by-path run stays a remote-mode
run. Full rationale, including the CI incidents that forced each rule, is in
`scripts/test/partitions.ts` and `scripts/test/env.ts`.

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
- `YAAR_STORAGE` / `YAAR_CONFIG` / `YAAR_SESSION_LOGS` - Override storage/config/session-log directory paths. All three are pinned to temp dirs by `scripts/test/env.ts` — a suite that builds a `SessionLogger` mints a log directory, which is how `session_logs/` used to collect `app-persona-…` logs from `bun run test`.
- `YAAR_KEEP_EMPTY_SESSIONS` - `1` keeps session logs that recorded nothing. Off by default: `createSession()` runs at boot so a click before the first message is still logged, so every launch the user closed without typing left a directory behind — in `yaar://history/` and `GET /api/sessions` as much as on disk. The launch that would add the next one sweeps them first. What counts as empty (exactly the created shape, every log zero-length) and what protects a concurrently-running instance's log (the creating `pid` in `metadata.json`, plus a 5-minute grace window) is `logging/prune.ts`.
- `YAAR_LOG_LEVEL` - `debug` | `info` (default) | `warn` | `error`. The floor for `observability/log.ts`. `debug` is off by default, which is the one visibility change the console→logger conversion made: everything that used to be `console.log` is `info` and still prints, but genuinely chatty lines (`codex` item/started, the Claude SDK message trace, `entered agent context`) were demoted and now need `YAAR_LOG_LEVEL=debug`.
- `YAAR_LOG_FORMAT` - `pretty` (default) or `json`. Pretty is the terminal format the `[Component] message` lines always had, plus `key=value` fields and the monitor/agent ids; `json` is one object per line carrying **every** context id (session, monitor, agent, window, app) and an ISO timestamp. Both are scrubbed by `scripts/test/env.ts`'s `YAAR_` prefix sweep, so a suite never inherits a developer's setting.
- `YAAR_SKIP_DOTENV` - `1` skips loading the root `.env` in `config/env.ts`. Set by `scripts/test/env.ts`: a test run pins every knob explicitly, and "fill in what is unset" is the one door a developer's `.env` could otherwise walk back through.
- `YAAR_TEST_REMOTE` - Test-runner only. `1` makes `scripts/test/env.ts` pin `REMOTE=1` for the process, which is how `src/tests/remote/` gets a genuine remote-mode `IS_REMOTE`.
- `YAAR_APP_ORIGIN_ISOLATION` - App-origin isolation (**on by default**; set `=0` to disable). Serves `source:'user'` app iframes from a distinct browser origin so they are cross-origin to the desktop; `resolvePrincipal` refuses a token-less request carrying the app origin. **Which two origins** (`loopback-alias` locally, `proxy-port` over Tailscale Serve, `off`) is `http/origin-boundary.ts`'s business and the one place to ask — its header explains both modes and why the proxy-port attribution is unforgeable. See [`docs/guides/remote_mode.md`](../../docs/guides/remote_mode.md).
- `MONITOR_MAX_CONCURRENT` (default: 2), `MONITOR_MAX_ACTIONS_PER_MIN` (30), `MONITOR_MAX_OUTPUT_PER_MIN` (50000) - Background monitor budget limits
- `APP_AGENT_IDLE_MINUTES` (default: 15) - How long an app agent may sit idle before `AgentPool` reclaims it; `0` disables the reaper. Closing an app's **last** window on a monitor already retires its agent, so this is the backstop for the app left open and unused: app agents had no other reclaim path — not window close, only `fresh:true`, monitor removal, explicit delete, or session teardown — so against a process-global `MAX_AGENTS` of 10, apps opened once and left alone used to hold their slots until restart. Reaping ends the agent's provider session, so its memory goes with it (the same thing `fresh: true` and a last-window close both do deliberately); reaping leaves its sub-agents alone, because their owner is the (monitor, app) pair — only a last-window close, monitor removal, or teardown takes those.
- `CODEX_WS_PORT` (default: 4510), `CHROME_PATH` (auto-detected), `MARKET_URL`
- `CODEX_HOME` - Codex's own var, inherited by the spawn — and read by YAAR *before* it, because `getCodexAppServerArgs()` derives one `-c mcp_servers.<name>.enabled=false` per server `$CODEX_HOME/config.toml` declares (`detectUserMcpServers()` in `config/providers/codex.ts`). That list has to be detected, not written down: naming a server the config does not declare leaves codex with a table holding only `enabled` and it refuses to boot (`invalid transport in mcp_servers.<name>`). Pinned to an empty temp dir by `scripts/test/env.ts` so the spawn args do not depend on whether the developer has the ChatGPT desktop app installed.
- `YAAR_BROWSER_PROVIDER` - **No longer a selector.** `POST /api/browser` is always the headless sandbox (`getHeadlessBrowser()`); the user's real Chrome is reached only through the session-agent door `yaar://session/browser` (`getLocalBrowser()`), which auto-attaches whenever a debuggable Chrome is reachable. The var survives only as a **force-headless opt-out**: set `=headless` to keep the agent away from your real browser (the session door then uses the sandbox too).
- `CHROME_DEBUG_PORT` (default: 9222) - DevTools port the local (session-door) browser provider attaches to (user launches Chrome with `--remote-debugging-port`).
- `YAAR_CLIPBOARD_SECRETS` - **On by default**; set `=0` to disable. Redacts vendor-prefixed credentials (API keys, tokens, PEM private keys, passwords in connection URLs) out of clipboard **text** before it reaches an agent — `features/user/secret-scan.ts`, applied in `features/user/clipboard.ts` so it covers `read` *and* `save`. Guarding only `read` would not be a guard: `save` writes to storage and returns a URI, so a raw write leaves the secret one `read('yaar://storage/...')` away. Redaction rather than refusal, because a refused read makes an LLM ask the user to paste the content into the chat instead — same context window, no scan. Detection is prefix-anchored only (no entropy tier, no labeled-assignment tier, no checksum verification — a checksum can only ever *reject* a match, so a bug in it leaks), and images are not scanned at all. The opt-out is for agents whose job is the credential itself.
- `YAAR_CLIPBOARD_GRANT` - **On by default**; set `=0` to disable. Pre-grants clipboard read/write to the desktop origin in that same Chrome over CDP, so `yaar://user/clipboard` never shows the user a permission prompt. `lib/browser/clipboard-grant.ts` holds a browser-level CDP connection open for the process's life to do it — the override is scoped to the DevTools *connection*, not the profile, so there is no launch flag or config file that can replace it (the header records the measurements). Deliberately grants only `DESKTOP_ORIGIN_HOST`, never `APP_ORIGIN_HOST`: the app origin is where isolated app iframes live, and a grant there would hand every installed app the user's clipboard past its `app.json` permissions. The opt-out exists because with this on, any agent turn reads the clipboard with no prompt and no visible indication.

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
│   ├── app-window-coordinator.ts    # AppWindowCoordinator — app readiness, command replay, app-channel/bridge-event routing
│   ├── desktop-request.ts           # DesktopRequest — the ask-the-desktop-and-wait prelude every server→client question shares
│   ├── app-ready-registry.ts        # AppReadyRegistry — which iframes are registered *right now*, per (session, window)
│   └── interrupt-gate.ts            # InterruptGate — agent ids whose stopped turn is still emitting
├── websocket/            # WebSocket server + connection registry
├── agents/               # Agent lifecycle, pooling, context management
│   ├── agent-pool.ts     # AgentPool — creation, disposal, and the global slot each agent holds
│   ├── agent-roster.ts   # PooledAgent, the composite keys, listAgents()/buildAgentTree() — pure projections
│   ├── sub-agent-registry.ts   # SubAgentRegistry — the whole sub-agent tier, reached via `AgentPool.subAgents`
│   ├── spawn-reservations.ts   # SpawnReservations — reserve-before-first-await / join / settle-before-sweep
│   ├── context-pool.ts   # ContextPool — unified task orchestration
│   ├── context.ts        # ContextTape — hierarchical message history
│   ├── limiter.ts        # AgentLimiter — global agent semaphore
│   ├── agent-session.ts  # AgentSession + AsyncLocalStorage (getAgentId, getSessionId)
│   ├── monitor-task-processor.ts / app-task-processor.ts / session-task-processor.ts
│   ├── window-event-coordinator.ts  # subscription/notification fan-out + window-close teardown
│   ├── interaction-timeline.ts / pool-types.ts / turn-helpers.ts
│   ├── profiles/         # app-agent, session-agent, sub-agent, orchestrator, model-tiers, shared-sections, types, index (barrel)
│   ├── session-policies/       # StreamToEventMapper, ToolActionBridge
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
├── observability/        # log.ts — structured logging; the ONLY sanctioned console.* in the server
├── logging/              # Session logging (JSONL), reading, context/window restore, empty-log prune
├── storage/              # StorageManager, permissions, shortcuts, settings, mounts
└── lib/                  # Standalone utilities (no server internal imports)
    ├── browser/ pdf/ pick-directory.ts
    ├── schema-refs.ts         # resolveRef/selfContained — following a protocol schema's `$defs` pointers
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
| Semaphore | `AgentLimiter` | Global agent limit. Production only calls `tryAcquire()` — the wait queue is unreachable, so `waitingCount` is structurally zero |
| Pool | `ContextPool` | Unified agent reuse with dynamic roles |
| Warm Pool | `providers/warm-pool.ts` | Pre-initialize providers at startup |
| Context Tape | `ContextTape` | Track messages by source for injection |
| Factory | `providers/factory.ts` | Auto-detect and create providers |
| Observer | `actionEmitter` | Decouple tools from sessions |
| AsyncLocalStorage | `AgentSession` | Track agentId in async context |
| Injected resolver | `setLogContextResolver`, `setAccessPrincipalResolver`, `setWindowGrantResolver` | Give a low-level module a fact that lives above it in the import graph, wired once in `lifecycle.ts` |

### Logging

**Operational logging goes through `observability/log.ts`; `no-console` is an ESLint error
everywhere else in `src/`.** A component takes a logger once and names events, not sentences:

```ts
const log = createLogger('AgentSession');
log.warn('turn overlapped', { role, waitedFor: previousRole });
```

The session/monitor/agent/window/app ids are attached automatically, from an
`AsyncLocalStorage` resolver wired in `lifecycle.ts` (`setLogContextResolver`) — that is the
whole point, and why a bare `console.log` is refused: it carries none of them, and 300 of them
is what made a message's path across eight seams and three agent tiers unreconstructable. For a
class whose work happens *outside* an agent turn (`LiveSession`'s connection and pool events),
bind the id instead: `createLogger('LiveSession').child({ sessionId })`.

Three rules:

- **Fields, not interpolation.** `log.info('created monitor agent', { monitorId })`, never
  `` log.info(`created monitor agent for ${monitorId}`) `` — the field is what `YAAR_LOG_FORMAT=json`
  emits as a queryable key, and the interpolated string is what it cannot.
- **Ids and counts, never content.** The rule `streams/stream-diagnostics.ts` states for its
  samples ("a transcript must not be reachable through a debug switch") holds here too. The
  conversion removed two live violations: `AgentSession` logged the first 50 chars of every user
  prompt, and the Claude provider logged an image data-URL prefix. Both are counts now. The one
  deliberate excerpt left is the tool-error `detail` in `StreamToEventMapper`, kept because "a
  tool failed" without its text is unactionable, and commented as such at the call site.
- **The component name comes from `createLogger`, not the string.** The old `[Bracket]` prefixes
  had drifted — `MonitorTaskProcessor` and `turn-helpers` both logged as `[ContextPool]`.

Levels: `debug` (off by default), `info`, `warn`, `error`, floor set by `YAAR_LOG_LEVEL`. Each
maps to its own console method, so `warn` reaches `console.warn` — several test helpers spy on
exactly that, and routing warn through `console.error` keeps the stream right while making every
one of those spies observe nothing. The exemptions to `no-console` are listed with their reasons
in `eslint.config.js`: the boot banner and QR code (`lifecycle.ts`, `main.ts`, `exe-entry.ts`) are
the CLI talking to its user, `dev-bundle-worker.ts`'s stdout *is* its result channel, and `lib/**`
plus `providers/codex/version.ts` are the dependency-free modules whose contracts forbid the
import.

## Providers

**AITransport interface:** `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`, `interrupt()`, `dispose()`.

**Warm Pool:** Providers pre-initialized at startup. `initWarmPool()` at boot, `acquireWarmProvider()` gets a ready instance, pool auto-replenishes in background.

**Claude:** `claude-sonnet-4-6`, thinking enabled (4096 max tokens), WebSearch and Task tools, `bypassPermissions`. Each provider keeps a **persistent streaming session**: one long-lived CLI process whose MCP connections survive across turns; turns push messages into the stream and read until the SDK result. A prompt/tools/model change reopens the stream with `resume`. Monitor agents are prewarmed at WebSocket connect (`ContextPool.prewarmMonitorAgent` → `AgentSession.prewarm` → `provider.prewarm`) so the first user message starts on a live process with MCP already connected — the first turn is also gated on MCP connection (bounded 5s) because the CLI no longer waits for HTTP MCP servers in stream-json mode.

**Provider failure channels — the `notice` contract (`providers/notice.ts`):** both SDKs report trouble on far more channels than they report *fatal* trouble on, and both were read for the fatal one alone. A recoverable failure becomes **`StreamMessage.type === 'notice'`**, never `error`: `error` is terminal by contract — `StreamToEventMapper.map` calls `fail()`, which latches the turn closed, and both providers' read loops stop on it — so reporting a retryable failure that way ends the turn in the UI while the provider carries on working. Notices reach the client as `ServerEventType.AGENT_NOTICE` (a CLI-panel line, never `connectionError` and never a failed message) and as a `notice` frame on `yaar://agents/{id}/stream`. `ProviderNotice` + `toNoticeMessage` live in `providers/notice.ts`; each provider's vocabulary lives beside its mapper.

**Claude failure channels (`providers/claude/errors.ts`):** `assistant.error` (a typed `SDKAssistantMessageError`), `system/api_retry`, `system/permission_denied`, `system/model_refusal_*` and `rate_limit_event` all become notices. Only the SDK's `result` terminal stays an `error`, and its text is assembled from `terminal_reason` and `stop_reason` when `errors[]` is empty (it usually is — that is where "Unknown SDK error" came from); `errors[]` still goes first verbatim, since the stale-session retry matches `No conversation found` in it. The code→sentence tables are total over the SDK's unions, so a CLI bump that adds a code breaks the build rather than degrading to the code name. Covered by `tests/claude-error-notices.test.ts`.

**Codex:** `codex app-server` child process with per-provider WebSocket connections (`--listen ws://`). Settings: `approval_policy=on-request`, `model_reasoning_effort=medium`, `sandbox_mode=danger-full-access`.

**Codex failure channels (`providers/codex/errors.ts`):** the load-bearing one is `ErrorNotification.willRetry`. Every `error` notification used to map to a terminal message, which latched the turn closed *and* tripped the `done` short-circuit in `CodexProvider`'s read loop — so a transient failure the app-server was about to retry ended the turn and the retry's answer was never read. `willRetry: true` is now a notice, and **the mapper and the loop must agree**: `provider.ts` skips its turn-done check for the same case. Beyond that, four dedicated user-facing channels (`warning`, `guardianWarning`, `configWarning`, `deprecationNotice`) used to fall through to `console.debug`, `account/rateLimits/updated` and `model/rerouted` were in `IGNORED_METHODS` by name, and a turn failure was reduced to `TurnError.message` — discarding the typed `CodexErrorInfo` beside it. `NOTICE_METHODS` exists so a handled method's *quiet* state (`status: 'ready'`, a gauge below its limit) is not logged as unhandled. Covered by `tests/codex-error-notices.test.ts`.

**Codex version policy (`providers/codex/version.ts`):** the bindings in `providers/codex/generated/` are hand-generated by `make codex-types`, so an under-versioned CLI is **refused rather than driven** — at codegen (fails closed), at auto-detect in `factory.ts` (skipped, Claude picked), and at the `initialize` handshake (`assertSupportedCodex`, the only gate that catches a stale process on `CODEX_WS_PORT`). A **forced** `PROVIDER=codex` turns the refusal into a refused boot rather than a silent fallback. Gate-by-gate rationale in `version.ts`; covered by `tests/codex-version.test.ts` and `tests/warm-pool-codex-version.test.ts`.

`@openai/codex` is declared as an **optional peer dependency** so a Codex user can pin the CLI to the lockfile (`bun add @openai/codex`) instead of driving whatever PATH resolves first, while a plain `bun install` downloads none of it — the package is an 11 KB launcher whose real binary is a 275–370 MB `os`/`cpu`-gated optional dependency. `getCodexSpawnArgs()` (`config/providers/codex.ts`) resolves the **vendored binary** directly and never the package's `bin/codex.js`, which would add a Node process in front of every app-server and interpose its own signal forwarding on the process group `setsid -w` exists to expose. Pinning retires no gate: only gate 1 sees the codegen binary, gate 2 still covers a PATH codex, and gate 3 is about a stale process on the port, which no dependency version describes. The declared range is pinned to `CODEX_MIN_VERSION` by the same test — stated in two files, it would drift into admitting a CLI the gates refuse.

## Tools (MCP)

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`, `messaging`, and `subagent`. The `verbs` server exposes 5 generic tools (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import domain logic from `features/`) via `yaar://` URIs.

**Two protocol eras, one endpoint.** `handleMcpRequest` forks per request. 2025-era traffic keeps the **stateful** path it has always had — `initialize` mints an `mcp-session-id`, and the `mcpSessions` map, the idle eviction loop, and the GET common-stream keep-alive all belong to it. A **2026-07-28** client is stateless: it probes `server/discover`, sends no `initialize` and carries no session id, so it is routed to `createMcpHandler`, whose per-request server factory is just `createServerForName`. Only a session-less POST can be modern, which keeps every tool call off the classifier. Two traps, both documented at `getModernHandler`: adding `2026-07-28` to `supportedProtocolVersions` is *not* the opt-in (the probe is refused before it reaches an instance and the client silently drops to 2025-11-25), and the modern handler is built with `legacy: 'reject'` so it can never answer 2025-era traffic statelessly and quietly drop the session stream. YAAR now asks **both** providers to negotiate up — Codex via `features.mcp_2026_07_28=true` (`ENABLED_FEATURES` in `config/providers/codex.ts`), Claude via `MCP_SDK_GENERATION=v2` + `MCP_PROTOCOL_NEGOTIATION=auto` (`CLAUDE_ENV_OVERRIDES` in `config/providers/claude.ts`; both vars are required, either alone is a no-op). Codex's `CODEX_MCP_PROTOCOL_VERSION` env var looks like the Codex gate and is not: measured against `codex-cli 0.147.0`, the var alone leaves every HTTP MCP server on the 2025-era stateful leg, while the feature flag alone moves them to `server/discover` with the var unset — the CLI reads that var only for **stdio** servers, and YAAR's are all HTTP. The flag's stage is `under development`, so it is a deliberate opt-in, and the stateful leg is what catches a regression silently. The stateful leg stays because those are undocumented gates in unpinned CLIs: a client that cannot negotiate up falls back to `initialize` silently and keeps working. Both rows are pinned by `tests/mcp-protocol-eras.test.ts`.

**The legacy leg is deprecated, and instrumented so you can prove it is unused.** Its machinery is fenced between `BEGIN/END deprecated: 2025-era stateful leg` banners in `mcp/server.ts` and every declaration inside carries `@deprecated` — the fence is where the eventual cut goes, so don't add to it or reach into it from the modern path. `getMcpEraStats()` reports `modernRequestsServed` / `legacyRequestsServed` / `legacySessionsCreated`, and the first legacy connection in a process logs a one-time `[MCP] DEPRECATED protocol era:` warning naming the client that failed to negotiate up (a stale CLI and a renamed gate are indistinguishable without the name). A session that never prints it and reports `legacyRequestsServed: 0` is the evidence for criterion 3 of `docs/proposals/mcp_modern_only_proposal.md`; the counters undercount by design, since they gate a deletion.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs dispatching to `handlers/` via `yaar://` URIs |
| `mcp/system/` | system | reload_cached, list_reload_options |
| `mcp/sub-agent/` | subagent | app-defined tools of the *calling* sub-agent — the only namespace whose tool list depends on who connects; empty for everyone else |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for rendering feedback. Window tools support lock protection — only the locking agent can modify a locked window.

**Verb semantics: `describe` is the manual, `read` is the current value, `list` is what's addressable.** A handler that blurs the three makes a prompt offer rather than instruct — the monitor prompt used to say "use `read(...)` **or** `describe(...)`" precisely because, for apps, both doors returned the same generated reference doc. They now answer different questions:

| | `yaar://apps/{id}` — the *installed* app | `yaar://windows/{id}` — the *running* instance |
|---|---|---|
| `describe` | identity + `agent/SKILL.md` + permissions + the **names** of its state keys and commands + this door's `verbs`/`invokeActions`/`subPaths` | this instance's manual, tagged `source: 'live'` (the iframe's registration) or `'manifest'` (disk), plus `builtinState` |
| `read` | the effective, **post-grant** manifest from `getAppMeta` | metadata + `__content`, or metadata + `__screenshot` for an iframe |
| `list` | ✗ not a collection | this window's built-in keys, then the app's state keys and commands, as an **index** (signature + first sentence) |
| sub-paths | `protocol`, `storage/`, `db/`, `agents/` | `state/{key}`, `commands/{key}` |

Six rules hold this together, each closing a false success (each is documented in full at the
named site):

- **`exists?(resolved)` on `ResourceHandler`** is consulted before the auto-generated `describe`; a `/*` wildcard that declares neither `exists` nor `describe` makes `register()` **throw**. (`handlers/uri-registry.ts`)
- **The same action list is declared once** — `defineActions` derives the schema `enum`, `describe`'s `invokeActions`, and the dispatch from one table, so they cannot drift. (`handlers/define-actions.ts`)
- **`yaar://apps/{id}/state/…` and `/commands/…` are refused on every verb** — protocol state belongs to a running window, and the same app on two monitors is two states. (`handlers/apps/register.ts`)
- **Every other unclaimed sub-path is refused too** — the app handlers take their id from the first segment with `extractIdFromUri` and ignore the rest, so anything the resource modules declined used to answer as the bare app. A false success is worse than a 404. (`rejectUnhandledSubPath`, same file)
- **A missing directory is an error, not an empty list** (`storageList` sets `notFound`); namespace roots opt back in explicitly.
- **A resource that exists and holds nothing answers, it does not complain** — every window has the three built-in state keys (`BUILTIN_STATE`: `__content`, `__screenshot`, `__console`; `__` is reserved, an app key by those names is shadowed). (`handlers/window.ts`)

**A call batches on two axes, and neither is a handler's business.** Brace expansion (`handlers/index.ts`) batches *URIs* against one payload, concurrently. An **array payload** to `invoke` batches *payloads* against one URI, run **sequentially** by `ResourceRegistry.execute`, stopping at the first failure and naming the index to resend from; each element is resolved, access-checked and verb-checked exactly as a lone invoke would be — a batch is a spelling, never a bypass. `handler.invoke` never sees the array (`MAX_BATCH_PAYLOADS = 100`, refused rather than truncated). Rationale at the `MAX_BATCH_PAYLOADS` declaration in `uri-registry.ts`.

**Only one of the two axes exists at each door.** Brace expansion is the MCP `exec` wrapper's, so `POST /api/verb` — which dispatches the URI verbatim — refuses a brace URI by name rather than letting it reach the registry as an unknown one ("No handler registered for …" pointed apps at the wrong problem). The array-payload axis works at both.

**Access tiers (URI access control):** every agent carries a principal `role` (`session` / `monitor` / `app`) on its `AgentContext`. A handler may declare `access: 'session-principal'`, and `ResourceRegistry.execute()` then applies **one** definition:

> A caller satisfies `access: 'session-principal'` iff its role is `session` **or** it is a token-backed bundled system app (`AgentContext.systemApp`).

Everything else is refused — default-deny, so `undefined` is neither. **That gate is the authority**: both doors into the verb layer end there (MCP tools and `POST /api/verb`), which is why it, not `http/access.ts`, defines the tier. `access.ts`'s `isSessionUri` refusal stays as the cheap early 403 for non-system apps and applies the same widening; the two used to answer in different currencies (token `systemApp` vs. agent `role`), so a bundled system app was admitted by one door and 403'd by the other — and `yaar://session/agents` could only keep working for Process Explorer by carrying no tag at all. All seven `yaar://session/*` registrations now carry the tag.

The role is resolved from the pool (`AgentPool.getRoleForAgent` via `SessionHub.findRoleForAgent`) in the MCP path and from the per-turn role string (`principalRole()`) in-process — `agents/roles.ts` owns both the prefixes a role is minted with and the parse that maps one onto a tier, so the string and the gate that reads it cannot drift apart; `systemApp` is set by `routes/verb.ts` from the **validated iframe token**, never from the request body, so it is exactly as forgeable as the token (i.e. not — `getAppMeta` sets it for bundled `kind: "system"` apps only). The gate's principal resolver is injected via `setAccessPrincipalResolver()` (wired in `lifecycle.ts`) to avoid a runtime import cycle.

**App Protocol:** Bidirectional agent-iframe communication via `query`/`command` tools (in the `app` MCP server). Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. See shared CLAUDE.md for event schemas. A fourth request kind, `describe`, documents **one** state key or command on demand (`handleAppDescribe` in `features/window/app-protocol.ts`) — never folded into the manifest, or every manifest read would pay for every key. A command's answer carries its rendered `signature`, an `invoke` example, and its `schema` (`lib/command-signature.ts`); the signature also prefixes each command's `description` in `list('yaar://windows/{id}')`, so the list is enough to call from. That list is an **index**: the description is summarized to its first sentence (`lib/protocol-index.ts`, shared with `list('yaar://apps/{id}/protocol')`), because a list is for *finding* the command and every-word-of-every-description made the door 79.9 KB for a 52-command app.

**A protocol has two honest sizes, and they get two doors.** `describe('yaar://apps/{id}')` used
to inline `dist/protocol.json`, making one answer responsible for "what is this app" (identity +
SKILL.md, a fixed ~10 KB) and "what does every one of its 52 commands accept" (41.8 KB, unbounded
in command count). Their sum crossed the size at which the Claude CLI stops delivering a tool
result inline and substitutes a path on disk — which for a monitor agent, holding five `yaar://`
verbs and no filesystem tools, is a dead end. The protocol is now its own resource
(`handlers/apps/protocol-resource.ts`) where the verbs mean what they mean everywhere else:
`describe` is counts and doors, `list` is the index, `read` is the manifest, and
`read('…/protocol/commands/{name}')` is one command self-contained and brace-batchable. So the
index is *what `list` means*, not a degradation a byte budget switches on, and nothing is
truncated behind a caller's back. Measured on studio-3d: describe 54.6 KB → 13.6 KB, index 10.7 KB.

**The cliff itself has since been named and moved** (`mcp/result-size.ts`). It is 50,000
*characters* for any unannotated MCP tool — not `MAX_MCP_OUTPUT_TOKENS`, which YAAR had already
raised to 131072 and which governs image content and the warning, not the persist decision. A
server raises its own by declaring `_meta["anthropic/maxResultSizeChars"]` on the `tools/list`
entry, and YAAR declares 150,000 on the four content-bearing verbs and the three app-agent
doors. Not the 500,000 the CLI ceiling allows: a second, un-annotatable ~200,000-char budget
across one assistant message's tool results persists the largest anyway, so 150,000 is that
maximum with room for a sibling call. Pinned over the wire by `tests/mcp-result-size.test.ts`.
This raises the floor under the reads YAAR does not compose; it does **not** retire the
two-doors design above, which is still how a payload YAAR *does* compose should be sized.
`features/apps/describe.ts` emits command **names** for the verbs door and the full index for the
app agent's `describe` **tool** — that caller holds no `read` verb, so a URI it cannot open would
be the same dead end at one remove, and `describe({ command })` is its spelling of the
per-command read. Rationale and the incident: `docs/proposals/app_describe_size_proposal.md`.

**A schema may point at the manifest, so every reader has to follow the pointer.** The compiler
hoists a shape an app repeats into `manifest.$defs` and leaves `{"$ref": "#/$defs/x}"` at each
use (`compiler/src/protocol/dedupe-schemas.ts`). `lib/schema-refs.ts` is the one resolver:
`resolveRef` for the renderers — a ref rendered without the table is `any`, a signature that
silently says *less* than the one it replaced — and `selfContained` for any door that hands one
descriptor's schema on **alone**. The three renderers take `$defs` as a trailing optional
argument, passed at the three seams that hold a manifest: `list` on a window
(`handlers/window.ts`), the per-command `describe` (`features/window/app-protocol.ts`, which
also makes its `schema:` self-contained), and the app agent's prompt
(`agents/profiles/app-agent.ts`). A descriptor's *top-level* schema is never hoisted, so
`params.properties`/`required` — what the iframe bridge validates against — are always readable
without a hop.

**A reserved payload key (`action`/`params`/`timeoutMs`) is checked against the command's schema, not against its name** — a command that *declares* one of those params keeps it, and a declared `timeoutMs` also steers the transport deadline. Full story at `invokeSubResource` in `handlers/window.ts`.

**Monitor ↔ App Agent Communication:**
- **Monitor → App**: `invoke('yaar://windows/{id}', { action: 'message', message: '...' })` — wraps message in `<monitor:{monitorId}>` tags and routes as an app task via `AppTaskProcessor`. Fire-and-forget; use `hook: 'response'` to get the app agent's reply back.
- **Monitor → App, starting over**: the same call with `fresh: true` retires the app agent first (its memory lives in its provider session, which `disposeAppAgent` ends), so the message is answered by an agent that remembers nothing. A `fresh` task never steers, releases inside the processing lock, and drops handoff fingerprints; sub-agents deliberately survive (their owner is the (monitor, app) pair, not the app agent). The rationale for each lives as comments in `AppTaskProcessor` and `AgentPool`.
- **App → Monitor**: App agent's `relay` tool enqueues a `type: 'monitor'` task. Additionally, app agent responses are pushed to `InteractionTimeline` and drained by the monitor on its next turn.

**Sub-agents / persona agents (`yaar://apps/self/agents`):** an app that declares
`"subagents": { "max": N }` in its app.json may spawn up to N AI instances, each with a
runtime-supplied system prompt and its own provider session/memory. The verb surface is
`handlers/apps/agents-resource.ts` (`list` / `invoke {spawn|message|interrupt}` / `read` /
`delete`), callable only from the app's own iframe — the appId in the URI must equal the appId the
*context* says the caller is. `message` returns as soon as the turn is queued; answers arrive on
`yaar://agents/{instanceId}/stream` (needs `"streams": ["agents"]`).

The containment and gating rules, each documented in full at the named site:

- **No YAAR verbs, no permissions, no principal.** A spawn with no `tools` gets
  `allowedTools: []` — that empty array is the whole containment story, since `undefined` would
  mean *every* tool. Sub-agents bypass `ContextPool` entirely and are reclaimed with the app's
  last window, the monitor, or explicit `delete`.
- **The only capability is a reach back into the owning app's own iframe**
  (`agents/profiles/sub-agent.ts`): each declared tool becomes one `persona:{name}` app-protocol
  command, `personaId` stamped last so a model cannot answer as another character. Grants to the
  app *agent* (`controls`, `direct_message`) do not descend.
- **`subagents`/`streams` are granted by the user at install time** and applied as a ceiling by
  intersection with the recorded grant — see `features/apps/capabilities.ts` /
  `storage/app-grants.ts` for why intersection, update-diffing against the grant, and
  uninstall-clears-grant all follow. `controls` stays bundled-only.
- **One manifest key**: the `"personas"` alias is retired and refused by name
  (`usesRetiredPersonasKey`); the **wire** still says `personaId` — `agents-resource.ts` is the one
  place the two spellings meet (read `p.subId`, emit `personaId`).

In the pool, `subAgentKey(monitorId, appId, subId)` extends the app agent's key, which extends the
monitor's — session → monitor → app → sub-agent is one tree, addressed through the owner and torn
down with it; `list('yaar://session/agents')` returns both flat and tree views. See
[`docs/architecture/agent_tree.md`](../../docs/architecture/agent_tree.md) for the four laws every
new node must satisfy and the triage rule for placing one. Reference consumer: `chitchats` (now on
the market, so no bundled app exercises this path in-tree).

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
- **`app`** — an iframe token. Confined to its app.json `permissions`, plus the auto-granted `yaar://apps/self/{storage,db,agents}/` (`SELF_GRANTS` in `iframe-tokens.ts` — `self` resolves to the token's own appId, so these can never name another app), plus the commons `yaar://storage/shared/` (granted inside `permissionsAllow`, not on the token, because the app *agent*'s storage door has a permission list and no token — a mint-time grant would reach an app's iframe and not its agent; `capabilities.ts` drops a declared entry for it so the install dialog never asks about a capability the user cannot decline), plus whatever a caller **granted to its window** at runtime (below).
- **A devtools preview's identity comes off disk.** `preview--{projectId}` resolves to no installed app, so `getAppMeta` returns nothing and both `bundles` and `permissions` used to be empty — a project could only be tested after it shipped, and a declared grant 403'd in the one environment built for iterating. `previewBundles`/`previewPermissions` (`iframe-tokens.ts`) read the project's own `app.json` under `storage/apps/devtools/projects/{id}/`. Read from the **file**, never from the caller: `openPreview` passes neither, because a caller-supplied list is exactly what `mayDelegateGrants` refuses an app (and must keep refusing). `permissions` is additionally intersected with devtools' own installed list — devtools writes that file, so an unbounded read would let it mint a principal outranking itself.
- **The token is identity; `WindowStateRegistry` is authority.** A token carries who an iframe *is* — window, session, monitor, and what its own manifest declares (`permissions`, `systemApp`, `bundles`, `streams`). Everything a caller granted *to this window* at runtime lives on `WindowStateRegistry.delegatedGrants` and is read per request through `setWindowGrantResolver` (wired in `lifecycle.ts` for the same import-cycle reason as `setAccessPrincipalResolver`). The split exists because a token is not durable and a window is: every reconnect re-mints one per open iframe window, per connection, from identity alone — so authority baked in at mint time vanished on the first page refresh, which is what made devtools previews 403 on their own document after a reload. Identity is re-mintable at will; authority survives remount and dies with the window. Grants are filed under the **monitor-scoped handle** (`WindowHandleMap.handleFor`, since `window.create` records them before the window exists), and `getWindowGrants` unions every spelling on read.
- **Three producers, one home** — the registry only stores; each producer narrows:
  - **Delegated grants** (`features/window/delegated-grants.ts`) — a storage URI a *more privileged* caller names in a `window.create` payload or in `app_command` params becomes readable by that window's app. It is what makes "open this app on this file" work at all: the agent is unconfined, the app is not, and the app used to 403 on the one path it had just been handed. Four narrowings keep it delegation rather than escalation — only a caller that is neither an app agent nor an app iframe (`mayDelegateGrants`), exact files never prefixes, `read` only, and revoked when the window closes.
  - **Caller-supplied `permissions`** on a `window.create` payload (`features/window/create.ts`) — gated on the same `mayDelegateGrants` check, and *additive*, so a grant can never subtract from the manifest. `window.create` is reachable from any app declaring `yaar://windows/`, and these were once taken from the payload unconditionally **and** used to replace the manifest's list.
  - **The window's own document** (`storageDocumentUri` in `features/window/helpers.ts`) — the exact file a storage-served iframe was told to render, `read` only. The content URL is the server's choice and the browser fetches it under that window's token. Re-derived on server-restart restore (`LiveSession.regrantRestoredDocuments`); the other two were never logged and are the accepted loss across a restart.
- **A token dies with its window.** `revokeTokensForWindow` (`iframe-tokens.ts`, indexed by session+monitor+window) is wired into `LiveSession`'s `setOnWindowClose` — registered in the **constructor**, not after pool init, because windows outlive the pool (restore replays them; `POST /api/iframe-token` mints against pool-less sessions). Revoked under both id spellings, since a create-time token is keyed by the raw id and a restore/reconnect one by the handle. Several live tokens per window is the design (one per connected tab), so a re-mint deliberately does not revoke its predecessor; the 24h TTL stays as the backstop for windows that never see a clean close.
- `requireApp()` — insist the caller is a real app, and hand back the narrowed `AppPrincipal`. The app doors (`/api/verb`, `/api/verb/subscribe`, `requireBundledApp`) need it because `requirePermission` returns `null` for a `host` principal — correctly, the host is the user — so a door that only asks `requirePermission` is open to anyone who simply omits a token. `/api/verb`'s one carve-out is anonymous `describe`, which is metadata-only.
- `requireHost()` — routes no app can hold a permission for (`/api/iframe-token`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, `/api/dev/preview/{appId}`, session restore). The preview route serves an installed app as a *top-level* page with its own iframe token injected (the supported standalone/CDP verification path — see `docs/guides/app-development.md`); it hands out an app's identity, so it carries the same gate as the token mint.
- `requireBundle()` — gated SDK doors (`/api/dev/*` → `yaar-dev`; `/api/browser`, `/api/bridge` → `yaar-web`; `/api/ml-weights*` → `yaar-ml`). The compiler's `bundles` gate only sees an app's *source*; a hand-written `fetch()` never went near it.
- `permissionsAllow()` — the matching rule `requirePermission` applies (canonicalization, `self`, verbs), minus the principal-level gates around it, as a boolean. For a caller that has a permission list and no `Principal`: the **app agent** door (`mcp/app-agent/shared-storage.ts`) takes its appId from its own window, presents no iframe token, and answers on a tool call, so it can neither be resolved by `resolvePrincipal` nor return a 403. It asks this rather than re-deriving the match — a second copy that skipped `canonicalStorageUri` would make a declared `yaar://storage/` a permission for every other app's private storage.
- `storageUriFor()` — maps an HTTP storage path to the URI that names the same file. `/api/storage/apps/{id}/x` **is** `yaar://apps/{id}/storage/x`; only that spelling is what an app holds a permission for. `self` is resolved on both sides of the match (app.json says `apps/self`, a URI from a path says `apps/notes`).
- `resolveSelf()`/`namesSelf()` — **the** expansion of `yaar://apps/self/…`, used by the permission gate, by `POST /api/verb` before dispatch, and by `/api/verb/subscribe` before *storing* the URI (subscriptions are keyed by literal string, so a `self` key never matches the real-id URI a producer notifies with — `subscriptions.ts` now refuses one at `subscribe` and logs one at `notifyChange`/`publishFrame`). `resolveSelf` returns the URI untouched when there is no appId to expand against; testing the result with `namesSelf` is how each door decides whether that is fatal. `storageUriFor`'s expansion is the *path* flavor of the same literal segment and is deliberately separate.
- **The same rewrite runs inside `requirePermission`**, so a URI taken from a request body (`POST /api/verb`) is canonicalized too — `yaar://storage/apps/vault/x` is matched as `yaar://apps/vault/storage/x`. Without it, prefix matching made a declared `yaar://storage/` a permission for every app's private storage; thirteen bundled apps declare it. Applied to grants as well as targets, so either spelling works and they agree. A traversing storage URI names no resource and is refused.
- Tokens for subresources that cannot set a header (`<img src>`, `EventSource`) ride as `?__yaar_token=`. `extractIframeToken()` is the one definition of "presenting a token" and all three layers that ask call it — `resolvePrincipal`, `auth.ts`'s remote-mode credential check, and `server.ts`'s coarse route allowlist, which used to read the header alone and so let a query-param subresource skip it entirely.
- **The copy shape is shared** (`handlers/storage-copy.ts`). `invoke { action: 'copy', from }` reads a URI the caller did not name as its target, so `POST /api/verb` re-checks `read` on `from` (per element — a batched invoke is N calls the registry runs without returning to the door). The storage handlers authorize nothing themselves, so that check is the whole invariant; the field name, its schema, its refusal wording and the gate's extraction live in one module so a rename breaks the build instead of uncovering the check.

**The origin boundary (token-forgery closed):** installed apps are served cross-origin (see the `YAAR_APP_ORIGIN_ISOLATION` entry above and `http/origin-boundary.ts`'s header), and `resolvePrincipal` refuses a token-less request carrying the app origin, so an app cannot omit its token and be resolved as `host`. Being cross-origin blocks `window.parent` reach; top-level navigation is closed by `ISOLATED_APP_SANDBOX` (IframeRenderer.tsx). An isolated app's calls authenticate with their **iframe token** as a credential in its own right — a cross-origin `Referer` is trimmed to a bare origin, so the remote token cannot ride along in it. Edge cases (tailnet app rule failing to register, tunnel fallback to loopback-alias) are in [`docs/guides/remote_mode.md`](../../docs/guides/remote_mode.md) and `lifecycle.startTunnel()`.

**MCP principal:** each agent gets a token minted by `mcp/agent-tokens.ts` and bound to its id server-side; providers send it as `X-Agent-Token`. The shared bearer token (`getMcpToken()`) is transport auth only and says nothing about *which* agent is calling. There is deliberately no `x-agent-id` header — an agent that can name a principal can become it.

## Self-update (`features/update/`)

`yaar://system/update` is how YAAR learns about and installs its own releases; the Configurations
app's **Updates** tab is the one consumer. Four files: `semver.ts` (comparison), `release.ts`
(GitHub `/releases/latest`, asset naming, `SHA256SUMS` parsing), `installer.ts` (download, verify,
swap), `updater.ts` (status + orchestration).

The load-bearing rules — each explained in `updater.ts`'s and `installer.ts`'s headers: `read`
never hits the network (only `invoke {action:'check'}` does, behind a 5-minute cache);
`install` returns once the work has *started*, with refusals thrown synchronously; a missing or
mismatched `SHA256SUMS` is a **hard** failure (unlike install.sh's warn-and-continue); staging is
a sibling of `process.execPath`, never `os.tmpdir()` (the swap is `rename(2)`);
`getUpdateStatus()` reports the *first* blocker. Installing never restarts the server; the
previous binary is left beside the new one as `yaar.previous`.

Adding `system` to `YaarAuthority` (`packages/shared/src/yaar-uri.ts`) is what makes the URI
resolvable — `resolveUri`'s fallback and its bare-authority regex both list it, alongside `skills`
and `mcp`, as an authority with no dedicated parser.
