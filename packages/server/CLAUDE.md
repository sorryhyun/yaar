# Server Package

TypeScript WebSocket server with pluggable AI providers.

## Commands

```bash
bun run dev                    # Start server with Bun (--watch)
bun run build                  # Build for production
bun run test                   # Unit suite, then the loopback suite, then integration
```

## Tests

`bun run test` runs three **separate Bun processes**, and the split is load-bearing:

1. `src/tests` — unit/component tests (`--path-ignore-patterns='**/loopback/**'`).
2. `src/tests/loopback` — the loopback integration harness (see `tests/loopback/harness/`).
3. `src/integration`.

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
- **A `mock.module` in `src/tests` must be safe to leak** — stub the *whole* surface of what you
  replace, since the next file to run inherits it (see the note in `ws-head-of-line.test.ts`).

Server→client waits (`ANSWER_EVENT_TYPES` in `@yaar/shared`) each get a loopback row: a wait the
client can only answer over a socket the server is holding is a deadlock waiting to happen.

## Environment Variables

- `PROVIDER` - Force provider (`claude` or `codex`). Auto-detected if not set.
- `PORT` - Server port (default: 8000), `MAX_AGENTS` - Global agent limit (default: 10)
- `MCP_SKIP_AUTH` - Skip MCP auth (`1` for local dev), `REMOTE` - Enable remote mode (`1`)
- `YAAR_STORAGE` / `YAAR_CONFIG` - Override storage/config directory paths
- `MONITOR_MAX_CONCURRENT` (default: 2), `MONITOR_MAX_ACTIONS_PER_MIN` (30), `MONITOR_MAX_OUTPUT_PER_MIN` (50000) - Background monitor budget limits
- `CODEX_WS_PORT` (default: 4510), `CHROME_PATH` (auto-detected), `MARKET_URL`
- `YAAR_BROWSER_PROVIDER` - **No longer a selector.** `POST /api/browser` is always the headless sandbox (`getHeadlessBrowser()`); the user's real Chrome is reached only through the session-agent door `yaar://session/browser` (`getLocalBrowser()`), which auto-attaches whenever a debuggable Chrome is reachable. The var survives only as a **force-headless opt-out**: set `=headless` to keep the agent away from your real browser (the session door then uses the sandbox too).
- `CHROME_DEBUG_PORT` (default: 9222) - DevTools port the local (session-door) browser provider attaches to (user launches Chrome with `--remote-debugging-port`).

## Directory Structure

```
src/
├── main.ts               # Thin orchestrator (~35 lines)
├── config.ts             # Constants, paths, MIME types, PORT, monitor budget limits
├── lifecycle.ts          # initializeSubsystems(), printBanner(), shutdown()
├── http/                 # HTTP server: createFetchHandler() (CORS, auth, MCP dispatch)
│   ├── access.ts         # THE ACCESS CHOKEPOINT — resolvePrincipal(), requirePermission(), requireHost(), requireBundle()
│   ├── auth.ts           # checkHttpAuth(), generateRemoteToken(), isStaticAsset()
│   ├── iframe-tokens.ts  # generateIframeToken(), validateIframeToken()
│   ├── subscriptions.ts  # subscriptionRegistry — reactive verb URI subscriptions
│   └── routes/           # api.ts (REST), verb.ts (iframe verb proxy), files.ts, browse.ts, proxy.ts, static.ts
├── session/              # LiveSession, SessionHub, BroadcastCenter, ActionEmitter, WindowStateRegistry, types
├── websocket/            # WebSocket server + connection registry
├── agents/               # Agent lifecycle, pooling, context management
│   ├── agent-pool.ts     # AgentPool — per-monitor, app, and session agent registry
│   ├── context-pool.ts   # ContextPool — unified task orchestration
│   ├── context.ts        # ContextTape — hierarchical message history
│   ├── limiter.ts        # AgentLimiter — global agent semaphore
│   ├── session.ts        # AgentSession + AsyncLocalStorage (getAgentId, getSessionId)
│   ├── monitor-task-processor.ts / app-task-processor.ts
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
│   ├── agents.ts / apps.ts / storage.ts / config.ts
│   ├── session.ts / skills.ts / user.ts / window.ts
├── mcp/                  # MCP server + tool folders (see Tools section)
│   ├── server.ts         # Tool registration, request handling; CORE_SERVERS
│   ├── system/           # Always-active: reload_cached, list_reload_options
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
        │   └── App Agents: Map<appId, PooledAgent>  ← persistent per app
        ├── ContextTape (hierarchical message history)
        │   ├── [main] user/assistant messages
        │   └── [window:id] branch messages
        └── Policies (MonitorQueue per monitor, WindowQueue, ContextAssembly, ...)
```

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

For non-agent contexts (HTTP routes, proxy) where there is no `LiveSession` reference, use the `actionEmitter` EventEmitter pattern:
1. `actionEmitter.emit('my-event', { sessionId, event })` from the source
2. `actionEmitter.on('my-event', handler)` in the `LiveSession` constructor → `this.broadcast(event)`
3. Clean up listener in `LiveSession.cleanup()`

See `'app-protocol'`, `'approval-request'`, and `'verb-subscription'` listeners in `live-session.ts` as reference implementations. Calling `BroadcastCenter.publishToSession()` directly bypasses routing and silently fails during active agent streaming.

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

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`, and `messaging`. The `verbs` server exposes 5 generic tools (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import domain logic from `features/`) via `yaar://` URIs.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs dispatching to `handlers/` via `yaar://` URIs |
| `mcp/system/` | system | reload_cached, list_reload_options |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for rendering feedback. Window tools support lock protection — only the locking agent can modify a locked window.

**Access tiers (role-based URI access control):** every agent carries a principal `role` (`session` / `monitor` / `app`) on its `AgentContext`. A handler may declare `access: 'session-principal'`, and `ResourceRegistry.execute()` then rejects any caller whose role isn't `session` (default-deny — `undefined` role is non-session). `yaar://session` and all `yaar://session/*` resources are marked session-principal, so only the session agent can read/invoke them; monitor/app agents and apps (`POST /api/verb` also hard-refuses `yaar://session/*`) get a `403`. The role is resolved from the pool (`AgentPool.getRoleForAgent` via `SessionHub.findRoleForAgent`) in the MCP path and from the per-turn role string (`principalRole()`) in-process. The gate's role resolver is injected via `setAccessRoleResolver()` (wired in `lifecycle.ts`) to avoid a runtime import cycle.

**App Protocol:** Bidirectional agent-iframe communication via `query`/`command` tools (in the `app` MCP server). Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. See shared CLAUDE.md for event schemas.

**Monitor ↔ App Agent Communication:**
- **Monitor → App**: `invoke('yaar://windows/{id}', { action: 'message', message: '...' })` — wraps message in `<monitor:{monitorId}>` tags and routes as an app task via `AppTaskProcessor`. Fire-and-forget; use `hook: 'response'` to get the app agent's reply back.
- **App → Monitor**: App agent's `relay` tool enqueues a `type: 'monitor'` task. Additionally, app agent responses are pushed to `InteractionTimeline` and drained by the monitor on its next turn.

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
- **`app`** — an iframe token. Confined to its app.json `permissions`, plus the auto-granted `yaar://apps/self/storage/`.
- `requireHost()` — routes no app can hold a permission for (`/api/iframe-token`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, session restore).
- `requireBundle()` — gated SDK doors (`/api/dev/*` → `yaar-dev`; `/api/browser`, `/api/bridge` → `yaar-web`; `/api/ml-weights*` → `yaar-ml`). The compiler's `bundles` gate only sees an app's *source*; a hand-written `fetch()` never went near it.
- `storageUriFor()` — maps an HTTP storage path to the URI that names the same file. `/api/storage/apps/{id}/x` **is** `yaar://apps/{id}/storage/x`; only that spelling is what an app holds a permission for. `self` is resolved on both sides of the match (app.json says `apps/self`, a URI from a path says `apps/notes`).
- Tokens for subresources that cannot set a header (`<img src>`, `EventSource`) ride as `?__yaar_token=`.

**Known gap:** app iframes are same-origin and unsandboxed, so a *hostile* app can omit its token and be resolved as `host`. The gate binds network callers, cross-session reads, and well-behaved apps; closing it against malicious app code needs an origin boundary, not another header. See [`docs/architecture/known_gaps.md`](../../docs/architecture/known_gaps.md).

**MCP principal:** each agent gets a token minted by `mcp/agent-tokens.ts` and bound to its id server-side; providers send it as `X-Agent-Token`. The shared bearer token (`getMcpToken()`) is transport auth only and says nothing about *which* agent is calling. There is deliberately no `x-agent-id` header — an agent that can name a principal can become it.
