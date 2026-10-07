# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
bun run test                   # Every suite, each in the process it needs
```

## Tests

`bun run test` is `scripts/run-tests.ts`: one process per partition (`scripts/test/partitions.ts`,
enforced by `scripts/test/partition-guard.ts`). The partition list, the three rules (a test never
depends on the machine it runs on; never `mock.module` under `src/tests/loopback/`; assert against
the narrowest module), and the `ANSWER_EVENT_TYPES` loopback rule: the `yaar-testing` skill.

## Environment Variables

Names and defaults. Rationale for each — read it before changing a default or adding a knob:
[`docs/reference/server_env.md`](../../docs/reference/server_env.md).

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDER` | auto-detect | Force `claude` or `codex` |
| `FABLE` | off | `=1`: monitor agent on Fable, every other agent on Opus |
| `YAAR_MOCK_AGENT` | off | `=1`: every provider is a scripted mock that opens real windows — load/perf runs only |
| `YAAR_REACT_PROD` | on for Android | Dev bundler ships React's production build (`1`/`0` force) |
| `PORT` / `MAX_AGENTS` | `8000` / `10` | Server port; global agent limit |
| `MCP_SKIP_AUTH` / `REMOTE` | off | Skip MCP auth (local dev); enable remote mode |
| `YAAR_REMOTE_TOKEN` | — | Adopt this remote token instead of minting one (ignored under 32 chars) |
| `YAAR_STORAGE` / `YAAR_CONFIG` / `YAAR_SESSION_LOGS` / `YAAR_USER_APPS` | repo dirs | Path overrides; all four pinned to temp dirs in tests |
| `YAAR_WORKSPACE` | — | Pre-fill the four path overrides from `workspaces/<name>/`; new deploys land there too |
| `YAAR_KEEP_EMPTY_SESSIONS` | off | Keep session logs that recorded nothing |
| `YAAR_LOG_LEVEL` / `YAAR_LOG_FORMAT` | `info` / `pretty` | Logging floor; `pretty` or `json` |
| `YAAR_SKIP_DOTENV` | off | Skip loading the root `.env` |
| `YAAR_TEST_REMOTE` | off | Test-runner only — pins `REMOTE=1` for the process |
| `YAAR_APP_ORIGIN_ISOLATION` | **on** | App iframes on a distinct browser origin (`=0` disables) |
| `YAAR_CLIPBOARD_SECRETS` | **on** | Redact credentials out of clipboard text (`=0` disables) |
| `YAAR_CLIPBOARD_GRANT` | **on** | Pre-grant clipboard to the desktop origin over CDP (`=0` disables) |
| `YAAR_TERMUX_API` | on for Android if it answers | Termux:API notifications, clipboard, share sheet (`=0` disables) |
| `YAAR_LAUNCHER_PID` | unset | Shut down once this process is gone — how `make termux` avoids an orphaned server (`launcher-watchdog.ts`) |
| `YAAR_WEBVIEW` / `YAAR_WEBVIEW_DEVTOOLS` / `YAAR_WEBVIEW_LIB` / `YAAR_WEBVIEW_CDP_PORT` | on / off / — / — | Exe: desktop in YAAR's own WebView window (`0` → Chrome `--app`); Inspect menu; library path override; CDP port for the Windows (WebView2) window |
| `YAAR_MAX_DOWNLOAD_MB` | `512` | Ceiling for a `yaar://http` body streamed to disk via `saveTo` (the inline cap stays 10MB) |
| `YAAR_MAX_STORAGE_WRITE_MB` | `1024` | Ceiling for one storage write (`POST /api/storage/{path}`, streamed to disk; appends stay at 50MB) |
| `YAAR_FREEDPI` | on | Route outbound TLS through a local fragmenting proxy, to get past SNI-matching DPI (`0` disables) |
| `MONITOR_MAX_CONCURRENT` / `_ACTIONS_PER_MIN` / `_OUTPUT_PER_MIN` | `4` / `60` / `100000` | Background monitor budget |
| `APP_AGENT_IDLE_MINUTES` | `60` | Idle minutes before an app agent is reclaimed (`0` disables) |
| `CODEX_WS_PORT` / `CODEX_HOME` | `4510` / codex's | App-server port; codex config dir, **read by YAAR before the spawn** |
| `CHROME_PATH` / `CHROME_DEBUG_PORT` | auto / `9222` | Chrome binary; DevTools port for the session-door browser |
| `YAAR_BROWSER_PROVIDER` | — | **Not a selector** — force-headless opt-out only |
| `YAAR_BROWSER_STATE_DIR` / `YAAR_BROWSER_EPHEMERAL` | `storage/.browser` / off | Sandbox profile + session records; `=1` makes the profile scratch again |
| `YAAR_BROWSER_IDLE_MINUTES` | `5` | Idle sweep for browser sessions (`0` disables; a watched session is exempt) |
| `YAAR_ML_COMPUTE` | `auto` | Where `@bundled/yaar-ml` sessions run: `auto` (server's Chrome for a WebKit page on macOS), `chrome` (always), `local` (never) |
| `MARKET_URL` | `https://yaarmarket.vercel.app` | App marketplace endpoint |

## Directory Structure

```
src/
├── main.ts               # Thin orchestrator — binds the socket(s), then startTunnel(), banner, warm pool
├── config.ts             # Barrel over config/ (env, paths, assets, deadlines, limits, browser, providers/claude, providers/codex)
├── lifecycle.ts          # initializeSubsystems(), getBindHostname(), wantsAppOriginSocket(), startTunnel(), printBanner(), shutdown()
├── exe-entry.ts / exe-bundle-entry.ts / exe-assets.ts  # the bundled exe: boot, embedded assets, `--window` routing
├── macos-bundle.ts       # exe as YAAR.app: copies Resources/apps into ~/Library/Application Support/YAAR
├── desktop-window/       # the exe's own window: launch.ts (server side, fallback + shutdown), host.ts (`yaar --window` process), host-bridge.ts (`window.yaarHost`: init script + op handlers), library.ts (find/extract the WebView library)
├── http/                 # HTTP server: createFetchHandler() (CORS, auth, MCP dispatch)
│   ├── access.ts         # THE ACCESS CHOKEPOINT — resolvePrincipal(), requirePermission(), requireHost(), requireBundle()
│   ├── auth.ts           # checkHttpAuth(), generateRemoteToken(), isStaticAsset(), hasValidIframeToken()
│   ├── iframe-tokens.ts  # generateIframeToken(), validateIframeToken()
│   ├── origin-boundary.ts # THE ORIGIN BOUNDARY — which two origins, and which side a request is on
│   ├── local-tls.ts      # Loopback HTTPS + h2 socket: cert (via @yaar/lib/tls), endpoint advertised on /health
│   ├── subscriptions.ts  # subscriptionRegistry — reactive verb URI subscriptions
│   └── routes/           # api.ts (REST), verb.ts (iframe verb proxy), files.ts, browser.ts, proxy.ts, static.ts
├── session/              # LiveSession (aggregate root), SessionHub, BroadcastCenter, ActionEmitter, SessionEventRouter, WindowStateRegistry, types
│   ├── monitor-registry.ts          # MonitorRegistry — authoritative monitor list, id minting, subscription + viewport, removal
│   ├── client-event-controller.ts   # ClientEventController — the total ClientEventRoutes table + frame handlers
│   ├── client-presence.ts           # per-connection visible/hidden/frozen, and the note a timed-out wait appends
│   ├── session-snapshot-service.ts  # SessionSnapshotService — read-only window/surface/agent snapshot building
│   ├── app-window-coordinator.ts    # AppWindowCoordinator — app readiness, command replay, app-channel/bridge-event routing
│   ├── desktop-request.ts           # DesktopRequest — the ask-the-desktop-and-wait prelude every server→client question shares
│   ├── app-ready-registry.ts        # AppReadyRegistry — which iframes are registered *right now*, per (session, window)
│   ├── interrupt-gate.ts            # InterruptGate — agent ids whose stopped turn is still emitting
│   └── agent-directory.ts           # agent id → session id; a leaf, so LiveSession writes it without importing SessionHub
├── websocket/            # WebSocket server + connection registry
├── agents/               # Agent lifecycle, pooling, context management
│   ├── agent-pool.ts     # AgentPool — creation, disposal, and the global slot each agent holds
│   ├── agent-roster.ts   # PooledAgent, the composite keys, listAgents()/buildAgentTree() — pure projections
│   ├── app-agent-registry.ts   # AppAgentRegistry — the whole app-agent tier (reuse, idle reaper), reached via `AgentPool.appAgents`
│   ├── sub-agent-registry.ts   # SubAgentRegistry — the whole sub-agent tier, reached via `AgentPool.subAgents`
│   ├── spawn-reservations.ts   # SpawnReservations — reserve-before-first-await / join / settle-before-sweep
│   ├── context-pool.ts   # ContextPool — unified task orchestration
│   ├── context.ts        # ContextTape — hierarchical message history
│   ├── limiter.ts        # AgentLimiter — global agent semaphore
│   ├── agent-session.ts  # AgentSession — one agent's provider session + turn state
│   ├── agent-context.ts  # AsyncLocalStorage (runWithAgentContext, getAgentId, getSessionId, getMonitorId, getWindowId)
│   ├── roles.ts          # Role prefixes + the parse that maps one onto an access tier
│   ├── monitor-task-processor.ts / app-task-processor.ts / session-task-processor.ts
│   ├── window-event-coordinator.ts  # subscription/notification fan-out + window-close teardown
│   ├── interaction-timeline.ts / pool-types.ts / turn-helpers.ts
│   ├── profiles/         # one dir per profile (orchestrator/, session-agent/, app-agent/), each with a prompts/ subdir of
│   │                     #   markdown parts; shared parts in profiles/prompts/, combined by compose.ts; plus sub-agent,
│   │                     #   developer, turn-options, codex-roles, model-tiers, types, index (pure barrel).
│   │                     #   App-agent prompt/tool sourcing: docs/reference/app_agent_prompt.md
│   ├── session-policies/       # StreamToEventMapper
│   └── context-pool-policies/  # MonitorQueue, ContextAssembly, ReloadCache, MonitorBudget, WindowSubscription
├── providers/            # Pluggable AI backends
│   ├── types.ts          # AITransport interface, StreamMessage, TransportOptions
│   ├── factory.ts        # Auto-detect provider, warm pool init
│   ├── cli-probe.ts      # CLI availability/version probes (cached), shared by factory and providers
│   ├── warm-pool.ts      # WarmPool singleton
│   ├── notice.ts         # ProviderNotice + toNoticeMessage — the recoverable-failure channel
│   ├── mock/             # MockTransport (YAAR_MOCK_AGENT=1) — scripted turns for make mobile-bench
│   ├── claude/           # ClaudeSessionProvider, message-mapper, errors.ts
│   └── codex/            # CodexProvider, AppServer, JsonRpcWsClient, auth, errors.ts, version.ts, types
├── handlers/             # PRIMARY: URI registry + 5 generic verb tool handlers
│   ├── index.ts          # registerVerbTools() — the 5 MCP tool definitions; brace expansion
│   ├── uri-registry.ts   # ResourceRegistry — central handler registry, access tiers, batch execution
│   ├── uri-resolve.ts    # Server-side URI resolution
│   ├── define-actions.ts # defineActions() — one table per action-bearing handler; enum, docs and dispatch all come off it
│   ├── storage-copy.ts   # The shared source-reading shape (copy/extract/compress) — field name, schema, refusal wording, gate extraction, in one module
│   ├── storage-archive.ts # extract/compress as verb results for both storage doors (storage/archive-ops.ts does the work)
│   ├── storage-describe.ts # describeStoragePath() — describe for a path on disk, shared by both storage doors
│   ├── apps/             # register.ts, app-resource.ts, protocol-resource.ts, agents-resource.ts, storage-resource.ts, db-resource.ts, paths.ts
│   ├── agents.ts / storage.ts / storage-bytes.ts / config.ts / history.ts / http.ts / mcp-gateway.ts
│   └── fonts.ts / session.ts / skills.ts / system.ts / user.ts / window.ts
├── mcp/                  # MCP server + tool folders (see Tools section)
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS; the one protocol era
│   ├── result-size.ts    # The MCP result-size cliff and the per-tool annotation that moves it
│   ├── result-spill.ts   # Verb results past 100K chars go to yaar://storage/temp/tool-results/, paged back with read `chars`
│   ├── agent-tokens.ts   # Per-agent token minting, bound to agent id server-side
│   ├── system/           # Always-active: reload_cached
│   ├── app-agent/        # describe / query / command / relay (+ direct_message)
│   ├── messaging/        # Cross-agent direct messaging
│   ├── sub-agent/        # A sub-agent's one channel — per-caller tool list
│   └── index.ts          # Re-exports for server, system tools, verb tools
├── features/             # Domain business logic (imported by handlers/)
│   ├── agents/           # Agent-facing feature logic
│   ├── android/          # Termux:API — native notifications while the desktop is out of sight, phone clipboard, share sheet;
│   │                     #   child-process-limit.ts — reads Android's phantom-process toggle, caps monitors while it is on (yaar://system/android)
│   ├── apps/             # App listing, agent docs loading, manifest.ts (the one app.json read + normalise), changed.ts (notifyAppChanged — every on-disk app change), docs.ts (agent/docs/ topic tier), describe.ts, capabilities.ts (grant ceiling), marketplace, badge
│   ├── browser/          # CDP browser automation actions
│   ├── companion/        # companion-tab.ts — the server-side second desktop (YAAR_COMPANION_TAB)
│   ├── config/           # Hooks, settings, shortcuts, mounts, app config, domains
│   ├── dev/              # Compile, typecheck, deploy, clone, git.ts (per-app version history)
│   ├── fonts/            # The served-face catalog + subsetForText() behind yaar://system/fonts
│   ├── http/             # fetch.ts — proxied HTTP fetch; binary-body.ts — what a *model* gets
│   │                     #   when the response is bytes (an app still gets the base64 envelope)
│   ├── live-encoder/     # Live-mode video: encoder.ts opens one background Chrome tab running
│   │                     #   encoder-page.client.js (WebCodecs) and turns each viewer's screencast JPEGs into AV1/H.264/VP9
│   ├── market/ session/ skills/ user/   # Marketplace, session ops, skills, clipboard + secret-scan
│   ├── ml-host/          # Remote ML compute: relay.ts pairs an app's yaar-ml socket with one headless Chrome tab
│   │                     #   running host-page.client.js (browser JS, served inline) — YAAR_ML_COMPUTE
│   ├── pdf.ts            # @yaar/lib/pdf bound to this install's poppler — the PDF import site
│   ├── remote-control.ts # Claude Remote Control for one monitor agent (reached via /api/remote-control, no yaar:// verb)
│   ├── update/           # Self-update: semver.ts, release.ts, installer.ts, updater.ts
│   ├── ytdlp/            # jobs.ts — async yt-dlp download jobs behind yaar://system/ytdlp
│   └── window/           # Window create/update/manage, app protocol, app query/command, delegated-grants, subscribe
├── db/                   # Per-app SQLite (appDb): AppDatabase wrapper, LRU pool, Mongo-style filter → SQL query builder
├── reload/               # Fingerprint-based action cache
├── observability/        # log.ts — structured logging; the ONLY sanctioned console.* in the server
├── logging/              # Session logging (JSONL), reading, context/window restore, empty-log prune
├── storage/              # StorageManager, permissions, shortcuts, settings, mounts, app-grants.ts,
│                         #   archive-entries.ts (paths *into* a .zip/.tar/.tgz — read and list treat an archive as a read-only folder),
│                         #   archive-ops.ts (extract / compress)
└── lib/                  # Utilities that need server internals (the generic half is @yaar/lib, see below)
    ├── browser/              # CDP browser automation — Chrome discovery, sessions, pool, downloads
    ├── verb-result.ts        # VerbResult + content blocks + the pure builders (ok, okJson, error, okLinks, prependNote, …)
    ├── read-options.ts       # ReadOptions, hasLineFilter, applyReadOptions (lines/pattern/chars), applyEdit
    ├── state-path.ts         # Walk/split/search a window-state value by path segments (used by read-options + app-protocol)
    ├── schema-refs.ts        # resolveRef/selfContained — following a protocol schema's `$defs` pointers
    ├── command-signature.ts  # Rendered call signatures for protocol commands
    ├── protocol-index.ts     # First-sentence summarization for command indexes
    ├── format-interaction.ts / format-verb-log.ts
    └── yaar-uri-server.ts    # Server-only URI parsers (content path, window resource, config, session)
```

Generic utilities (anything describable without the word "YAAR") live in `@yaar/lib`
(`packages/lib/CLAUDE.md`), imported by subpath (`@yaar/lib/ssrf`, `@yaar/lib/fonts`, …). Two take
as a parameter what the server knows:

| Module | Server side |
| --- | --- |
| `@yaar/lib/pdf` (`binDir`) | `features/pdf.ts` binds `getPopplerBinDir()` once — **import PDF from there**, not from `@yaar/lib/pdf` |
| `@yaar/lib/tunnel` (`loadTunnelConfig(configDir)`) | `lifecycle.ts` passes `getConfigDir()` |

`lib/browser/` stays in the server because it reads `config.js` (debug port, profile dir, idle sweep).

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
        └── Policies (MonitorQueue per monitor, ContextAssembly, ...)
```

`LiveSession` is the aggregate root. It owns four collaborators, each reached only through it and given narrow callbacks rather than the session itself:

- `MonitorRegistry` — the authoritative monitor list, id minting (lowest free non-negative integer), `MAX_MONITORS` enforcement (lowered to 2 on Android while child-process restrictions are on — the cap rides every `MONITORS` event as `maxMonitors`), per-connection monitor subscription + viewport, and monitor removal (unsubscribes watchers, then removes the monitor agent).
- `ClientEventController` — owns the total `ClientEventRoutes` table and every frame handler. `LiveSession.routeMessage()` is the public entry: it lazily initializes the pool and settles message-id acceptance, then delegates to `ClientEventRouter`.
- `SessionSnapshotService` — window→`window.create` conversion, iframe-token refresh, surface snapshot, busy-agent snapshot. Strictly read-only over injected registries.
- `AppWindowCoordinator` — per-(session, window) app readiness, command replay on iframe remount, app-channel/`APP_EVENT` routing, bridge-event fan-out to Real Browser windows, and app-protocol request delivery to the frontend.

`LiveSession` owns the registries, `broadcast()` is the only server→frontend gateway, and it decides its own cleanup order.

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

**All server→frontend events must flow through `LiveSession.broadcast()`** (which handles monitor-scoped routing), never directly through `BroadcastCenter.publishToSession()` — that bypasses routing and silently fails during active agent streaming.

Non-agent contexts (HTTP routes, proxy) with no `LiveSession` reference use `actionEmitter`. `session/session-event-router.ts` holds exactly ONE process-wide subscription per channel (no per-session `actionEmitter.on(...)` listeners):

1. `actionEmitter.emit('my-event', { sessionId, event })` from the source
2. `SessionEventRouter`'s one subscription for that channel looks up the `sessionId` and calls the matching `SessionEventSink`
3. `LiveSession` registers a `SessionEventSink` in its constructor (`sessionEventRouter.attach()`) and detaches it in `cleanup()` (`sessionEventRouter.detach()` checks sink identity — a session id is reused across reconnects, so a late `cleanup()` on a stale `LiveSession` must not unsubscribe its replacement)

`bridge-event` is the one deliberately-global channel — no `sessionId`, fanned out to every attached sink. Reference implementations: `'app-protocol'`, `'action'`, and the forwarded channels (`'approval-request'`, `'verb-subscription'`, etc.) in `session-event-router.ts`.

### Event Type Constants

Use `ServerEventType` and `ClientEventType` const objects from `@yaar/shared` for all event type discriminants — never raw string literals.

### Key Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| Semaphore | `AgentLimiter` | Global agent limit — non-blocking `tryAcquire()`/`release()`; a spawn over the limit is refused, never queued |
| Pool | `ContextPool` | Unified agent reuse with dynamic roles |
| Warm Pool | `providers/warm-pool.ts` | Pre-initialize providers at startup |
| Context Tape | `ContextTape` | Track messages by source for injection |
| Factory | `providers/factory.ts` | Auto-detect and create providers |
| Observer | `actionEmitter` | Decouple tools from sessions |
| AsyncLocalStorage | `agents/agent-context.ts` | Track agentId in async context |
| Injected resolver | `setLogContextResolver`, `setAccessPrincipalResolver`, `setWindowGrantResolver` | Give a low-level module a fact that lives above it in the import graph, wired once in `lifecycle.ts` |

### Logging

**Operational logging goes through `observability/log.ts`; `no-console` is an ESLint error
everywhere else in `src/`.** A component takes a logger once and names events, not sentences:

```ts
const log = createLogger('AgentSession');
log.warn('turn overlapped', { role, waitedFor: previousRole });
```

Session/monitor/agent/window/app ids are attached automatically by an `AsyncLocalStorage`
resolver (`setLogContextResolver`, wired in `lifecycle.ts`) — a bare `console.log` carries none of
them. For work *outside* an agent turn (`LiveSession`'s connection and pool events), bind the id:
`createLogger('LiveSession').child({ sessionId })`.

Three rules:

- **Fields, not interpolation.** `log.info('created monitor agent', { monitorId })`, never
  `` log.info(`created monitor agent for ${monitorId}`) `` — fields are what `YAAR_LOG_FORMAT=json` can query.
- **Ids and counts, never content.** The one deliberate excerpt is the tool-error `detail` in
  `StreamToEventMapper`, commented as such at the call site.
- **The component name comes from `createLogger`, not the string.**

Each level maps to its own console method (`warn` → `console.warn`; test helpers spy on it).
`no-console` exemptions are listed with reasons in `eslint.config.js`.

## Providers

The `server-providers` skill (loads when editing `providers/`) covers the `AITransport` contract,
warm pool, per-provider config, Codex packaging, and the **notice-vs-error rule**: a recoverable
failure becomes `StreamMessage.type === 'notice'`, never `error` (`error` is terminal and latches
the turn closed).

**Codex version policy:** an under-versioned CLI is **refused rather than driven** (codegen,
auto-detect, `initialize` handshake; a forced `PROVIDER=codex` refuses the boot) — the
`codex-provider` skill.

## Tools (MCP)

Namespaces (`CORE_SERVERS` in `mcp/server.ts`): `system`, `verbs`, `app`, `messaging`, `subagent`.
`verbs` exposes 5 generic tools (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch via
`yaar://` URIs to thin handlers in `handlers/`, which import domain logic from `features/`.

The per-namespace table, the stateless-only protocol era (`getModernHandler` in `mcp/server.ts` —
read its two documented traps first), verb semantics, batching, **access tiers**
(`access: 'session-principal'`), the app protocol, app-agent storage, monitor ↔ app messaging,
sub-agents, and self-update: the `server-verbs` skill (loads when editing `handlers/`, `mcp/`,
`features/`).

## REST API

**A route never invents its own permission check**: it resolves the caller to a `Principal`
(`resolvePrincipal`) and names the `yaar://` URI + verb it performs (`requirePermission`) — the
same check `POST /api/verb` runs. Route list, gate table, token invariants, MCP principal model:
the `server-http` skill. `http/access.ts`'s header is the authority on what a principal is.

