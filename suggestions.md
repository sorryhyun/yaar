# Suggestions: bottlenecks to a better agentic experience

A whole-codebase review done on 2026-10-03 by ten parallel reviewers, one per subsystem, all asked
the same question: *what stands in the way of expanding YAAR and giving it a nice agentic
experience* (fast first response, parallelism, responsive interruption, many agents coordinating,
long work that survives, agents that remember, a user who can see what is going on)?

Findings marked **[verified]** were re-read in the code by the coordinating reviewer after the
area reports came in. Everything else was found by one reviewer reading the code; nothing was
exercised at runtime. Paths are relative to `packages/server/src/` unless noted.

Repo health at the time of review: `bun run typecheck` 12s pass, `make lint` 8s pass,
`bun run test` 4021 pass / 0 fail / 2 skip in 31s, one TODO in the whole tree, 7 stale-doc
warnings from `check:docs`.

---

## 1. Executive summary

The codebase is in good engineering shape. The agentic experience is held back less by any one
subsystem than by a handful of serialization points and missing layers that every reviewer hit
from a different side. Four findings were reached independently by two or three reviewers each:

| # | Bottleneck | Severity | Reviewers who found it |
|---|---|---|---|
| 3 | Only monitor agents are prewarmed; every other tier starts cold | High | orchestration, providers |
| 4 | The system prompt is volatile, which kills stream reuse and prompt caching | High | prompts, providers |
| 5 | Agent limits refuse instead of wait, and reclaim destroys agent memory | High | orchestration, providers |
| 6 | Agent-to-agent traffic interrupts the monitor's running turn; no `wait` primitive | High | orchestration, providers, verbs |
| 7 | No cross-session memory; background work and sessions are not durable | High | persistence, session/state |
| 8 | The user cannot see what agents are doing; interruption is blunt | High | frontend |
| 9 | The browser tool has no semantic page model and no batching | High | browser |
| 10 | Nothing checks agent behavior: no eval, no replay, no per-turn metrics | High | dev-loop |

### Recommended order

**Phase 1: small, confirmed, compounding (days).** Items 3–4. Prewarm every tier, freeze the
system prompt per agent lifetime. These fix much of "YAAR feels slow" with no architectural
change.

**Phase 2: the two structural refactors (weeks).** A per-agent mailbox replacing the ~8
overlapping concurrency mechanisms (item 6), and one resource scheduler with tiered budgets,
LRU eviction and thread-id persistence replacing the limiter + monitor budget (item 5).

**Phase 3: new layers (weeks).** Agent memory + durable tasks (7), a live turn surface and a
richer Component DSL (8), an AX-tree browser snapshot with refs (9), a trust tier for AI-authored
apps (section 7), the verb-layer `defineResource` single source (section 4).

**Throughout:** the eval/replay harness and per-turn metrics (10) should land alongside Phase 1,
because every change above touches behavior that nothing currently tests.

---

## 2. Agent orchestration core

`agents/`: agent-pool, registries, limiter, context-pool, task processors, agent-session,
policies, `providers/warm-pool.ts`.

### Bottlenecks

**O2. One serial monitor conversation is the coordination hub, and agent traffic interrupts it (High).**
Relays and hook responses to a busy monitor queue and then `interrupt()` the running turn
(`monitor-task-processor.ts:133-160`). An app agent answering with `hook:'response'` or a
`direct_message` cuts off whatever multi-step job the monitor was doing. A Claude interrupt with
messages left in `still_queued` kills the CLI process (`providers/claude/session-provider.ts:964-980`),
so the next turn cold-resumes.
*Fix:* per-agent mailbox; steer first (TurnGate makes Claude steering reliable now), else hold in
the timeline until the next turn; interrupt only when the sender marks the message urgent.

**O3. [verified] Global agent limit is flat, refuses, never evicts (High).**
`agents/limiter.ts:53-59` is process-wide across all sessions and tiers, `MAX_AGENTS` default 10.
At the limit: a new monitor gets "Agent limit reached" (`context-pool.ts:299-310`), an app gets
"Failed to create agent" (`app-task-processor.ts:247-254`), a persona gets `no-slot`. Idle app
agents keep slots 60 min (`config/limits.ts:41`); a tool-less persona costs a full slot.
*Fix:* budgets per tier (reserve monitor/session slots; larger persona pool); evict LRU idle app
agent or persona under pressure (context-lost/handoff notices already exist); short per-session
wait queue; fair share across sessions.

**O4. Reclaiming an app agent wipes its memory (High for long work).**
`AppAgentRegistry.dispose` (`app-agent-registry.ts:252-269`) ends the provider session and
records no thread id. Resume exists only for monitors (`savedThreadIds`,
`monitor-task-processor.ts:258-260`).
*Fix:* save the thread id on reclaim, resume on recreate. Makes O3's eviction nearly free.

**O5. Only monitor agents are warmed (Med-High).**
Warm pool holds one provider (`providers/warm-pool.ts:27`); for Claude "warm" means an
*unspawned* instance, the real warmup is `prewarm` (`warm-pool.ts:7-9`), and the only call site
is `context-pool.ts:372-377`. App, sub, ephemeral and session agents pay spawn + MCP handshake
on first turn (`app-agent-registry.ts:122`, `sub-agent-registry.ts:209`, `agent-pool.ts:386,478`).
Monitors > 0 get their agent on first message (`session/client-event-controller.ts:280`), so
the prewarm races the turn and saves nothing.
*Fix:* prewarm an app agent when its window opens; a monitor agent on `ADD_MONITOR`.

**O6. Busy-monitor fallback is a cold, context-less ephemeral (Med).**
`createEphemeral` starts a fresh provider with no history, and also catches `kind:'notify'`
subscription wakes (`window-subscription-policy.ts:454-462`): each wake on a busy monitor can
cost a cold process and a slot.
*Fix:* never route notify to an ephemeral; buffer it. Replace ephemerals with a forked
conversation (Codex has `thread/fork`; Claude can resume).

**O7. Background-monitor budget breaks the busy check (Med).**
`isMonitorAgentBusy` is checked (`monitor-task-processor.ts:120`) before the budget slot is
awaited (up to 30s, `monitor-budget-policy.ts:63-79`); `currentRole` is set later
(`turn-helpers.ts:97`), so during the wait the monitor looks idle and relays/notifies skip the
queue. "Primary" is hard-coded to `'0'` (`monitor-budget-policy.ts:19`): a user working on
monitor 1 has their foreground desktop throttled.

**O8. Agent-to-agent messaging is fire-and-forget (Med).**
`direct_message` says "Message delivered" when it has only queued
(`mcp/messaging/index.ts:128-139`). No request/reply correlation, no way to wait for an answer.
App agents cannot subscribe. `InteractionTimeline` has no size cap and includes full app-agent
response text (`interaction-timeline.ts:20,62-80`).

### Bugs

- `context-pool.ts:916-956`: `reset()` has no try/finally; a throw leaves `resetting = true` and every later task is dropped.
- `monitor-task-processor.ts:381-391`, `features/agents/relay.ts:30-31`: budget-wait timeout throws the task away (after the sender was told "delivered") and exits the drain loop, stranding the rest of the queue.
- `agent-pool.ts:414-417`: a monitor with *no* agent reports busy, so relays to an untouched monitor queue forever.
- `app-task-processor.ts:249-252`: creation-failure ERROR carries no `messageId`. `context-pool.ts:558-563`: `awaitInflight` keeps one resolver; a second waiter overwrites the first.
- `agent-session.ts:404-426`, `turn-helpers.ts:97,138`: "parallel" app tasks still serialize on `turnInFlight` and clobber `currentRole`; `context-pool.ts:837-841` teardown comment cites a removed method and sub-agent turns are not counted in-flight, so teardown can dispose a provider mid-turn.

### Structural assessment

Well hardened against the races it has hit (reservations, idempotent dispose, explicit drop
reporting), but concurrency control is spread across ~8 mechanisms (WS lanes, MonitorQueuePolicy
flag, AppSlot.turn + queue, AgentSession.turnInFlight, budget semaphore, global limiter,
SpawnReservations, inflight counter) with three definitions of "busy". Adding an agent kind
touches `allAgents`, the roster union, `getRoleForAgent`, `buildAgentTree`, stats, and a new
processor. Refactor before growing: **per-agent actor/mailbox** (fixes O2, O6, O7) and **one
resource scheduler** with tiers, LRU eviction and thread persistence (fixes O3, O4).

---

## 3. Providers and streaming

`providers/` (Claude session-provider, Codex provider/app-server, warm-pool, turn-gate),
`agents/session-policies/stream-to-event-mapper.ts`, `mcp/server.ts`, `mcp/tool-call-buffer.ts`.

### Bottlenecks

**P1. Most agents start cold (High).** See O5. Additionally: `prewarm` always opens
`conversation: {kind:'new'}` (`agent-session.ts:372`), so a restored turn naming `resume` is a
`wrongConversation` (`session-provider.ts:493-495`) and the warm process is killed. App and
session agents lose history on restart (only monitors get `savedThreadIds`).
*Fix:* pass the saved thread id into `prewarm`; persist/resume app-agent threads.

**P2. [verified] System-prompt change reopens the stream and loses the cache (Med-High).**
`turnFingerprint` includes the whole `systemPrompt` (`session-provider.ts:466-473`). The prompt
is rebuilt every turn (`agent-session.ts:481`) and includes the environment section: app roster,
`isCompiled`, hints, settings, onboarding (`agents/environment.ts:131-150`,
`agents/system-prompt.ts:84`). Any install/compile/settings change → close, respawn, MCP wait,
`resume`, and a full prompt-cache miss because the prompt *is* the cache prefix. Codex re-creates
the thread the same way (`codex/provider.ts:546-579`). Building it also reads every app's hint
from disk and `settings.json` before each send.
*Fix:* fix the prompt for the agent's lifetime; deliver environment changes as a short note in
the next user message; cache the environment section.

**P3. A Codex turn can hang forever; a dead AppServer stays dead (High).**
`query()` subscribes to `notification` and `server_request` only, never `close`
(`codex/provider.ts:217-235`). A dropped socket mid-turn never closes the inbox; turn and queue
stall until the user presses stop. Live providers hold the dead `AppServer` (`provider.ts:190`);
only *new* provider creation restarts it (`warm-pool.ts:146-186`). Neither provider has a
"no frames for N minutes" watchdog.
*Fix:* close the inbox and yield an error on client close; resolve the AppServer via a
supervisor; add a stall watchdog.

**P4. Interrupt misses the turn's startup window (Med-High).**
Claude: an interrupt during the `mcpReady` wait (`session-provider.ts:518-538`) is acknowledged
with nothing running, the message is then sent anyway, and a hidden turn runs to completion
(tools execute, tokens spent, next turn waits behind it). Codex: before `turn/start` answers,
`turns.current` is undefined so the outcome is `idle` (`provider.ts:337-341`) while the turn
runs on the server. Verb handlers never receive an `AbortSignal`.
*Fix:* check abort after the MCP wait and before send; on Codex send `turn/interrupt` once the id
arrives; pass `req.signal` to handlers.

**P5. App-agent replies interrupt the monitor (Med).** See O2.

**P6. Codex MCP tool calls likely time out at 60s (High, Codex only).**
Claude gets `MCP_TOOL_TIMEOUT=250s` (`config/providers/claude.ts:128`, `deadlines.ts:50`); Codex
`mcp_servers` entries set no `tool_timeout_sec` (`provider.ts:469-473`). If the CLI default is
60s, user prompts (240s), app commands and compiles fail with the dialog still open. Verify
against the pinned CLI.
*Fix:* `tool_timeout_sec ≈ 250` on every entry.

**P7. Too many streaming events (Med-Low).**
Each `tool_input_delta` fragment is its own `TOOL_PROGRESS` broadcast
(`stream-to-event-mapper.ts:458-474`); a 30KB `window.create` is hundreds of frames.
`AGENT_THINKING` resends the whole block every 200ms (`:420-430`), quadratic in length. The
`complete` event carries the full tool result up to 100K chars (`:591-598`). Text coalescing has
no trailing timer (`:399`).
*Fix:* coalesce deltas at ~60ms, send thinking as deltas, cap result previews, trailing flush.

**P8. Codex reasoning is invisible (Med, parity).**
`item/reasoning/summaryTextDelta` is in `IGNORED_METHODS` (`codex/message-mapper.ts:141`), so the
reasoning phase "reads as hung" (the problem `config/providers/claude.ts:168-176` fixed for
Claude). Codex also streams no tool arguments and has no `prewarm`.

### Bugs

- `mcp/tool-call-buffer.ts`: one process-wide buffer, not keyed by agent/session; a sub-agent's `task_progress` (`claude/message-mapper.ts:223-228`) can show another session's URI and payload.
- `turn-router.ts:130-137`: a steered message the CLI does not fold in is marked abandoned and its answer dropped after `MESSAGE_ACCEPTED` was already sent (`monitor-task-processor.ts:165-178`). Needs verifying.
- `session-provider.ts:555-559`: a stream that dies before its first frame retries with `sessionId=null` and no `resume`, silently discarding the conversation.
- `codex/provider.ts:217-220`: notifications are not filtered by `turnId`; a late `turn/completed` can end the next turn as "interrupted".
- `codex/message-mapper.ts:40-45,79-92`: `mcpToolCall` items carry no `toolUseId`, so durations are never recorded and parallel calls cannot be matched. Doc drift: `docs/reference/claude_codex.md:171` says Claude thinking is "not configured" but `CLAUDE_STATIC_SDK_OPTIONS` sets `adaptive`/`summarized`.

### Parity

Claude is the better-built path: persistent CLI, prewarm, pump + TurnRouter, streamed arguments,
readable thinking, escalating interrupt, 250s tool timeout. Codex lacks the matching pieces and is
ahead only on `turn/steer`. Suggested: a provider conformance suite in the loopback tests (crash
mid-turn, interrupt before start, late terminal frames, 120s tool call, reasoning visibility) run
against both; then close Codex gaps in order P3, P6, P8, P4; add Codex `prewarm` via `thread/start`.

---

## 4. MCP tool surface (URI verbs)

`handlers/`, `mcp/`, `features/*` registrations. Counts: 5 verb tools, ~44 `registry.register`
patterns (~30 namespaces), 14 hand-listed `registerXHandlers` calls (`handlers/index.ts:55-68`),
~24 handler modules (`window.ts` 1062 lines, `config.ts` 519). Plus 4 app-agent tools, 2 system
reload tools, `direct_message`, and per-sub-agent app tools.

### Bottlenecks

**V1. The `read` tool schema carries glTF/PDF options in every prompt (Med-High).**
`handlers/index.ts:~126-215`: 9 `gltf*` params, `pdfText`, `pdfPages`, `rawImage`, ~100 lines of
schema on a generic tool whose design goal is "zero prompt tokens until you describe".
*Fix:* handlers declare read options (like `invokeSchema`), surfaced via `describe`; keep
`lines`/`pattern`/`chars` plus an `options: {}` bag.

**V2. Discovery costs round-trips and `describe` is raw JSON (Med-High).**
External tool: `list yaar://mcp` → `list .../{server}` → `describe .../{tool}` → `invoke`
(`handlers/mcp-gateway.ts:1-8`). Default describe is `JSON.stringify(result, null, 2)` with a
hand-written `invokeSchema` (`uri-registry.ts:~290`). `config.ts` has 8 hand-written schemas
that duplicate the `defineActions` enum (`handlers/define-actions.ts`).
*Fix:* derive `invokeSchema` from the Zod action table; render describe as compact signatures
with an example; add a root catalogue (`list yaar://`).

**V3. Batching is split across mechanisms and half useful (Med).**
Brace expansion runs in parallel with one payload for all URIs (`index.ts:~110-135`); array
payload runs sequentially against one URI and stops at first failure (`uri-registry.ts
executeBatch`), `invoke` only. No heterogeneous cross-URI batch. Results are a `--- [i] ---`
text stream.
*Fix:* `batch: [{verb, uri, payload}]` with per-item structured results and `continueOnError`.

**V4. Large-result spill covers only the verb door (Med).**
Verbs spill > 100k chars to `yaar://storage/temp/tool-results/` with a 2 KB preview
(`mcp/result-spill.ts:~60-159`); good. But app-agent `describe`/`query`/`command` and external
tools rely on the 150k `_meta` hint only; image/binary results are never spilled (`modelText`
returns null); the 2 KB preview forces an extra round-trip almost every time.
*Fix:* shared spill wrapper for every result-returning tool; preview ~8-10 KB; structural preview
for JSON.

**V5. Waiting on events is not cheap (Med).**
`subscribe` delivers notifications as a *new turn*; no blocking `wait`. `direct_message` is
fire-and-forget (`mcp/messaging/index.ts:211`). Request/response is two turns minimum.
*Fix:* `invoke ... {action:'wait', events, timeoutMs}`; `send+await reply` on messaging.

**V6. Adding a capability costs 3-5 touch points (Med).**
New `handlers/foo.ts` with full `register(...)`, import + call in `index.ts`, access-policy
pattern, schema duplicated from Zod types, docs entry. `skills.ts` is 80 lines for a 2-pattern
read-only namespace.
*Fix:* `defineResource({uri, actions: {name: {schema, run}}})` generating `invokeSchema`, enum,
describe text, verbs; auto-registration by directory glob.

**V7. Access tiers are coarse and not discoverable (Low-Med).**
One gate (`session-principal`, `uri-registry.ts:~145`). The 403 text does not say what to do
instead; `describe` does not show access.
*Fix:* `access` in describe output; delegation hint in the 403.

**V8. External MCP servers (Med).**
Freeform payload with no validation against the cached JSON-Schema; no per-server concurrency or
rate limit; `CALL_TIMEOUT_MS = MAX_REQUEST_DEADLINE_MS`, so one hung tool blocks a turn for
minutes; results bypass spill.

### Bugs

- `features/window/subscribe.ts:~28-33`: `subscriberType` hardcoded `'monitor'`; a non-monitor caller appears keyed as the monitor. Unverified at runtime.
- `mcp/result-spill.ts`: image/binary results skip spill; `delete` has no `_meta` cap; `pruneSpills` is unthrottled `readdir`+`stat` on every spill; spill files readable by any agent.
- `uri-registry.ts executeBatch`: not atomic, resend index only in prose.
- `mcp/agent-tokens.ts`: `byAgent`/`byToken` never cleared except by `revokeAgentToken`; no persistence, so a restart invalidates running CLI children.

### Verdict

The URI/verb abstraction is a good foundation (single chokepoint, brace expansion, fallbacks,
"ignored filter" notes show model-facing care). Weakest where discoverability meets schema. First
change: the Zod action table as single source (`defineResource`), which fixes V1, V2, V6 at once.
Then root catalogue, cross-URI batch, `wait`, shared spill.

---

## 5. System prompts, profiles, context

`agents/profiles/**`, `system-prompt.ts`, `environment.ts`, `context.ts`,
`context-assembly-policy.ts`, `features/skills/`.

### Measured sizes (composed with bun, ~4 chars/token)

| Profile | Static | Environment | Total | Per-turn dynamic |
|---|---|---|---|---|
| Monitor agent | 24.5k chars / ~6.1k tok | 14.2k chars / ~3.5k tok (this install) | ~38.6k chars / **~9.7k tok** | `<timeline>` (no cap) + `<open_windows>` (~120-200 chars/window + covers lists) + `<reload_options>` + `<device>` |
| Session agent | 6.3k / ~1.6k | 14.2k | ~20.4k / **~5.1k tok** | none |
| App agent | intro 0.8k + app-storage 3.4k + payload-literals 1k + per-app prompt + manifest | none | ~2-3k tok | handoff snapshot + message |
| Sub-agent | app prompt (cap 20k chars) + tool list (cap 6k) | none | app-defined | none |

Tool-description schemas (section 4, V1) add more on every turn and were not measured.

### Bottlenecks

**S1. The environment block is the largest part after the verb docs (High).** ~3.5k tokens,
grows with every installed app (`environment.ts:95-122`), and goes to the session agent too.
*Fix:* one-line-per-app roster; hints behind `describe('yaar://apps/{id}')`; cap hint length;
drop the roster for the session agent.

**S2. Any environment change restarts the live stream (High).** See P2.
*Fix:* move the roster out of the system prompt into a per-turn block sent only when changed.

**S3. ContextTape is not a memory; compaction is crude (High).** Its header says "kept for
logging/debugging" (`context-pool.ts:9`); nothing in `agents/` reads it into a prompt. Pruning
is `MAX_MONITOR_MESSAGES = 200` → keep newest 100 (`context.ts:93-125`), no summarization.
`restoredContext` is restored into the tape only (`context-pool.ts:205`); what the model
remembers after restart is unclear.
*Fix:* rolling summary entry or rely on SDK compaction and document it; make restore explicitly
seed the new provider thread.

**S4. The monitor prompt carries rarely-used features (Med).** `drawings.md`,
`reload-cache.md`, `remote-control.md`, `config.md`, the `apps.md` URI cheat-sheet, and
duplicated brace/verb explanations in `verb-tools.md` total ~6-8k chars. `config.md` duplicates
the `config` skill.
*Fix:* one-line pointers; detail into skills.

**S5. `<open_windows>` grows with window count, no cap (Med).** `formatOpenWindows`
(`context-assembly-policy.ts:93-139`) is O(n²) for covers; emits geometry every turn. 15 windows
≈ 2-3k chars/turn.
*Fix:* diff since last turn; collapse minimized windows to a count.

**S6. Skills are static and not extensible (Med).** `TOPICS` is a build-time map of 5 files
(`features/skills/topics.ts:17-31`). Users and apps cannot add skills. Missing: sub-agent
spawning, error/recovery playbooks, window-vs-notification decision, writing apps.
*Fix:* scan `storage/skills/*.md` and per-app skills into `list`.

**S7. Model tiers partly hardcoded, no per-agent override (Med).** `developer.ts` and
`session-agent/index.ts` hardcode `claude-opus-5-5`. `FABLE=1` pins every subordinate to Opus
even for `agentType: haiku` (`model-tiers.ts:23`).
*Fix:* `config/settings` model per role; Fable pin skips explicit haiku.

**S8. Codex divergences (Low).** `codex-roles.ts:41` interpolates `instructions` into a TOML
string with no escaping; `worker` and `explorer` get no instructions.

### Stale or contradictory instructions

1. `prompts/visibility.md:3,8` (use notifications for "done"/"on it") vs `orchestrator/prompts/intro.md` last paragraph ("don't narrate, just do it"). `remote-message.md:3` ("Answer in your reply, in full") is a correct but unflagged exception.
2. `prompts/uri-namespaces.md` lists `yaar://session/agents` as common; `provider-codex.md` says it is refused for the monitor agent.
3. `orchestrator/prompts/apps.md` explains `hook: "response"` twice; `provider-codex.md` a third time.
4. `orchestrator/prompts/builtin-tools.md` is an orphaned 88-char sentence that `reload-cache.md` repeats.
5. `orchestrator/prompts/config.md:13` "skill shortcut" `<skill>` tags vs `skills.md` read-only skill topics: naming clash.

### Missing guidance

When to answer inline vs open a window; when to spawn a Task sub-agent vs do it directly; how to
retry after a tool error or failed iframe load; how to verify a result.

---

## 6. Session, window state, event flow

`session/`, `websocket/`, `reload/`, `logging/`, `@yaar/shared` actions and events.

### Bottlenecks

**W3. Agents depend on a browser being attached (High, durability).**
`scheduleEviction` default 60s (`session/session-hub.ts:63`, called from
`websocket/server.ts:336`). 60s after the last tab drops, the pool is torn down and running
turns die. A closed laptop lid kills a long task. On reattach the replacement is seeded from
*boot-time* restore options (`server.ts:185-187`), not the evicted state.
*Fix:* keep sessions with busy agents alive; snapshot window state on eviction.

**W4. Server→client waits ignore whether a client is attached (High).**
`DesktopRequest.ask` (`desktop-request.ts:103-139`) parks even with zero connections (prompt
240s, dialog 60s, app command 30s, capture 5s). `clientAwayNote` returns null with no
connections (`client-presence.ts:218`). Headless/background work stalls unless the companion tab
runs.
*Fix:* fail fast with `no-desktop`.

**W5. Restore loses a lot (Med-High).** Rebuilt from `messages.jsonl` action entries
(`window-restore.ts:64-84`). Lost: drags/resizes/minimize/focus (logged as compact strings,
`client-event-controller.ts:595-599`; restore reads only `close:`), per-window app command
replay log (`window-state.ts:99`, memory only), the monitor list (`monitor-registry.ts:66`
always starts at `[0]`, so monitor 1+ windows come back invisible), locks and grants. Every
restart copies every message into the new log (`restore-source.ts:85-89`).
*Fix:* periodic `WindowStateRegistry` + monitors snapshot, separate from the transcript.

**W6. The OS Actions DSL is too coarse (Med).** `ContentUpdateOperation`
(`shared/src/actions.ts:257-262`) has only string append/prepend/insertAt and whole replace. No
keyed/partial updates for `component`/`table`; no streaming while the model generates (content
arrives when the tool call finishes); no batches (every action is its own `ACTIONS{actions:[one]}`
frame, `live-session.ts:462-467`); no layout constraints or transitions. Frontend re-sanitizes
and re-parses the whole markdown document per append.

**W7. Full state on reconnect and per-tab fan-out (Med).** `RESYNC` sends every window's full
content and re-mints every iframe token (`session-snapshot-service.ts:54-59`). Window actions go
session-wide (`live-session.ts:111-127`) so every tab mounts every monitor's windows. Each
publish walks every connection in the process (`broadcast-center.ts:225-249`).

**W8. Logging is on the hot path and weak for debugging (Med).** `appendEntry` stringifies
synchronously; `reviveJson` walks the whole tool input. Window content is written ~4 times
(`tool_use` + `action`, global + per-agent: `session-logger.ts:283-298,419-432,531`). Action
entries carry no toolUseId/turn id/monitor. Rendering feedback, captures and app-protocol
round-trips are not logged (`client-event-controller.ts:387`). No replay tool.

### Bugs

1. `live-session.ts:393` applies the action to `windowState` *before* `deliverEmittedAction`, which can drop it (`:453-456`, `:518`). Server holds windows the client never got.
2. `monitor-registry.ts:193-216`: removing a monitor never closes its windows; teardown never runs; the reused id resurrects them on the next `ADD_MONITOR` via `RESYNC`, and they survive restart.
3. Server and frontend content reducers disagree: `clear` → `''` on server (`shared/actions.ts:680`) vs `emptyContentByRenderer` on frontend (`windowsSlice.ts:364`); invalid op → replace on server, keep on client (`:371-378`). After `RESYNC` the server wins.
4. `window-state.ts:479` vs `live-session.ts:462`: the close teardown cascade runs before the `window.close` broadcast.
5. `action-emitter.ts:207,281-286`: `currentMonitorId` is process-wide last-writer-wins; concurrent turns on different monitors can mis-place ephemeral agents' windows.

### Structural assessment

Well documented and defensive, but incidents were fixed by adding rules + comments without
simplifying the core model, leaving the "raw id vs scoped handle" problem at the centre (~43
`handleMap`/raw-id/suffix-match sites across 32 files). Adding an action is expensive:
`window.reload` (8c94dfe6) touched ~10 non-test files in 4 packages; a request/response action
(clipboard, 8bc5baa1) ~13. **Best single refactor:** one opaque server-minted window id, alias
resolved once at the MCP boundary; each OS Action defined once as a pure shared reducer in
`@yaar/shared` run by both `WindowStateRegistry` and `windowsSlice`. Removes handle-stamp,
dual-key side records, the frontend suffix scan and bug 3; makes W5 and W6 straightforward.

---

## 7. Frontend

`packages/frontend/src` (19.6k LOC; largest: PhoneGestures 883, CommandPalette 732,
IframeRenderer 684, windowsSlice 566, desktop.ts 558). Dispatcher is a clean exhaustive switch;
actions batch into one Immer transaction; no whole-state replace.

### Bottlenecks

**F1. Agent activity is a text log in a side panel, not attached to the work (High).**
Thinking/response/tool events go to `cliStreaming`/`cliHistory`
(`lib/transport/server-event-dispatcher.ts:165-250`), rendered only in `TerminalPane.tsx:84-100`.
On-desktop status is a one-line string. `WINDOW_AGENT_STATUS` (dispatcher:290) is a flag only.
*Fix:* per-turn activity card (tool, target window, status, duration) from `TOOL_PROGRESS`; agent
badge on the window being edited.

**F2. The response is never streamed into the UI the user is looking at (High).**
`AGENT_RESPONSE` → `updateCliStreaming` only (dispatcher:178-190). `cliSlice.ts:115` appends by
string concat; `useShallow` over a 5000-entry history (`TerminalPane:84`) rebuilds per add.
*Fix:* a reply bubble above the palette (markdown, incremental, collapsible); append/patch action
for streaming regions.

**F3. The Component DSL is too thin (High).** `shared/src/component-types.ts:67-75`: button,
input, select, text, badge, progress, image. No container/tabs/table/checkbox/toggle/chart/list/
rich text; flat grid only. Forms and dashboards fall back to HTML/iframe.
*Fix:* `table` (sort/select), `tabs`/`group`, `checkbox`/`switch`, `markdown`, `chart`, `list`,
client-side validation, a `stream` region bound to a subscription.

**F4. Interruption is blunt and its feedback optimistic (Med).** `CommandPalette.tsx:333-346`
binds Escape to a global `interrupt()` that also collapses the palette; "Agent stopped" toast
shows before the server confirms (`commands.ts:~199`). Per-agent stop only in the roster
(`AgentStatus.tsx:173`).
*Fix:* visible Stop button; Escape stops the focused monitor only or needs double-press;
"stopping..." until the complete event.

**F5. Input affordances are partial (Med).** Image paste/drop and `@appId` mention exist; no
file attach, retry/edit-last, up-arrow history, or click-to-target-window.

**F6. Error surfaces are weak (Med).** `ERROR` (dispatcher:253-271) → `connectionError` (shown
only pre-connect), a CLI entry, and a failed chip. `AGENT_NOTICE` → CLI line only (:273-285).
Rate limits look like a freeze.
*Fix:* toast/banner with Retry tied to the message chip.

**F7. Component-action round-trip is opaque (Med).** `sendComponentAction`
(`commands.ts:181-199`) fires and forgets; no pending state on the button.

**F8. Code health (Low-Med).** 732-line CommandPalette and 883-line PhoneGestures mix concerns;
`aria-` appears 32 times; `ko` locale is short 5 keys; ~71 test files.

### Bugs

- `server-event-dispatcher.ts:176` (and `AGENT_THINKING` above it): `clearAllMessageStatuses()` on every thinking event wipes queued/failed chips belonging to other agents or monitors.
- `CommandPalette.tsx:337-345`: Escape both collapses and globally interrupts, with a fabricated toast count.
- `dispatcher:263`: `setConnectionError` on every agent ERROR; stale value persists until next attach.
- `dispatcher:283`: tool `complete` events for ordinary tools are dropped, so no duration/result trace.
- `cliSlice.ts:115-127`: `appendCliStreaming` is O(n²) over a long argument stream and re-renders every CLI subscriber per delta.

### Three features, in order

1. A live "turn" surface above the palette: streamed markdown reply + step timeline + per-agent Stop + inline Retry (fixes F1, F2, F4, F6 with data the dispatcher already has).
2. A richer streaming Component DSL with pending states on actions.
3. Prompt ergonomics: history, edit-and-resend, target-window chip, file attach.

---

## 8. Apps system and compiler

`apps/` (16 apps, ~40k LOC, devtools 14.3k), `packages/compiler`, `features/apps`,
`features/market`, `features/dev`, `mcp/app-agent`, `app-state-handoff.ts`. Measured on this
checkout: dock compile 0.3s, devtools 0.6s, dock typecheck 1.8s.

### Bottlenecks

**A1. AI-deployed apps get full bundled trust (High, security).** New deploys land in the
tracked `apps/` root (`features/apps/roots.ts:39-41`); anything under `APPS_DIR` is
`source:'bundled'` (`roots.ts:152`). `discovery.ts:57,83,385` return declared permissions
unchanged with no grant dialog; `:165,169` let a bundled app claim `kind`/`controls`. Bundled
apps are same-origin with the shell (`origin-marks.ts:11`) and may write other apps if they
declare `yaar-dev` (`http/routes/dev.ts:123-131`). An unreviewed app the AI just wrote can
rewrite system apps and dirties the git tree.
*Fix:* a third source (`generated`/`local-user`) treated like `user`: grant dialog, isolated
origin, no cross-app writes; deploy to the user-apps root by default.

**A2. The authoring loop is one-way through a 14k-line devtools app (Med-High).** No single
`yaar://apps/new {spec}` that scaffolds, builds and opens.
*Fix:* a first-class `create_app` verb (template → typecheck → compile → open).

**A3. Zero tests in `apps/` (High for scaling).** `find apps -name '*.test.*'` → 0 across
~40k LOC. Only compile-time guards and `check:apps`.
*Fix:* headless harness mounting `dist/index.html` with a fake host, driving `protocol.json`
commands; `/api/dev/preview/{appId}` and `fake-client.ts` already give most pieces.

**A4. Typecheck is skipped in the standalone exe (Med).** `typecheck.ts:~75`
`if (isBundledExe) return { success: true }`.
*Fix:* run in-process with the embedded `typescript` module.

**A5. Typecheck is fragile (Med).** Writes `.yaar-bundled-types.<uuid>.d.ts` into the
compiler package root (`typecheck.ts:~58`, read-only in some installs); spawns `tsc` per deploy;
hard 30s kill with only "tsc exited with code N".

**A6. Agent↔app protocol is request/response needing a live frontend (Med).** Agent →
ActionEmitter → WS → frontend → iframe → back, with deadlines (`window/app-protocol.ts:603,673`).
`app_subscribe` is monitor-agents-only, so an app agent cannot subscribe to its own app's events.
Handoff keeps only a sha256 fingerprint (`app-state-handoff.ts`), so the successor learns *that*
state changed, not *what*. Emitted payloads cap at 16 KB. The protocol extractor refuses
non-static commands (`extract-protocol-ast.ts:20-27,367-389`).
*Fix:* app-agent subscriptions; state-diff handoff for small state.

**A7. Marketplace trust and versioning are thin (Med).** No installer-verified publisher
signature; publish version guard fails open; no compatibility field tying an app to
`COMPILER_VERSION` or SDK version.

**A8. Compiler coupling and Solid lock-in (Low-Med).** Adding a library touches
`bundled/registry.ts`, the 3,605-line hand-maintained `bundled-types/index.d.ts`, prebundle, and
possibly a shim; `COMPILER_VERSION` ('42') is bumped by hand. All 14 framework apps use Solid;
React/Vue apps are effectively impossible.

**A9. Boilerplate duplication (Low-Med).** Hand-rolled signals, polling, per-app tables and
`styles.css` in every app; `createSharedSignal` exists but there is no scaffold/template layer.

### Bugs

- `features/dev/deploy.ts:374-410`: wipes `dist/` then copies non-atomically; a crash leaves a half-written app until next boot.
- `features/apps/auto-compile.ts:~75`: failures collected but not retried or surfaced at startup.
- `apps/search` ships a 3.6 MB `dist/index.html` (others 180-620 KB).
- `app-state-handoff.ts`: in-memory fingerprints only; restart gives `changedSinceHandoff` undefined.

### Distance to "AI writes an app, user uses it 30s later"

Mechanically close: typecheck ~2s, compile <1s, deploy + refresh + open is fast; the wall-clock
cost is generation. Missing: a scaffold-and-open verb with templates, a trust tier for
AI-authored apps, an app test harness, typecheck in the exe with structured diagnostics,
app-agent subscriptions, and a less rigid static-protocol constraint.

---

## 9. Browser automation and the outside world

`lib/browser/`, `features/browser/`, `features/companion/`, `features/live-encoder/`,
`features/http/`, `@yaar/lib` ssrf/freedpi/tunnel/ytdlp. ~10k lines, well bounded, raw CDP.

### Bottlenecks

**B1. No ref-based page model (High).** The model sees a 500-char viewport snippet
(`TEXT_SNIPPET_LENGTH`) + screenshot, or `extract` (3000 chars). `annotate`
(`lib/browser/page-scripts.ts:360-400`) lists viewport-visible elements with text cut to 40
chars, selectors `#id` or `tag.firstClass` (non-unique, `null` when neither), and injects a
visible overlay. `type` and `wait_for` require CSS selectors (`features/browser/actions.ts:244,371`).
*Fix:* a `snapshot` action returning an AX-tree list of `[ref] role "name" state` (iframes,
shadow DOM), refs cached server-side, every action accepting `ref`, diff after each action.

**B2. Too many round-trips, no batching (High).** ~40 single-step verbs
(`actions.ts:878-920`); each pays a 300-500ms settle (`session.ts:79-87`); `navigate` also waits
network idle (`session.ts:816`).
*Fix:* `steps[]` action stopping on error and returning one snapshot; `fill_form`,
`click_and_wait`.

**B3. Results are uncontrolled in size and shape (Med-High).** `extract` truncates at 3000
chars with no offset (`actions.ts:407-420,579`); http `MAX_RESPONSE_SIZE` 10MB
(`http/fetch.ts:13` calls it "a context limit dressed as a network one").
*Fix:* uniform token budget with `nextOffset`; markdown/readability mode.

**B4. http tool friction for arbitrary APIs (Med-High).** Each new domain is a blocking
dialog, 60s timeout (`features/http/domain-gate.ts:32-73`); no dialog without a session (`:55`).
No per-API credential injection, so the secret must be in the model's context.
*Fix:* named credentials (`yaar://config/credentials/<name>`) injected server-side for allowed
hosts; session-scoped and wildcard domain grants.

**B5. Sandbox session limits and short idle sweep (Med).** `MAX_SESSIONS = 5`,
`MAX_PINNED_SESSIONS = 5` (`cdp-provider.ts:36,42`); idle 5 min (`config/browser.ts:73`).
Fan-out research across 10 agents hits "Browser limit reached" as an error, not a queue; the cap
is per provider so one agent can starve others.
*Fix:* per-agent quota; LRU-evict idle tabs; activity-aware idle for tabs an agent is using.

**B6. Cold Chrome and fragile launch (Med).** Lazy launch on first `createSession` (seconds);
discovery depends on system Chrome/Edge; crash recovery gives up after 3 restarts
(`cdp-provider.ts:58,399`).
*Fix:* warm Chrome at idle behind a flag; model-visible "browser unavailable" status.

**B7. Live streaming costs server CPU and competes with the agent (Med).** Software AV1 per
viewer in a pinned tab that stays 5 min after the last viewer (`features/live-encoder/encoder.ts`);
Chrome composites only the frontmost tab, so foregrounding the encoder can interfere with agent
screenshots on other tabs; the encoder holds a pinned slot.
*Fix:* measure CPU; opt-in; JPEG low-fps default; `Emulation.setFocusEmulationEnabled` per tab.

**B8. Companion tab is a workaround for the frozen-client problem (Low-Med).** A second full
desktop in the server's Chrome (`features/companion/companion-tab.ts`), one more WS client in
every broadcast, extra memory on a phone.

### Bugs

- `page-scripts.ts:376-381`: non-unique/null annotation selectors → wrong-element clicks.
- `lib/browser/pid-file.ts:45`: shared `tmpdir()/yaar-browser.pid` is global; two YAAR instances can reap each other's Chrome.
- `session.ts:862-868`: post-navigate screenshot is fire-and-forget; the Browser app's still can lag.
- `domain-gate.ts:55-58`: no live session → fail closed with only a config hint; headless/API callers have no recovery.
- `encoder.ts` `RETRY_AFTER_MS`: after a start failure viewers stay on JPEG for 60s while the encoder tab holds a pinned slot. Unverified.

---

## 10. Storage, persistence, memory

`storage/`, `db/`, `logging/`, `config/`, `features/config`, hooks.

### Bottlenecks

**M1. No cross-session agent memory (High).** `prompts/storage.md` and `task-list.md` say
nothing about remembering; `task-list.md:3` calls checklists "working memory" discarded per turn.
No prompt references history; recall = grep raw JSONL. Nothing injects preferences or facts.

**M2. Restore covers only the single newest non-empty session (High).**
`logging/restore-source.ts:40-50` picks the first session with messages; `lifecycle.ts:198-240`
restores with `FULL_RESTORE_POLICY` (no cap). A throwaway session shadows real work.
`summarize_old_windows` exists (`context-restore.ts:60`) but is never used.
*Fix:* selectable restore ("resume session X"); use the summarize policy.

**M3. Carry-over makes logs grow without bound (Med-High).** Every user/assistant message is
copied verbatim into each new log on restart (`restore-source.ts selectCarryOverEntries`);
`logging/prune.ts` only deletes empty sessions.
*Fix:* summarize before carry-over; age/size retention.

**M4. Background work is not durable (High).** Schedule hooks
(`features/config/hook-scheduler.ts`) are dropped when nobody is connected (`:103-110`), when
the monitor is busy (`:113-117`), and marked run before delivery (`:65-68`). "Do X at 3am while
I'm away" does not work; no catch-up, no persisted task state, no resume of an in-flight turn.
*Fix:* persisted task store (`storage/tasks/*.json`) + opt-in headless run mode.

**M5. Non-atomic writes of important state (Med).** `storage/persisted-store.ts:60-65` uses
`Bun.write` directly (permissions, mounts, settings, shortcuts); `update` is read-mutate-write
with no mutex (`:66-72`); a corrupt file silently becomes the default (`:49-52`) and the next
update overwrites it. Only uploads use `.part` + rename (`storage-manager.ts:562-629`).
*Fix:* temp + rename, serialize `update()`, keep `.bak`.

**M6. Storage ergonomics (Med).** Regex grep capped at 100 matches
(`storage-manager.ts:839`); no index; no quota; no conditional write (etag/CAS), so concurrent
agents overwrite each other.

**M7. App DB (Med).** Good per-app SQLite with FTS5, LRU pool of 20 (`db/pool.ts:14`), 1000-row
cap. No schema versioning, no quota, `DEFAULT_LIMIT` 100 truncates silently. Natural substrate
for agent memory but app-scoped only.

**M8. Permissions and autonomy (Med).** Flat allow/deny/ask map in `config/permissions.json`;
no scopes, expiry or per-agent grants (those live in `app-grants.ts`).
*Fix:* trust profiles (e.g. autonomous for `yaar://storage/agent-workspace/**`), surfaced in the
configurations app.

**M9. Workspaces (Low-Med).** `YAAR_WORKSPACE` (`config/env.ts:203-222`) is path isolation
only: not `~/.claude`, provider thread ids, port or remote token.

**M10. Session logs for replay/eval (Low-Med).** No schema version marker; no deterministic
replay of tool results.

### Bugs

- `persisted-store.ts:49-52,66-72`: silent default on corruption; unlocked concurrent updates.
- `hook-scheduler.ts:65-68`: `markHookRun` before `deliver`; a drop loses the occurrence.
- `restore-source.ts:42-49`: parses every session's full JSONL at boot until one has messages.
- `context-restore.ts:55-57`: messages with missing/non-`yaar://` source are re-attributed to monitor `0`.

### Minimal agent-memory design that fits existing primitives

`yaar://storage/memory/` with `profile.md`, `facts/*.md` (one per fact, titled and dated),
`index.md` (one line per entry, ~100 lines), `tasks.json`. Changes: (1) a `memory.md` prompt
part telling the monitor agent to read the index at session start and write entries on
preferences/completed tasks; (2) the assembler injects `profile.md` + `index.md` (≤2 KB) at
session start; (3) `memory.search` via grep or an FTS5 db on the app-DB substrate; (4) an
idle-time summarizer writing `memory/sessions/<date>.md`, which restore uses instead of verbatim
carry-over; (5) schedule hooks that fire with no session append to `tasks.json` for delivery at
next launch.

---

## 11. Dev loop, tests, observability

### Measurements

| Metric | Result |
|---|---|
| `bun run typecheck` | pass, 12s |
| `make lint` | pass, 8s |
| `bun run test` | 4021 pass / 0 fail / 2 skip, 384 files, 30.6s wall (compiler partition 30.6s, server 26s) |
| TS LOC | server 133k, frontend 32k, compiler 26.5k (incl. 3.6k-line `.d.ts`), shared 10.6k, lib 10.6k |
| TODO/FIXME/HACK | 1 |
| Docs | 44 files under `docs/`, 7 `CLAUDE.md`, 8 skills; `check:docs` passes with 7 stale warnings |
| Largest non-test files | `lib/browser/session.ts` 1953, `compiler/src/shims/yaar-ml.ts` 1503, `lib/src/gltf/summarize.ts` 1301, `session/window-state.ts` 1157, `handlers/window.ts` 1062, `lib/browser/cdp-provider.ts` 1018 |

### Bottlenecks

**D1. No agent-behavior eval (High).** No golden/snapshot/eval files. Prompt tests
(`codex-custom-system-prompt.test.ts`, `fable-mode.test.ts`) check wiring, not behavior. The
mock provider (`providers/mock/index.ts`, 219 lines) is a scripted stub.

**D2. No replay of bad sessions (High).** `session_logs/` feed restore and `tail -f` only.

**D3. No metrics or tracing (High).** `observability/` is `log.ts` + two tests. Token usage is
folded per agent (`stream-to-event-mapper.ts:108`) but there is no `/metrics`, no per-turn
latency, no tool-call/error counters.
*Fix:* one `turn_end` log line per turn (duration, tokens, tool counts, error flag, provider) +
`/metrics`.

**D4. Server concentration (Med).** 133k LOC, ~55% of the repo, several files near or above
1000 lines, heavy reliance on prose conventions in 7 `CLAUDE.md` + 8 skills.

**D5. Bus factor (Med).** `git shortlog -sn` printed nothing in the reviewer's environment, so
contributor count is unconfirmed; 316 commits in 30 days.

**D6. Loopback suite tests protocol, not agent quality (Med).** ~25 `loopback-*.test.ts`
files on a deterministic mock.

**D7. Stale compiled test twins (Low).** `dist/**/*.test.js` run as real tests in compiler and
shared; deleting the src does not remove the twin. Add a pre-test clean.

### Most valuable infra to add next

An agent eval + replay harness on the existing mock provider and loopback harness. Each case is
`{prompt, recorded provider stream or tool-call script, expected OS Actions}`, captured from
`session_logs/` by a `scripts/dev/capture-eval.ts`. Deterministic cases go in
`packages/server/src/tests/evals/` inside the existing `@yaar/server` partition; a live tier
calling the real provider on a small prompt set runs nightly in a new `evals` partition excluded
from `bun run test`. Pair with D3 so a live run also reports latency and tokens.

---

## 12. Cross-cutting bugs worth fixing regardless of roadmap

| File | Bug |
|---|---|
| `agents/context-pool.ts:916-956` | `reset()` has no try/finally; a throw leaves `resetting` true and every later task is dropped |
| `providers/codex/provider.ts:217-235` | Turn never subscribes to `close`; a dropped app-server hangs the turn and the monitor queue forever |
| `session/monitor-registry.ts:193-216` | Removing a monitor leaves its windows; the reused id resurrects them on the next `ADD_MONITOR` |
| `storage/persisted-store.ts:49-72` | Non-atomic, unlocked writes; corrupt file silently becomes default and is then overwritten |
| `features/apps/roots.ts:39-41`, `discovery.ts:57-83` | AI-deployed apps get bundled trust, same origin, no grant dialog |
| `mcp/tool-call-buffer.ts` | Process-wide buffer leaks one agent's progress into another session's view |
| `providers/claude/session-provider.ts:518-538` | Interrupt during MCP wait is acked with nothing running; the message is then sent and a hidden turn runs |
| `live-session.ts:393` | Window state mutated before a broadcast that can be dropped |
| `frontend .../server-event-dispatcher.ts:176` | Every thinking event clears all message-status chips, including other agents' |
| `features/config/hook-scheduler.ts:65-68` | Slot marked run before delivery; a dropped occurrence is lost |
