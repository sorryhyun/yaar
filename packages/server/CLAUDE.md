# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
bun run test                   # Unit suite, then the loopback suite, then integration
```

## Tests

`bun run test` runs three suites in **separate Bun processes**, and the split is load-bearing:

1. `src/tests` — unit/component tests, via `scripts/run-unit-tests.ts`.
2. `src/tests/loopback` — the loopback integration harness (see `tests/loopback/harness/`).
3. `src/integration`.

**The unit suite is itself partitioned by process.** `scripts/run-unit-tests.ts` reads every
file under `src/tests` and asks one question: does it call `mock.module`? Files that do get a
process each; everything else shares one `--parallel` process. The isolated processes run
concurrently with one another, so the wall-clock is close to a single shared run.

The partition is computed from source on every run — there is no list to maintain. Add a
`mock.module` to a file and it is isolated automatically; remove the last one and it rejoins
the shared process. Prose *mentioning* `mock.module` doesn't count (comment lines are stripped
before the match), which is why the loopback harness's long explanation of why it avoids mocks
doesn't isolate anything.

This exists because `--parallel` runs files concurrently **in one process**, and `mock.module`
is process-global with no teardown. A stub is therefore visible to every concurrently-running
file that imports the same specifier, and which one wins is a race rather than an order. That
race shipped a red CI: four files stub `agents/profiles/index.js` with a `buildAppAgentProfile`
returning no `model`, and `app-agent-model.test.ts` — which asserts on the real one — passed
locally and failed in CI on identical code.

The loopback harness runs the real stack end to end — `createWsHandlers` → `SessionHub` →
`LiveSession` → `ContextPool` → `AgentSession` → `actionEmitter` → `PendingStore` — with
exactly two fakes: the browser (`FakeClient`, whose frames go through the real `message()`
handler) and the model (`ScriptedProvider`, whose turn is a script that `await`s a real tool
between yields). It exists because the deadlock that broke every app command lived *between*
units — a turn awaiting a client reply that was queued behind the frame that started the turn —
and a test that mocks either side cannot see it.

That is also why it needs its own process. `mock.module` is process-global, has no teardown,
and **`mock.restore()` cannot undo it once the real module has been loaded**. Five files in
`src/tests` replace `AgentSession` with a stub whose `handleMessage` resolves instantly; in a
shared process, that stub would hollow the harness out and every loopback test would pass while
proving nothing. Two rules follow:

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
- `YAAR_REMOTE_TOKEN` - Adopt this remote token instead of minting one, so a launcher can build the `#remote=<token>` URL before the server starts (`scripts/dev.sh` does this for `make claude`). Under 32 chars it is ignored with a warning — remote mode hands the token to every device that can reach the server. See `http/auth.ts`.
- `YAAR_STORAGE` / `YAAR_CONFIG` - Override storage/config directory paths
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
│   ├── session.ts        # AgentSession + AsyncLocalStorage (getAgentId, getSessionId)
│   ├── monitor-task-processor.ts / app-task-processor.ts / session-task-processor.ts
│   ├── window-event-coordinator.ts  # subscription/notification fan-out + window-close teardown
│   ├── interaction-timeline.ts / pool-types.ts / profiles.ts / turn-helpers.ts
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
│   ├── session.ts / skills.ts / user.ts / window.ts
├── mcp/                  # MCP server + tool folders (see Tools section)
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS
│   ├── system/           # Always-active: reload_cached, list_reload_options
│   ├── sub-agent/        # A sub-agent's one channel — per-caller tool list
│   └── index.ts          # Re-exports for server, system tools, verb tools
├── features/             # Domain business logic (imported by handlers/)
│   ├── apps/             # App listing, skill loading, marketplace, badge
│   ├── browser/          # CDP browser automation actions
│   ├── config/           # Hooks, settings, shortcuts, mounts, app config, domains
│   ├── dev/              # Compile, typecheck, deploy, clone, git.ts (per-app version history)
│   ├── http/             # fetch.ts — proxied HTTP fetch
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

`LiveSession` is the aggregate root (605 lines, down from 1,044). It owns four collaborators, each reached only through it and given narrow callbacks rather than the session itself:

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

## Tools (MCP)

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`, `messaging`, and `subagent`. The `verbs` server exposes 5 generic tools (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import domain logic from `features/`) via `yaar://` URIs.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs dispatching to `handlers/` via `yaar://` URIs |
| `mcp/system/` | system | reload_cached, list_reload_options |
| `mcp/sub-agent/` | subagent | app-defined tools of the *calling* sub-agent — the only namespace whose tool list depends on who connects; empty for everyone else |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for rendering feedback. Window tools support lock protection — only the locking agent can modify a locked window.

**Access tiers (role-based URI access control):** every agent carries a principal `role` (`session` / `monitor` / `app`) on its `AgentContext`. A handler may declare `access: 'session-principal'`, and `ResourceRegistry.execute()` then rejects any caller whose role isn't `session` (default-deny — `undefined` role is non-session). `yaar://session` and all `yaar://session/*` resources are marked session-principal, so only the session agent can read/invoke them; monitor/app agents and apps (`POST /api/verb` also hard-refuses `yaar://session/*`) get a `403`. The role is resolved from the pool (`AgentPool.getRoleForAgent` via `SessionHub.findRoleForAgent`) in the MCP path and from the per-turn role string (`principalRole()`) in-process. The gate's role resolver is injected via `setAccessRoleResolver()` (wired in `lifecycle.ts`) to avoid a runtime import cycle.

**App Protocol:** Bidirectional agent-iframe communication via `query`/`command` tools (in the `app` MCP server). Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. See shared CLAUDE.md for event schemas.

**Monitor ↔ App Agent Communication:**
- **Monitor → App**: `invoke('yaar://windows/{id}', { action: 'message', message: '...' })` — wraps message in `<monitor:{monitorId}>` tags and routes as an app task via `AppTaskProcessor`. Fire-and-forget; use `hook: 'response'` to get the app agent's reply back.
- **App → Monitor**: App agent's `relay` tool enqueues a `type: 'monitor'` task. Additionally, app agent responses are pushed to `InteractionTimeline` and drained by the monitor on its next turn.

**Sub-agents / persona agents (`yaar://apps/self/agents`):** an app that declares
`"personas": { "max": N }` — or, identically, `"subagents": { "max": N }` — in its app.json
(bundled-only, like `controls`/`streams`) may spawn up to N AI instances, each with a system
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
`apps/chitchats` (rooms with `skip`/`recall`/`memorize`, whose persona documents are what a
reclaimed character is respawned from) for the reference consumer.

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

Routes in `http/routes/`. Pattern: `GET /health`, `/api/providers`, `/api/apps`, `/api/sessions`, `/api/shortcuts`, `/api/settings`, `/api/domains`, `/api/agents/stats`, `/api/storage/*`, `/api/pdf/*`, `/api/browser/*`, `/api/fetch`, `/api/pick-directory`, `/api/remote-info`, `POST /api/iframe-token`, `POST /api/verb`, `POST /api/verb/subscribe`. See `routes/api.ts`, `routes/verb.ts`, and `routes/files.ts` for full signatures.

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

**Known gap (token-forgery closed by default):** app-origin isolation is on by default in local mode (`YAAR_APP_ORIGIN_ISOLATION`, set `=0` to disable). Installed apps are served cross-origin from `127.0.0.1` and `resolvePrincipal` refuses a token-less request carrying the app origin, so an app can no longer omit its token and be resolved as `host`. Being cross-origin the browser already blocks `window.parent` DOM/memory reach, and top-level navigation (`window.top.location`) is now closed too — isolated frames carry `ISOLATED_APP_SANDBOX` (IframeRenderer.tsx), which withholds only the top-navigation family. The residual is the isolation-*off* case and remote mode **with the tunnel disabled** (`config/tunnel.json` → `{ "disabled": true }`, the LAN/external-tunnel fallback) — one host and one port publishes no second origin, so apps are same-origin again and sandboxing does not help. The default Tailscale Serve transport *does* keep the boundary (the `proxy-port` mode above). One consequence: an isolated app's calls authenticate with their **iframe token**, accepted by `checkHttpAuth` as a credential in its own right — the old `Referer`-borne remote token only ever worked because apps were same-origin, and a cross-origin `Referer` is trimmed to a bare origin. See [`docs/guides/remote_mode.md`](../../docs/guides/remote_mode.md).

**MCP principal:** each agent gets a token minted by `mcp/agent-tokens.ts` and bound to its id server-side; providers send it as `X-Agent-Token`. The shared bearer token (`getMcpToken()`) is transport auth only and says nothing about *which* agent is calling. There is deliberately no `x-agent-id` header — an agent that can name a principal can become it.
