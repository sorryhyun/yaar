# Server Refactoring Plan: Code Reduction & DevX

Consolidated plan from a four-subsystem audit of `packages/server/` (agents, providers,
mcp/features/handlers, http/websocket/storage). Goal: remove ~600–800 lines of duplication,
name recurring shapes, and eliminate drift-prone hand-maintained lists — **no behavior changes**.

Ordered into phases by risk. Each phase is independently landable; run
`bun run typecheck && bun run --filter @yaar/server test` after each.

---

## Phase 1 — Pure deletions & drop-in replacements (zero risk)

### 1.1 Delete the dead Codex stdio client (~290 lines)
- [ ] Delete `providers/codex/jsonrpc-client.ts` — `JsonRpcClient` is never instantiated
      (verified by grep); everything uses `jsonrpc-ws-client.ts`.
- [ ] Remove the `JsonRpcClient` / `JsonRpcClientOptions` re-exports from `providers/codex/index.ts:7`.
- [ ] Delete the unused type guards in `providers/codex/types.ts:143-176`
      (`isErrorResponse`, `isServerRequest`, `isNotification`, `isResponse`).

### 1.2 Replace hand-rolled listener arrays with `EventEmitter` (~150 lines)
- [ ] `providers/codex/app-server.ts:111-114, 466-544` — extend Node's `EventEmitter`,
      delete the parallel listener arrays and manual `on`/`off`/`removeAllListeners`/fan-out.
- [ ] `providers/codex/jsonrpc-ws-client.ts:84-88, 298-360` — same treatment.
- [ ] Keep the typed method signatures as thin overloads so call sites don't change.

### 1.3 Micro-utils (many call sites, mechanical)
- [ ] `genId(prefix: string): string` — one implementation of
      `` `${prefix}-${Date.now()}-${Math.random()...}` ``. Replace 5–6 copies:
      `mcp/messaging/index.ts:114`, `mcp/app-agent/index.ts:390`, `handlers/window.ts:324`,
      `features/agents/relay.ts:22`, `features/config/shortcuts.ts:95`, `handlers/mcp-gateway.ts:52`.
- [ ] `errMessage(err: unknown): string` — replaces the 17 occurrences of
      `err instanceof Error ? err.message : String(err)` across `features/dev/*`,
      `features/browser/*`, `handlers/apps.ts`, `mcp/external/client-manager.ts`, etc.
- [ ] Suggested home: `lib/ids.ts` / `lib/errors.ts` (or one `lib/misc.ts` — keep it tiny).

### 1.4 Use the existing result builders inside `mcp/*`
- [ ] `handlers/utils.ts` already exports `ok`, `okJson`, `error`, `okWithImages`, `okResource`,
      `okLinks`. Import them in `mcp/app-agent/index.ts` (delete local `errText`, lines 80-82),
      `mcp/messaging/index.ts`, and other `mcp/*` tools hand-rolling
      `{ content: [{ type: 'text', ... }] }` (~30 inline literals).
- [ ] This standardizes the `isError: true` flag (currently applied by the verb layer but
      omitted by app-agent, which prepends `Error:` instead).

### 1.5 Reuse the canonical session resolver
- [ ] `handlers/utils.ts:30-35` (`getActiveSession`/`getActivePool`) is the canonical
      "resolve active session" helper. Replace the re-implementations in:
      `mcp/server.ts:95-106` (×2), `mcp/app-agent/index.ts:72-78`, `mcp/messaging/index.ts:66-69`,
      `features/window/app-protocol.ts:112-114`, `features/browser/actions.ts:21-26`,
      `features/session/browser.ts:57-59` (verbatim duplicate of the previous one).
- [ ] If import direction is awkward (handlers → features), move the helpers to a neutral
      module (e.g. `session/active-session.ts`) and re-export from `handlers/utils.ts`.

---

## Phase 2 — Named types & options objects ("dataclasses")

### 2.1 Options object for `StreamToEventMapper` (13 positional params)
- [ ] `agents/session-policies/stream-to-event-mapper.ts:24-39` — replace the 13 positional
      constructor params with a single `StreamMapperOptions` interface.
- [ ] Update the one call site (`agents/agent-session.ts:380-406`, currently a 26-line
      positional invocation).
- [ ] While there: consider the same for `AgentSession`'s 7-param constructor and
      `handleRenderingFeedback`'s 8 params — same file, same pattern.

### 2.2 Options object for `getSDKOptions` + fold in the model override
- [ ] `providers/claude/session-provider.ts:124-129` — change
      `getSDKOptions(resumeSession?, systemPrompt?, agentId?, allowedTools?)` to take
      `{ resumeSession?, options: TransportOptions }`.
- [ ] Fold the `if (options.model) sdkOptions.model = options.model` patch (currently
      repeated at all 3 call sites: lines 363-373, 484-494, 519-528) into the builder.

### 2.3 Name the stats shapes
- [ ] Add `AgentPoolStats`, `MonitorBudgetStats`, and
      `PoolStats = AgentPoolStats & { ... }` to `agents/pool-types.ts`.
- [ ] `agents/context-pool.ts:722-749` currently re-declares `AgentPool.getStats()`'s fields
      inline — return `PoolStats` instead. Gives `/api/agents/stats` a named contract.

### 2.4 Share small duplicated shapes
- [ ] `QueuedTask` (`{ task: Task; timestamp: number }`) is declared identically in
      `agents/context-pool-policies/monitor-queue-policy.ts:3-6` and
      `window-queue-policy.ts:3-6` — export once from `pool-types.ts`.
- [ ] Export `ContentBlock` + `isContentBlocks` from `handlers/uri-registry.ts` (canonical
      `VerbResult` union, lines 46-54); delete the local redeclarations in
      `features/window/app-protocol.ts:38-65` and `handlers/mcp-gateway.ts:47-48`.

### 2.5 Typed event channels for `actionEmitter`
- [ ] Define `SessionScopedEvent { sessionId: string; event: ServerEvent }` and a typed
      channel map (`'verb-subscription'`, `'app-protocol'`, `'bridge-event'`, ...) over a
      thin typed-emitter wrapper.
- [ ] Replaces the inline envelope shapes at `http/subscriptions.ts:204-213, 298-306`,
      `session/live-session.ts:76, 257-262, 276`, `websocket/bridge-handlers.ts:71`.
- [ ] Payoff: channel/payload mismatches become compile errors instead of silently dropped
      events (CLAUDE.md explicitly warns this path "silently fails" when bypassed).

---

## Phase 3 — Shared helpers for repeated scaffolding

### 3.1 `parseJsonBody<T>()` for HTTP routes (~11 sites, ~80–100 lines)
- [ ] Add to `http/utils.ts`:
      `async parseJsonBody<T>(req, opts?: { maxBytes?; allowEmpty? }): Promise<T | Response>`
      — handles `readBodyWithLimit`/`BodyTooLargeError` → 413, empty body → 400,
      parse failure → 400. Caller: `if (body instanceof Response) return body`.
- [ ] Replace the "large body" variant: `http/routes/verb.ts:169-178, 261-270`,
      `browser.ts:262-269`, `dev.ts:153-158`, `proxy.ts:44`, `bridge.ts:53`,
      `files.ts:223`, `ml-runtime.ts:~225`.
- [ ] Replace the "small body" variant: `settings.ts:46-56, 94-104`,
      `shortcuts.ts:74-82, 111-119`, `sessions.ts:95-103`.

### 3.2 Generic auth prelude for routes
- [ ] Promote `browser.ts`'s local `requireWeb()` pattern to a shared helper in
      `http/access.ts`, e.g. `resolveAndAuthorize(req, url, { uri, verb } | { bundle })`
      returning `Principal | Response`.
- [ ] Replace the ~20 copies of "resolvePrincipal → instanceof Response check →
      requirePermission/requireBundle → denied check" across `http/routes/*`.

### 3.3 `createPersistedStore<T>` for `storage/` (~60–80 lines)
- [ ] Add `createPersistedStore<T>(filename, defaultValue)` exposing
      `read() / write() / update()` with cache + parse-with-fallback + mkdir/persist baked in.
- [ ] Migrate `storage/permissions.ts:48-74` and `storage/mounts.ts:28-55` (near line-for-line
      identical today), then `storage/settings.ts:61-82` and `storage/shortcuts.ts:11-23`.
- [ ] Move the `_setMountsForTest`-style cache resets onto the store (one test hook, not four).
- [ ] Also: extract `buildAppShortcut(app)` — the shortcut literal is built identically in
      `storage/shortcuts.ts:62-69` and `:117-125`, with a third variant in
      `http/routes/shortcuts.ts:86-97`.

### 3.4 `defineActions()` — declarative action routers for verb handlers
- [ ] Helper that takes `{ actionName: { handler, description? } }` and produces
      (a) the JSON-Schema `action.enum` generated from the keys, and
      (b) an `invoke(payload)` doing `requireAction` + dispatch + standardized
      "Unknown action" error.
- [ ] Migrate: `handlers/window.ts` (15-value enum at 81-174 vs switch at 267-353 — the
      worst drift risk), `handlers/agents.ts:69-84 + 113-176`, `handlers/apps.ts:405-469`,
      `handlers/session.ts`, `handlers/user.ts:97-128`, `handlers/config.ts`,
      `mcp/app-agent/index.ts:240-292`.
- [ ] Known existing drift to fix while migrating: app-agent's `storage:*` sub-commands
      are missing from its enum.

### 3.5 Queue-full handling shared by task processors
- [ ] `enqueueOrReject(ctx, queue, task, monitorId): boolean` — emits either the
      queue-full `ERROR` or `MESSAGE_QUEUED` with position.
- [ ] Replaces ~4 copies: `agents/monitor-task-processor.ts:61-78, 93-119, 150-170`,
      `agents/app-task-processor.ts:84-95`. The two error strings already differ slightly —
      pick one.
- [ ] `MAX_QUEUE_SIZE = 10` is declared in both `monitor-task-processor.ts` and
      `context-pool.ts` — single-source it.

---

## Phase 4 — Structural consolidation (medium risk, biggest payoff)

### 4.1 `AgentPool`: one iterator, one dispose (~150 lines)
- [ ] Add `private *allAgents(): Iterable<{ agent: PooledAgent; type: AgentEntry['type'];
      monitorId?: string; appId?: string }>` yielding each agent once across the four
      collections (`sessionAgent`, `monitorAgents`, `appAgents`, `ephemeralAgents`).
- [ ] Rewrite over it: `findMonitorForAgent` (471-477), `getRoleForAgent` (495-507),
      `interruptAll` (536-547), `interruptByIdOrRole` (554-571), `hasRolePrefix` (576-588),
      `listAgents` (597-638), `getStats` (645-681), `cleanup` (688-717).
- [ ] Extract `private async disposeAgent(agent, label)` (untrack → interrupt if running →
      `try cleanup finally limiter.release()` → log); rewrite `disposeEphemeral` (228-237),
      `removeMonitorAgent` (289-308), `disposeAppAgent` (365-383),
      `disposeSessionAgent` (438-453) as "remove from my collection + disposeAgent".
- [ ] Why it matters: adding a new agent tier currently means editing 8+ sites; a missed
      one is a silent bug (the file's own comments describe exactly this class of bug).

### 4.2 De-duplicate `mcp/app-agent` against the verb/messaging layers (~100+ lines)
- [ ] Storage: `mcp/app-agent/index.ts:168-315` reimplements storage dispatch that
      `handlers/apps.ts` already has — extract a shared storage-verb helper and delegate.
      Removes a second, subtly-different copy of storage-permission logic.
- [ ] Relay: `mcp/app-agent/index.ts:369-406` is a strict subset of `mcp/messaging`'s
      `direct_message` monitor route (its header says it "generalizes the app agent's
      relay") — export the route function and call it.

### 4.3 Claude provider cleanups (`providers/claude/session-provider.ts`, 648 lines)
- [ ] De-dupe the two turn paths: `session_id` capture (405-409 vs 554-558) and
      stale-session "No conversation found" retry (415-427 vs 562-571) are byte-for-byte
      copies — extract `captureSessionId(msg)` / `isStaleSessionError(mapped)`.
- [ ] Split the file: `input-channel.ts` (lines 46-80), `sdk-options.ts` (options builder +
      env-strip list + MCP server config), keep turn/lifecycle in the provider.
      ⚠️ The env-scrub logic is load-bearing for Claude-in-Claude (see CLAUDE.md) — move
      it verbatim, don't rewrite.
- [ ] Shared MCP config: both providers build the per-agent
      `http://127.0.0.1:{port}/mcp/{ns}` + agent-token map
      (`claude/session-provider.ts:134-166`, `codex/provider.ts:414-434`) — extract
      `providers/mcp-servers.ts` returning the common map; each provider does only its
      final SDK-specific reshape. Security-sensitive token plumbing → one audited place.

### 4.4 Split `session/live-session.ts` (1100 lines)
- [ ] Replace the 390-line `routeMessage` switch (583-973) with a
      `Record<ClientEventType, handler>` lookup — a `ClientEventRouter` module. Makes
      "which events are handled" greppable.
- [ ] Extract the emitter listener wiring (constructor lines 195-297 + the matching
      teardown in `cleanup()`) into a `SessionEmitterBridge` that owns setup and teardown
      together.
- [ ] The `USER_INTERACTION` case (850-939) inlines window-action construction that
      belongs with window state — move it there.

### 4.5 Smaller structural items (do opportunistically)
- [ ] `WindowStateRegistry` (`session/window-state.ts:93-207`): add
      `mutateWindow(rawId, monitorId, fn)` (resolve → guard → mutate → stamp `updatedAt`)
      — 7 of 9 switch cases collapse to one line; removes the "forgot updatedAt" footgun.
      Add `getState(windowId)` so the 8 one-property query methods read `getState(id)?.x`.
- [ ] `MonitorBudgetPolicy`: the `PRIMARY_MONITOR` early-return is duplicated in 7 methods —
      one `isThrottled(monitorId)` guard.
- [ ] Codex `message-mapper.ts:105-236`: route `item/mcpToolCall/*` and
      `item/commandExecution/*` through the same `mapItemStarted/Completed` helpers as
      `item/started`/`item/completed`; replace the ~20-entry ignore if-chain (252-278) with
      a module-level `Set` + prefix list.
- [ ] Error-category classifier (`stream-to-event-mapper.ts:201-221`): replace the
      `content.includes(...)` if-chain with a `[substrings, category][]` table.
- [ ] Provider factory/warm-pool drift: export one `PROVIDER_PREFERENCE` list and one
      `instantiateProvider(type)` helper (currently forked between `factory.ts:33,88-100`
      and `warm-pool.ts:70,104-126`); route Codex's availability probe through the shared
      cached async probe in `base-transport.ts:109-124` instead of its own `Bun.spawnSync`.
- [ ] `WindowSubscriptionPolicy`: factor `registerSubscription(sub)` and a single
      `buildNotifyTask(sub, prefix, content)` — `subscribe`/`subscribeChannels` and
      `buildTask`/`buildChannelTask` are near-identical pairs.

---

## Phase 5 — Optional file splits (cosmetic, lowest priority)

- [ ] `features/browser/actions.ts` (644 lines): keep the dispatcher + guard glue, move the
      ~22 leaf actions into `actions/navigation.ts`, `actions/dom.ts`, `actions/cookies.ts`,
      `actions/capture.ts`.
- [ ] `features/apps/discovery.ts` (450 lines): move the four `loadApp*` doc loaders
      (384-449) to `features/apps/docs.ts`; discovery keeps manifest→`AppInfo` assembly.
- [ ] URI sub-path parsers: move `parseAppStoragePath`/`parseAppDbPath` (`handlers/apps.ts:64-80`),
      `parseTarget` (`mcp/messaging/index.ts:47-60`) into `lib/yaar-uri-server.ts` alongside
      the existing `parseConfigUri`/`parseSessionUri` — centralizes the `..`-traversal guards.

---

## Explicitly NOT doing

- **No further `base-transport.ts` unification** — the two providers' turn loops are
  genuinely different (persistent SDK stream vs per-turn JSON-RPC); more base-class would
  add abstraction without deleting code.
- **Leave alone (already-good prior extractions):** `agents/turn-helpers.ts`,
  `logging/session-logger.ts` (`appendEntry`), the `ResourceRegistry` URI routing,
  `http/server.ts`, `websocket/server.ts`, and the `state`-object seam in `AgentSession`'s
  constructor (deliberate — the three session-policies share live state through it).

## Verification per phase

1. `bun run typecheck`
2. `bun run --filter @yaar/server test`
3. Phase 4 additionally: one manual smoke run (`make claude-dev`, send a prompt, open an
   app window, interact) — per project memory, verify in a single run.
