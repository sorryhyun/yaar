# Server Refactoring Plan: Code Reduction & DevX

Consolidated plan from a four-subsystem audit of `packages/server/` (agents, providers,
mcp/features/handlers, http/websocket/storage). Goal: remove ~600–800 lines of duplication,
name recurring shapes, and eliminate drift-prone hand-maintained lists — **no behavior changes**.

Ordered into phases by risk. Each phase is independently landable; run
`bun run typecheck && bun run --filter @yaar/server test` after each.

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

## Follow-ups surfaced by phases 1–2 (not in the original audit)

Each was found while doing a phase, and deliberately left out of it — all are deletions or
test-infra changes that a "no behavior changes" refactor shouldn't smuggle in.

- [ ] **Dead export: `AppServerEvents`** (`providers/codex/app-server.ts`). Referenced nowhere,
      and since 1.2 it duplicates the merged interface's channel declarations — two places to
      edit when a channel changes. Delete it.
- [ ] **Dead method: `AgentSession.handleRenderingFeedback`** (8 params). Zero call sites; the
      live path is `live-session.ts:746` → `actionEmitter.resolveFeedback({...})` directly. Its
      body is a positional-to-object adapter over `RenderingFeedback`, which
      `session/action-emitter.ts:46` already exports. Delete rather than convert — but it's
      public surface on a widely-imported class, so confirm no app/test reaches it.
- [ ] **CI never typechecks `packages/server/src/tests`** — `tsconfig.build.json` excludes it,
      and the `typecheck` script uses that config. Currently zero errors hide there (verified
      against HEAD), so this is cheap to close now and gets more expensive with every drift.
      Either add a `typecheck:tests` script or stop excluding `src/tests`.
- [ ] **`isError` on app-agent/messaging is now live** (1.4). Failures surface as error rows in
      the CLI panel and are flagged as errors to the model
      (`stream-to-event-mapper.ts:174`). Worth one manual smoke check that nothing downstream
      over-reacts to a routine failure.

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
