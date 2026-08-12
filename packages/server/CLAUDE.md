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
documented knobs and points config/storage/session-logs at temp dirs. Full rationale, including
the CI incidents that forced each rule, is in `scripts/test/partitions.ts` and
`scripts/test/env.ts`.

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
  behavior should import the concrete module (`profiles/model-tiers.js`), not the barrel.

Server→client waits (`ANSWER_EVENT_TYPES` in `@yaar/shared`) each get a loopback row: a wait the
client can only answer over a socket the server is holding is a deadlock waiting to happen.

## Environment Variables

Names and defaults below. **The reasoning behind each — why a default is what it is, what breaks
if you flip it — is [`docs/reference/server_env.md`](../../docs/reference/server_env.md).** Read it
before changing a default or adding a knob.

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDER` | auto-detect | Force `claude` or `codex` |
| `PORT` / `MAX_AGENTS` | `8000` / `10` | Server port; global agent limit |
| `MCP_SKIP_AUTH` / `REMOTE` | off | Skip MCP auth (local dev); enable remote mode |
| `YAAR_REMOTE_TOKEN` | — | Adopt this remote token instead of minting one (ignored under 32 chars) |
| `YAAR_STORAGE` / `YAAR_CONFIG` / `YAAR_SESSION_LOGS` | repo dirs | Path overrides; all three pinned to temp dirs in tests |
| `YAAR_KEEP_EMPTY_SESSIONS` | off | Keep session logs that recorded nothing |
| `YAAR_LOG_LEVEL` / `YAAR_LOG_FORMAT` | `info` / `pretty` | Logging floor; `pretty` or `json` |
| `YAAR_SKIP_DOTENV` | off | Skip loading the root `.env` |
| `YAAR_TEST_REMOTE` | off | Test-runner only — pins `REMOTE=1` for the process |
| `YAAR_APP_ORIGIN_ISOLATION` | **on** | App iframes on a distinct browser origin (`=0` disables) |
| `YAAR_CLIPBOARD_SECRETS` | **on** | Redact credentials out of clipboard text (`=0` disables) |
| `YAAR_CLIPBOARD_GRANT` | **on** | Pre-grant clipboard to the desktop origin over CDP (`=0` disables) |
| `MONITOR_MAX_CONCURRENT` / `_ACTIONS_PER_MIN` / `_OUTPUT_PER_MIN` | `2` / `30` / `50000` | Background monitor budget |
| `APP_AGENT_IDLE_MINUTES` | `15` | Idle minutes before an app agent is reclaimed (`0` disables) |
| `CODEX_WS_PORT` / `CODEX_HOME` | `4510` / codex's | App-server port; codex config dir, **read by YAAR before the spawn** |
| `CHROME_PATH` / `CHROME_DEBUG_PORT` | auto / `9222` | Chrome binary; DevTools port for the session-door browser |
| `YAAR_BROWSER_PROVIDER` | — | **Not a selector** — force-headless opt-out only |
| `MARKET_URL` | — | App marketplace endpoint |

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
│   ├── roles.ts          # Role prefixes + the parse that maps one onto an access tier
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
│   ├── notice.ts         # ProviderNotice + toNoticeMessage — the recoverable-failure channel
│   ├── claude/           # ClaudeSessionProvider, message-mapper, errors.ts
│   └── codex/            # CodexProvider, AppServer, JsonRpcWsClient, auth, errors.ts, version.ts, types
├── handlers/             # PRIMARY: URI registry + 5 generic verb tool handlers
│   ├── index.ts          # registerVerbTools() — the 5 MCP tool definitions; brace expansion
│   ├── uri-registry.ts   # ResourceRegistry — central handler registry, access tiers, batch execution
│   ├── uri-resolve.ts    # Server-side URI resolution
│   ├── define-actions.ts # defineActions() — one table per action-bearing handler; enum, docs and dispatch all come off it
│   ├── storage-copy.ts   # The shared `copy` shape — field name, schema, refusal wording, gate extraction, in one module
│   ├── storage-describe.ts # describeStoragePath() — describe for a path on disk, shared by both storage doors
│   ├── apps/             # register.ts, app-resource.ts, protocol-resource.ts, agents-resource.ts, storage-resource.ts, db-resource.ts, paths.ts
│   ├── agents.ts / apps.ts (barrel) / storage.ts / storage-bytes.ts / config.ts / history.ts / http.ts / mcp-gateway.ts
│   └── fonts.ts / session.ts / skills.ts / system.ts / user.ts / window.ts
├── mcp/                  # MCP server + tool folders (see Tools section)
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS; the two protocol eras
│   ├── result-size.ts    # The MCP result-size cliff and the per-tool annotation that moves it
│   ├── agent-tokens.ts   # Per-agent token minting, bound to agent id server-side
│   ├── system/           # Always-active: reload_cached, list_reload_options
│   ├── app-agent/        # describe / query / command / relay (+ direct_message)
│   ├── messaging/        # Cross-agent direct messaging
│   ├── sub-agent/        # A sub-agent's one channel — per-caller tool list
│   └── index.ts          # Re-exports for server, system tools, verb tools
├── features/             # Domain business logic (imported by handlers/)
│   ├── agents/           # Agent-facing feature logic
│   ├── apps/             # App listing, agent docs loading, describe.ts, capabilities.ts (grant ceiling), marketplace, badge
│   ├── browser/          # CDP browser automation actions
│   ├── config/           # Hooks, settings, shortcuts, mounts, app config, domains
│   ├── dev/              # Compile, typecheck, deploy, clone, git.ts (per-app version history)
│   ├── fonts/            # The served-face catalog + subsetForText() behind yaar://system/fonts
│   ├── http/             # fetch.ts — proxied HTTP fetch
│   ├── market/ session/ skills/ user/   # Marketplace, session ops, skills, clipboard + secret-scan
│   ├── update/           # Self-update: semver.ts, release.ts, installer.ts, updater.ts
│   └── window/           # Window create/update/manage, app protocol, app query/command, delegated-grants, subscribe
├── db/                   # Per-app SQLite (appDb): AppDatabase wrapper, LRU pool, Mongo-style filter → SQL query builder
├── reload/               # Fingerprint-based action cache
├── observability/        # log.ts — structured logging; the ONLY sanctioned console.* in the server
├── logging/              # Session logging (JSONL), reading, context/window restore, empty-log prune
├── storage/              # StorageManager, permissions, shortcuts, settings, mounts, app-grants.ts
└── lib/                  # Standalone utilities (no server internal imports)
    ├── browser/ pdf/ tunnel/ download/
    ├── fonts/                 # OpenType reader + CFF and glyf subsetters — bytes in, bytes out
    │                          #   (the catalog and loading are features/fonts/)
    ├── ssrf.ts               # URL validation, safe fetch with redirect following
    ├── image.ts              # data-URL parsing + toWebPForModel()
    ├── schema-refs.ts        # resolveRef/selfContained — following a protocol schema's `$defs` pointers
    ├── command-signature.ts  # Rendered call signatures for protocol commands
    ├── protocol-index.ts     # First-sentence summarization for command indexes
    ├── format-interaction.ts / format-verb-log.ts / ids.ts / errors.ts / open-url.ts / pick-directory.ts
    └── yaar-uri-server.ts    # Server-only URI parsers (content path, window resource, config, session)
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
whole point, and why a bare `console.log` is refused: it carries none of them. For a class whose
work happens *outside* an agent turn (`LiveSession`'s connection and pool events), bind the id
instead: `createLogger('LiveSession').child({ sessionId })`.

Three rules:

- **Fields, not interpolation.** `log.info('created monitor agent', { monitorId })`, never
  `` log.info(`created monitor agent for ${monitorId}`) `` — the field is what `YAAR_LOG_FORMAT=json`
  emits as a queryable key, and the interpolated string is what it cannot.
- **Ids and counts, never content.** A transcript must not be reachable through a debug switch.
  The one deliberate excerpt is the tool-error `detail` in `StreamToEventMapper`, kept because "a
  tool failed" without its text is unactionable, and commented as such at the call site.
- **The component name comes from `createLogger`, not the string.**

Each level maps to its own console method, so `warn` reaches `console.warn` — several test helpers
spy on exactly that. The exemptions to `no-console` are listed with their reasons in
`eslint.config.js`.

## Providers

**AITransport interface:** `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`, `interrupt()`, `dispose()`.

**Warm Pool:** Providers pre-initialized at startup. `initWarmPool()` at boot, `acquireWarmProvider()` gets a ready instance, pool auto-replenishes in background.

**Claude:** `claude-sonnet-4-6`, thinking enabled (4096 max tokens), WebSearch and Task tools, `bypassPermissions`. Each provider keeps a **persistent streaming session**: one long-lived CLI process whose MCP connections survive across turns; turns push messages into the stream and read until the SDK result. A prompt/tools/model change reopens the stream with `resume`. Monitor agents are prewarmed at WebSocket connect (`ContextPool.prewarmMonitorAgent` → `AgentSession.prewarm` → `provider.prewarm`) so the first user message starts on a live process with MCP already connected — the first turn is also gated on MCP connection (bounded 5s) because the CLI no longer waits for HTTP MCP servers in stream-json mode.

**Codex:** `codex app-server` child process with per-provider WebSocket connections (`--listen ws://`). Settings: `approval_policy=on-request`, `model_reasoning_effort=medium`, `sandbox_mode=danger-full-access`.

### The `notice` contract (`providers/notice.ts`)

Both SDKs report trouble on far more channels than they report *fatal* trouble on. **A
recoverable failure becomes `StreamMessage.type === 'notice'`, never `error`.**

`error` is terminal by contract — `StreamToEventMapper.map` calls `fail()`, which latches the turn
closed, and both providers' read loops stop on it — so reporting a retryable failure that way ends
the turn in the UI while the provider carries on working. Notices reach the client as
`ServerEventType.AGENT_NOTICE` (a CLI-panel line, never `connectionError` and never a failed
message) and as a `notice` frame on `yaar://agents/{id}/stream`.

`ProviderNotice` + `toNoticeMessage` live in `providers/notice.ts`; each provider's vocabulary
lives beside its mapper in `claude/errors.ts` and `codex/errors.ts`. **Which channel maps to
which, per provider, is
[`docs/reference/claude_codex.md`](../../docs/reference/claude_codex.md#error-recovery)** —
including the one case where the mapper and the read loop must agree (Codex `willRetry`). Covered
by `tests/claude-error-notices.test.ts` and `tests/codex-error-notices.test.ts`.

### Codex version policy (`providers/codex/version.ts`)

The bindings in `providers/codex/generated/` are hand-generated by `make codex-types`, so an
under-versioned CLI is **refused rather than driven** — at codegen (fails closed), at auto-detect
in `factory.ts` (skipped, Claude picked), and at the `initialize` handshake
(`assertSupportedCodex`, the only gate that catches a stale process on `CODEX_WS_PORT`). A
**forced** `PROVIDER=codex` turns the refusal into a refused boot rather than a silent fallback.
Gate-by-gate rationale in `version.ts`; covered by `tests/codex-version.test.ts` and
`tests/warm-pool-codex-version.test.ts`.

`@openai/codex` is declared as an **optional peer dependency** so a Codex user can pin the CLI to
the lockfile (`bun add @openai/codex`) instead of driving whatever PATH resolves first, while a
plain `bun install` downloads none of it. `getCodexSpawnArgs()` (`config/providers/codex.ts`)
resolves the **vendored binary** directly and never the package's `bin/codex.js` — the reasons,
and why pinning retires no gate, are in that function's comments. The declared range is pinned to
`CODEX_MIN_VERSION` by test, since stated in two files it would drift into admitting a CLI the
gates refuse.

## Tools (MCP)

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`,
`messaging`, and `subagent`. The `verbs` server exposes 5 generic tools (`describe`, `read`,
`list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import
domain logic from `features/`) via `yaar://` URIs.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs dispatching via `yaar://` URIs |
| `mcp/system/` | system | reload_cached, list_reload_options |
| `mcp/app-agent/` | app | describe, query, command, relay (+ direct_message when granted) |
| `mcp/messaging/` | messaging | Cross-agent direct messaging |
| `mcp/sub-agent/` | subagent | app-defined tools of the *calling* sub-agent — the only namespace whose tool list depends on who connects; empty for everyone else |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for
rendering feedback. Window tools support lock protection — only the locking agent can modify a
locked window.

### Two protocol eras, one endpoint

`handleMcpRequest` forks per request: 2025-era traffic keeps the **stateful** path (`initialize`
mints an `mcp-session-id`), a **2026-07-28** client is stateless and routed to `createMcpHandler`.
YAAR asks **both** providers to negotiate up — Codex via `features.mcp_2026_07_28=true`, Claude via
`MCP_SDK_GENERATION=v2` + `MCP_PROTOCOL_NEGOTIATION=auto` (both vars required; either alone is a
no-op).

**Two traps that will cost you a day each are documented at `getModernHandler` in
`mcp/server.ts` — read it before touching this fork.** Both rows are pinned by
`tests/mcp-protocol-eras.test.ts`.

**The legacy leg is deprecated and instrumented.** Its machinery is fenced between
`BEGIN/END deprecated: 2025-era stateful leg` banners in `mcp/server.ts` and every declaration
inside carries `@deprecated` — the fence is where the eventual cut goes, so **don't add to it or
reach into it from the modern path**. `getMcpEraStats()` reports the counters that gate the
deletion; criteria in `docs/proposals/mcp_modern_only_proposal.md`.

### Verb semantics

**`describe` is the manual, `read` is the current value, `list` is what's addressable.** A handler
that blurs the three makes a prompt offer rather than instruct.

| | `yaar://apps/{id}` — the *installed* app | `yaar://windows/{id}` — the *running* instance |
|---|---|---|
| `describe` | identity + `agent/SKILL.md` + permissions + the **names** of its state keys and commands + this door's `verbs`/`invokeActions`/`subPaths` | this instance's manual, tagged `source: 'live'` (the iframe's registration) or `'manifest'` (disk), plus `builtinState` |
| `read` | the effective, **post-grant** manifest from `getAppMeta` | metadata + `__content`, or metadata + `__screenshot` for an iframe |
| `list` | ✗ not a collection | this window's built-in keys, then the app's state keys and commands, as an **index** (signature + first sentence) |
| sub-paths | `protocol`, `storage/`, `db/`, `agents/` | `state/{key}`, `commands/{key}` |

Six rules hold this together, each closing a false success. **Each is documented in full at the
named site**:

- **`exists?(resolved)` on `ResourceHandler`** is consulted before the auto-generated `describe`; a `/*` wildcard that declares neither `exists` nor `describe` makes `register()` **throw**. (`handlers/uri-registry.ts`)
- **The same action list is declared once** — `defineActions` derives the schema `enum`, `describe`'s `invokeActions`, and the dispatch from one table. (`handlers/define-actions.ts`)
- **`yaar://apps/{id}/state/…` and `/commands/…` are refused on every verb** — protocol state belongs to a running window, and the same app on two monitors is two states. (`handlers/apps/register.ts`)
- **Every other unclaimed sub-path is refused too** — a false success is worse than a 404. (`rejectUnhandledSubPath`, same file)
- **A missing directory is an error, not an empty list** (`storageList` sets `notFound`); namespace roots opt back in explicitly.
- **A resource that exists and holds nothing answers, it does not complain** — every window has the three built-in state keys (`BUILTIN_STATE`: `__content`, `__screenshot`, `__console`; `__` is reserved). (`handlers/window.ts`)

### Batching

**A call batches on two axes, and neither is a handler's business.** Brace expansion
(`handlers/index.ts`) batches *URIs* against one payload, concurrently. An **array payload** to
`invoke` batches *payloads* against one URI, run **sequentially** by `ResourceRegistry.execute`,
stopping at the first failure and naming the index to resend from. Each element is resolved,
access-checked and verb-checked exactly as a lone invoke would be — **a batch is a spelling, never
a bypass.** `handler.invoke` never sees the array (`MAX_BATCH_PAYLOADS = 100`, refused rather than
truncated; rationale at that declaration in `uri-registry.ts`).

Only one of the two axes exists at each door: brace expansion is the MCP `exec` wrapper's, so
`POST /api/verb` refuses a brace URI by name. The array-payload axis works at both.

### Access tiers

Every agent carries a principal `role` (`session` / `monitor` / `app`) on its `AgentContext`. A
handler may declare `access: 'session-principal'`, and `ResourceRegistry.execute()` then applies
**one** definition:

> A caller satisfies `access: 'session-principal'` iff its role is `session` **or** it is a
> token-backed bundled system app (`AgentContext.systemApp`).

Everything else is refused — default-deny, so `undefined` is neither. **That gate is the
authority**: both doors into the verb layer end there (MCP tools and `POST /api/verb`), which is
why it, not `http/access.ts`, defines the tier. `access.ts`'s `isSessionUri` refusal stays as the
cheap early 403 and applies the same widening — the two used to answer in different currencies,
so a bundled system app was admitted by one door and 403'd by the other.

`agents/roles.ts` owns both the prefixes a role is minted with and the parse that maps one onto a
tier, so the string and the gate that reads it cannot drift. `systemApp` is set by
`routes/verb.ts` from the **validated iframe token**, never from the request body. The gate's
principal resolver is injected via `setAccessPrincipalResolver()` (wired in `lifecycle.ts`) to
avoid a runtime import cycle.

### App Protocol

Bidirectional agent-iframe communication via `query`/`command` tools (in the `app` MCP server).
Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. Event schemas are in
[`docs/reference/app_protocol_reference.md`](../../docs/reference/app_protocol_reference.md).

A fourth request kind, `describe`, documents **one** state key or command on demand
(`handleAppDescribe` in `features/window/app-protocol.ts`) — never folded into the manifest, or
every manifest read would pay for every key.

**A protocol has two honest sizes, and they get two doors.** `describe('yaar://apps/{id}')` answers
"what is this app"; the protocol is its own resource (`handlers/apps/protocol-resource.ts`) where
`describe` is counts and doors, `list` is the index, `read` is the manifest, and
`read('…/protocol/commands/{name}')` is one command self-contained and brace-batchable. So the
index is *what `list` means*, not a degradation a byte budget switches on, and nothing is truncated
behind a caller's back. The incident that forced the split is recorded in
`handlers/apps/protocol-resource.ts`'s header; the CLI result-size cliff behind it is named and
moved in `mcp/result-size.ts`.

**A schema may point at the manifest, so every reader has to follow the pointer.** The compiler
hoists a repeated shape into `manifest.$defs` and leaves `{"$ref": "#/$defs/x"}` at each use.
`lib/schema-refs.ts` is the one resolver: `resolveRef` for the renderers (a ref rendered without
the table is `any`) and `selfContained` for any door that hands one descriptor's schema on
**alone**. The three seams that pass `$defs`: `list` on a window (`handlers/window.ts`), the
per-command `describe` (`features/window/app-protocol.ts`), and the app agent's prompt
(`agents/profiles/app-agent.ts`). A descriptor's *top-level* schema is never hoisted, so
`params.properties`/`required` are always readable without a hop.

**A reserved payload key (`action`/`params`/`timeoutMs`) is checked against the command's schema,
not against its name.** Full story at `invokeSubResource` in `handlers/window.ts`.

### Monitor ↔ App Agent communication

- **Monitor → App**: `invoke('yaar://windows/{id}', { action: 'message', message: '...' })` — wraps message in `<monitor:{monitorId}>` tags and routes as an app task via `AppTaskProcessor`. Fire-and-forget; use `hook: 'response'` to get the app agent's reply back.
- **Monitor → App, starting over**: the same call with `fresh: true` retires the app agent first (its memory lives in its provider session, which `disposeAppAgent` ends). A `fresh` task never steers, releases inside the processing lock, and drops handoff fingerprints; sub-agents deliberately survive. Rationale in `AppTaskProcessor` and `AgentPool`.
- **App → Monitor**: App agent's `relay` tool enqueues a `type: 'monitor'` task. App agent responses are also pushed to `InteractionTimeline` and drained by the monitor on its next turn.

### Sub-agents (`yaar://apps/self/agents`)

An app that declares `"subagents": { "max": N }` in its app.json may spawn up to N AI instances,
each with a runtime-supplied system prompt and its own provider session/memory. The verb surface is
`handlers/apps/agents-resource.ts` (`list` / `invoke {spawn|message|interrupt}` / `read` /
`delete`), callable only from the app's own iframe. `message` returns as soon as the turn is
queued; answers arrive on `yaar://agents/{instanceId}/stream` (needs `"streams": ["agents"]`).

The containment rules, each documented in full at the named site:

- **No YAAR verbs, no permissions, no principal.** A spawn with no `tools` gets `allowedTools: []` — that empty array is the whole containment story, since `undefined` would mean *every* tool. Sub-agents bypass `ContextPool` entirely.
- **The only capability is a reach back into the owning app's own iframe** (`agents/profiles/sub-agent.ts`): each declared tool becomes one `persona:{name}` app-protocol command, `personaId` stamped last. Grants to the app *agent* (`controls`, `direct_message`) do not descend.
- **`subagents`/`streams` are granted by the user at install time** and applied as a ceiling by intersection with the recorded grant — `features/apps/capabilities.ts` / `storage/app-grants.ts`. `controls` stays bundled-only.
- **One manifest key**: the `"personas"` alias is retired and refused by name; the **wire** still says `personaId` — `agents-resource.ts` is the one place the two spellings meet.

`subAgentKey(monitorId, appId, subId)` extends the app agent's key, which extends the monitor's —
session → monitor → app → sub-agent is one tree, addressed through the owner and torn down with it.
See [`docs/architecture/agent_tree.md`](../../docs/architecture/agent_tree.md) for the four laws
every new node must satisfy and the triage rule for placing one.

## REST API

Routes in `http/routes/`: `GET /health`, `GET /api/version`, `/api/providers`, `/api/apps`,
`/api/sessions`, `/api/shortcuts`, `/api/settings`, `/api/domains`, `/api/agents/stats`,
`/api/storage/*`, `/api/pdf/*`, `/api/browser/*`, `/api/fetch`, `/api/pick-directory`,
`/api/remote-info`, `POST /api/iframe-token`, `POST /api/verb`, `POST /api/verb/subscribe`. See
`routes/api.ts`, `routes/verb.ts`, and `routes/files.ts` for full signatures.

### The access chokepoint (`http/access.ts`)

**A route never invents its own permission check.** It resolves the caller to a `Principal` and
names the `yaar://` URI + verb it is about to perform:

```ts
const principal = resolvePrincipal(req, url);        // host | app  (or a 403 Response)
if (principal instanceof Response) return principal;
const denied = requirePermission(principal, 'yaar://config/domains', 'invoke');
if (denied) return denied;
```

This is the same check `POST /api/verb` runs, shared rather than duplicated — the REST routes used
to reach storage, config, and session logs with no check at all.

- **`host`** — the desktop (no iframe token). Unconfined; in `REMOTE=1` it has already proven the remote token in `auth.ts`.
- **`app`** — an iframe token. Confined to its app.json `permissions`, plus auto-granted self-storage, the commons, and whatever a caller granted to its window at runtime.

**`access.ts`'s header is the authority on what a principal is and how the origin boundary
attributes a request** — read it before adding a gate. The gates it exports:

| Function | Use |
|---|---|
| `requirePermission()` | The main check — canonicalization, `self`, verbs |
| `requireApp()` | Insist the caller is a real app. Needed because `requirePermission` returns `null` for `host`, so a door that only asks it is open to anyone who omits a token |
| `requireHost()` | Routes no app can hold a permission for (`/api/iframe-token`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, `/api/dev/preview/{appId}`, session restore) |
| `requireBundle()` | Gated SDK doors (`/api/dev/*` → `yaar-dev`; `/api/browser`, `/api/bridge` → `yaar-web`; `/api/ml-weights*` → `yaar-ml`) |
| `permissionsAllow()` | The matching rule as a boolean, for a caller with a permission list and no `Principal` (the app-agent storage door) |
| `storageUriFor()` | Maps an HTTP storage path to the URI that names the same file |
| `resolveSelf()` / `namesSelf()` | **The** expansion of `yaar://apps/self/…` |

Four invariants worth knowing before you touch any of it:

- **The token is identity; `WindowStateRegistry` is authority.** A token carries who an iframe *is*; everything a caller granted *to this window* at runtime lives on `WindowStateRegistry.delegatedGrants`, read per request through `setWindowGrantResolver`. A token is not durable and a window is — every reconnect re-mints one, so authority baked in at mint time vanished on the first page refresh.
- **Three producers, one home.** Delegated grants (`features/window/delegated-grants.ts` — its 65-line header is the full story), caller-supplied `permissions` on `window.create`, and the window's own document. Each narrows; the registry only stores.
- **A token dies with its window.** `revokeTokensForWindow` is wired into `LiveSession`'s `setOnWindowClose`, registered in the **constructor** because windows outlive the pool.
- **The copy shape is shared** (`handlers/storage-copy.ts`). `invoke { action: 'copy', from }` reads a URI the caller did not name as its target, so `POST /api/verb` re-checks `read` on `from` — per element, since a batched invoke is N calls the registry runs without returning to the door.

Tokens for subresources that cannot set a header (`<img src>`, `EventSource`) ride as
`?__yaar_token=`. `extractIframeToken()` is the one definition of "presenting a token" and all
three layers that ask call it.

**MCP principal:** each agent gets a token minted by `mcp/agent-tokens.ts` and bound to its id
server-side; providers send it as `X-Agent-Token`. The shared bearer token (`getMcpToken()`) is
transport auth only. There is deliberately no `x-agent-id` header — an agent that can name a
principal can become it.

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
