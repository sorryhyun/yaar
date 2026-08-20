# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
bun run test                   # Every suite, each in the process it needs
```

## Tests

`bun run test` is `scripts/run-tests.ts`: it globs **every** `*.test.ts` under `src/` (colocated
files included — which is why `tsconfig.build.json` excludes them), groups them by
`scripts/test/partitions.ts`, and spawns one process per partition. The split is load-bearing and
enforced by `scripts/test/partition-guard.ts`. The partition list, the three rules that follow
(never depend on the machine; never `mock.module` under `src/tests/loopback/`; assert against the
narrowest module), and the `ANSWER_EVENT_TYPES` loopback rule: the `yaar-testing` skill (Server
package specifics) and the rationale headers in `scripts/test/partitions.ts` / `scripts/test/env.ts`.

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
| `YAAR_STORAGE` / `YAAR_CONFIG` / `YAAR_SESSION_LOGS` / `YAAR_USER_APPS` | repo dirs | Path overrides; all four pinned to temp dirs in tests |
| `YAAR_WORKSPACE` | — | Pre-fill the four path overrides from `workspaces/<name>/`; new deploys land there too |
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
| `YAAR_BROWSER_STATE_DIR` / `YAAR_BROWSER_EPHEMERAL` | `storage/.browser` / off | Sandbox profile + session records; `=1` makes the profile scratch again |
| `YAAR_BROWSER_IDLE_MINUTES` | `5` | Idle sweep for browser sessions (`0` disables; a watched session is exempt) |
| `MARKET_URL` | `https://yaarmarket.vercel.app` | App marketplace endpoint |

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
│   └── routes/           # api.ts (REST), verb.ts (iframe verb proxy), files.ts, browser.ts, proxy.ts, static.ts
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
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS; the one protocol era
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
│   ├── http/             # fetch.ts — proxied HTTP fetch; binary-body.ts — what a *model* gets
│   │                     #   when the response is bytes (an app still gets the base64 envelope)
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
| AsyncLocalStorage | `agents/agent-context.ts` | Track agentId in async context |
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

Per-provider config (models, session persistence, prewarm), the **notice-vs-error contract** (a
recoverable failure becomes `StreamMessage.type === 'notice'`, never `error` — `error` is terminal
by contract and latches the turn closed), and Codex packaging (`@openai/codex` optional peer dep,
vendored-binary resolution): the `server-providers` skill, which loads when editing `providers/`.

**Codex version policy:** an under-versioned CLI is **refused rather than driven** — at codegen,
at auto-detect in `factory.ts`, and at the `initialize` handshake; a forced `PROVIDER=codex` turns
the refusal into a refused boot. Gate-by-gate rationale: the `codex-provider` skill and
`providers/codex/version.ts`.

## Tools (MCP)

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`,
`messaging`, and `subagent`. The `verbs` server exposes 5 generic tools (`describe`, `read`,
`list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import
domain logic from `features/`) via `yaar://` URIs.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs |
| `mcp/system/` | system | reload_cached, list_reload_options |
| `mcp/app-agent/` | app | describe, query, command, relay (+ direct_message when granted) |
| `mcp/messaging/` | messaging | Cross-agent direct messaging |
| `mcp/sub-agent/` | subagent | app-defined tools of the *calling* sub-agent — empty for everyone else |

Everything below this surface lives in the `server-verbs` skill, which loads when editing
`handlers/`, `mcp/`, or `features/`: the **stateless-only protocol era** (`getModernHandler` in
`mcp/server.ts` — read its two documented traps first), verb semantics and the
six false-success rules, the two batching axes, **access tiers** (`access: 'session-principal'`),
the app protocol and its `$defs` resolution, declared-not-automatic app-agent storage,
monitor ↔ app messaging, sub-agent containment, and self-update (`features/update/`).

## REST API

Routes in `http/routes/` — `routes/api.ts`, `routes/verb.ts`, and `routes/files.ts` hold the full
signatures. **A route never invents its own permission check**: it resolves the caller to a
`Principal` (`resolvePrincipal`) and names the `yaar://` URI + verb it is about to perform
(`requirePermission`) — the same check `POST /api/verb` runs. The route list, the gate table
(`requireApp` / `requireHost` / `requireBundle` / `permissionsAllow`), the four token/grant
invariants, and the MCP principal model: the `server-http` skill, which loads when editing
`http/`. `http/access.ts`'s header is the authority on what a principal is — read it before
adding a gate.

