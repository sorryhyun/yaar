# Proposal: Stream Subscriptions (Push-with-Payload Channels)

**Status:** Phases 1–2.1 shipped — Phases 3–4 deferred. The access-tier decision below was resolved to **(b)+(c)**.
**Builds on:** the app-event channel system (`app.register({events})` / `app.emit()` / `app_subscribe`), which shipped and closed the **app → agent** quadrant. This one adds **server/agent → app** *streaming* push. Its design record lived in `app_events_subscribe_proposal.md`, removed once implemented; the code is `WindowSubscriptionPolicy`, `ContextPool.notifyAppChannel`, and `features/window/subscribe.ts`.

**Provider references:** [Claude Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output) and [Codex app-server](https://learn.chatgpt.com/docs/app-server). Both providers already expose incremental response events; YAAR normalizes them as `StreamMessage` before any observer sees them.

**Shipped (Phase 1):** the frame envelope + transport + app SDK, plus one real source (deploy progress). See the "Change inventory" below for the file-by-file record of what landed versus what remains. The design prose (Model / Transport / Guards / Access control) is kept as the record for the remaining phases.

---

## Motivation

Before Phases 1–2, YAAR had two reactive edges, and both were **discrete, single-shot**:

| Direction | Mechanism | Payload? |
|---|---|---|
| app → agent | `app.emit(channel, payload)` (app event channels, landed) | yes, one shot |
| server → app | `yaar.subscribe(uri, cb)` (`http/subscriptions.ts`) | **no — just a ping** |

`subscribe()` is a change *notification*: the callback receives a URI string and the app must re-`read()` the whole resource (`verb-sdk.ts:65`, `subscriptions.ts:111`). That is a fine model for "the agent roster changed, refetch it" — which is exactly what `process-explorer` does (`apps/process-explorer/src/data.ts:162`).

It is a bad model for anything that *flows*. The highest-value flowing thing in the system is already produced frame by frame: `StreamToEventMapper` (`agents/session-policies/stream-to-event-mapper.ts`) turns every provider `StreamMessage` into `AGENT_RESPONSE` / `AGENT_THINKING` / `TOOL_PROGRESS` server events.

Phases 1–2 made that feed available to apps, including Process Explorer. The remaining practical gap is **fidelity and observer UX**: prove that Claude and Codex both reach the feed incrementally, make turn boundaries explicit, and distinguish provider-sized deltas from YAAR's intentional 60ms coalescing.

**This proposal generalizes `subscribe` from a ping into a feed:** a subscription may declare `mode: 'stream'`, and the server pushes typed **frames** with payloads instead of bare change pings.

---

## What this unlocks (why it's worth a channel, not a one-off)

Once a URI can stream frames, several unrelated features collapse into one mechanism:

- **Live agent observability.** `process-explorer` stops showing `busy/idle` and starts showing *what* — the current tool, the streaming text, the thinking. A CLI panel becomes an ordinary app instead of privileged frontend code.
- **Long-running verb progress.** `compile`, `deploy`, `browser` actions, `fetch` of a large body: today they're a blocking `invoke()` that returns once. Frames give apps a progress bar for free.
- **Tail-style sources.** Session log tail, `db` collection changes with the changed row attached, notification firehose — all become `stream(uri)` instead of poll-or-refetch.
- **App → app fan-out.** An app's declared event channels (from the app_events proposal) become subscribable *by other apps*, not just by agents — closing the last quadrant of the reactivity matrix.

The unifying claim: **one registry, one frame envelope, many sources.** If we build a bespoke socket for agent streaming, we will build a second one for verb progress six weeks later.

---

## Non-goals (and why)

This proposal is about **event streams** — low-rate JSON frames whose producer is the server. Adjacent concerns below are *deliberately* out of scope because they need different transport or model semantics.

**Streaming output into another model.** Agent-to-agent subscription is a different orchestration problem. Claude `streamInput()` and Codex `turn/steer` actively steer an in-flight turn; neither is a passive context feed with well-defined ordering, backpressure, or attention semantics. Token-by-token injection could destabilize the consuming turn or amplify one producer turn into many watcher turns. Phase 2.1 therefore streams only to user-facing/frontend/app observers. Agent consumption remains deferred until models and provider APIs expose a better primitive, and should get its own proposal if revisited.

**App → app data pipes.** A producer app streaming structured data to a consumer app should not round-trip through iframe → frontend → WS → server → WS → frontend → iframe. The right primitive is a **`MessageChannel` brokered by the frontend**: the server authorizes the connection, each iframe gets one end of a port, and the data then flows directly, zero-copy, with the server out of the loop. Same *handshake* as `subscribe` (URI + permission check), different thing handed back (a port, not frames). Worth building; not this doc.

**Media (camera / screen / canvas / audio).** Two facts make this a separate concern:

- Today an app **cannot** open a camera at all: `IframeRenderer.tsx:316` sets `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"` — no `camera`, `microphone`, or `display-capture`. Permissions Policy blocks `getUserMedia()` no matter what the app code does. **For a single app doing capture + `yaar-ml` inference in its own iframe, adding a gated entry to that `allow` list is the entire feature.** No streaming subscription is involved.
- Crossing an app boundary with media means `MediaStreamTrackProcessor` → `ReadableStream<VideoFrame>` → `postMessage(stream, [stream])` — transferables, zero-copy. That rides on the port broker above, where media is just a payload type.

**Do not push video through `StreamFrame.data`.** The 4KB payload cap and the drop-oldest queue will quietly turn a video feed into a corrupted slideshow. If a frame envelope ever needs to carry a media handle, it carries a *port*, not pixels.

**The agent cannot consume video.** It is a token model; the most it can ever receive is *sampled* frames — downscaled, encoded, ~1fps. That is a frame sampler emitting on an existing `app.emit()` channel, not a video stream. Anyone proposing "stream the camera to the agent" is really proposing a sampler; build it as one.

---

## Model

### App side

```ts
import { stream } from '@bundled/yaar';

const stop = await stream(`yaar://agents/${agent.id}/stream`, (frame) => {
  // frame: { uri, seq, kind, data, ts }
  if (frame.kind === 'tool')  showTool(frame.data.toolName, frame.data.status);
  if (frame.kind === 'text')  appendText(frame.data.delta);
});
// later
stop();
```

`stream(uri, onFrame, opts?)` mirrors `subscribe(uri, cb)` exactly — same `/api/verb/subscribe` endpoint, same iframe-token auth, same returned-unsubscriber shape. The only differences are `mode: 'stream'` in the request body and a payload in the push.

### Frame envelope

```ts
interface StreamFrame {
  uri: string;        // the source URI (may be more specific than the subscribed prefix)
  seq: number;        // monotonic per subscription — gap ⇒ frames were dropped
  kind: string;       // source-defined: 'text' | 'thinking' | 'tool' | 'progress' | 'event' | 'done'
  data: unknown;      // source-defined JSON, size-capped
  ts: number;
}
```

`kind` is source-defined rather than a closed enum, so a new stream source doesn't need a shared-package change. `seq` is what makes dropping honest: a consumer that sees `seq` jump from 8 to 12 *knows* it missed frames rather than silently rendering a hole.

### Stream sources

A source publishes frames under a URI. Proposed initial set:

| URI | Frames |
|---|---|
| `yaar://agents/{id}/stream` | `text` (delta), `thinking`, `tool` (name/status/input), `done` |
| `yaar://windows/{id}/events/{channel}` | `event` — fan-out of `app.emit()` to *app* subscribers |
| `yaar://dev/compile/{jobId}` etc. | `progress` — long-running verb steps |

The shipped agent and deploy sources are push-based and need no attach callback: they publish under a URI and the broker matches subscribers. A URI-pattern → attach-function source registry belongs under `streams/` only when a pull-style source lands; `describe`/`list` can then advertise which URIs are streamable.

### Provider normalization (already shipped)

Phase 2.1 begins at `StreamMessage`; observer code must not consume Claude SDK or Codex app-server events directly. Both providers already normalize incremental output into the same transport contract:

| Semantic event | Claude Agent SDK | Codex app-server | YAAR `StreamMessage` |
|---|---|---|---|
| Assistant text delta | `stream_event` → `content_block_delta` → `text_delta` | `item/agentMessage/delta` | `{ type: 'text', content }` |
| Reasoning delta | `thinking_delta` | `item/reasoning/textDelta` | `{ type: 'thinking', content }` |
| Tool begins | `content_block_start` (`tool_use`) | `item/started` with a tool item | `{ type: 'tool_use', ... }` |
| Tool finishes | SDK tool-result user message | `item/completed` with a tool item | `{ type: 'tool_result', ... }` |
| Turn finishes | `result` | `turn/completed` | `{ type: 'complete' | 'error' }` |

Claude requires `includePartialMessages: true`; YAAR sets it in `providers/claude/sdk-options.ts` and maps raw stream events in `providers/claude/message-mapper.ts`. Claude does not forward token-level deltas from a Claude-native subagent through its parent stream. YAAR monitor/app/session agents are separate provider sessions, so each is the main stream for its own turn; native subagent output remains complete-message-only.

Codex app-server sends server-initiated JSON-RPC notifications for thread, turn, and item lifecycles. YAAR already maps `item/agentMessage/delta` and `item/reasoning/textDelta` in `providers/codex/message-mapper.ts`; each `CodexProvider` has its own WebSocket connection and thread. `item/completed` remains authoritative for final item state, but completed assistant snapshots must not be emitted again after their deltas.

Codex additionally exposes command-output, plan, reasoning-summary, and collaboration item events. They are not required for Phase 2.1 response tracking. A later stream-kind expansion may map command output to `tool_output`, but provider-native notification names must stay below `AITransport`.

### Observer side

Apps already subscribe by the stable instance ID returned from `yaar://session/agents`. Phase 2.1 keeps that public API:

```ts
const stop = await stream(`yaar://agents/${agent.id}/stream`, onFrame, {
  kinds: ['start', 'text', 'tool', 'done', 'error'],
});
```

The missing observer primitive is a reliable turn boundary. Today Process Explorer can receive `text`, `tool`, and `done`, but it cannot reliably distinguish the first delta of a new turn from continuation of the previous text tail, and an interrupted provider stream may end without a stream terminal. Add provider-neutral start/finish methods around the query loop:

```ts
{
  kind: 'start',
  data: {
    messageId: string | undefined,
    provider: 'claude' | 'codex',
    monitorId: string | undefined
  }
}
```

`StreamToEventMapper.start()` should publish it from `AgentSession` immediately before consuming `provider.query()`. `finish(status)` publishes one idempotent `done` frame with `status: 'completed' | 'interrupted'`; provider errors remain terminal `error` frames. `AgentSession.finally` calls `finish()` so aborts cannot strand an observer in `responding`. These boundaries do not depend on a Claude message or Codex notification and therefore have identical semantics for both providers. Process Explorer clears the old text/tool state on `start`, appends every `text` delta for the current turn, and treats `done`/`error` as terminal.

The UI should describe this as **incremental** streaming, not token streaming. Both providers choose their own delta sizes, and YAAR intentionally merges deltas arriving within 60ms. Smoothness should be judged by time-to-first-update and update cadence, not one UI render per model token.

---

## Transport

Reuses the existing path end to end; no new socket, no new endpoint.

```
StreamToEventMapper.map(msg)                       [already produces frames]
  → streamHub.publish('yaar://agents/mon-1/stream', {kind:'text', data:{delta}})
  → SubscriptionRegistry: match subscribers (mode==='stream'), coalesce, seq++, size-cap
  → actionEmitter.emit('verb-subscription', { sessionId, event: STREAM_FRAME })
  → LiveSession.broadcast()                                                    (WS)
  → [frontend] server-event-dispatcher STREAM_FRAME → handlers.handleStreamFrame
  → iframe-bridge: postMessage { type:'yaar:stream-frame', subscriptionId, frame }
  → [iframe] verb-sdk listener → __yaarSubs[id](frame)
```

Every arrow already exists for the iframe path, and both Claude and Codex enter it through `StreamMessage`. Phase 2.1 does not add a new broker, socket, input channel, or agent delivery path.

To diagnose reports of block-sized updates without logging response content, add development-only counters at two seams:

1. provider mapper output: timestamp and character count for each `text` `StreamMessage`;
2. subscription delivery: timestamp and merged character count for each emitted `text` frame.

These measurements distinguish a provider that emitted one large delta from multiple source deltas intentionally coalesced by YAAR. They should be exposed through debug logging or test hooks, not added to the public frame payload.

---

## Guards (the part that decides whether this is safe)

A stream is a firehose pointed at a component that may be slow, so backpressure is a **design requirement**, not a hardening step.

1. **Coalescing per (subscription, kind).** `text` frames merge on a ~50–100ms tick into one delta; `tool` frames do not merge. This mirrors the 200ms `AGENT_THINKING` throttle already in `stream-to-event-mapper.ts:67`.
2. **Bounded buffering.** The shipped iframe path flushes a coalesced delta early rather than growing it without limit. Any later queued sink must drop oldest and expose the resulting `seq` gap.
3. **Payload cap** (4KB, matching app_events), truncated with a marker.
4. **Kind filter at subscribe time**, so a progress-bar app doesn't pay for token deltas.
5. **Turn boundaries.** Every observed turn begins with exactly one `start` and ends with exactly one `done` (completed/interrupted) or `error`.
6. **Teardown on window/session close** — unsubscribing or closing the observing window clears pending coalesced frames and timers.

### Access control

`yaar://agents/{id}/stream` is a **transcript**: user prompts, thinking, tool inputs, tool results. It is strictly more sensitive than the roster that `yaar://session/agents` already exposes to any app.

The access-tier system (`ResourceRegistry.execute()` + `access: 'session-principal'`) gives us the lever, and `POST /api/verb` already hard-refuses `yaar://session/*` for apps. The question is where to set it:

- **(a) Session-principal only** — only the session agent may stream any agent. Safest; kills the process-explorer and CLI-app use cases dead.
- **(b) Same-session apps may stream monitor/app agents; the *session* agent's stream stays session-principal.** The session agent is the tier that can drive the user's real browser, so its transcript is the crown jewel; monitor-agent transcripts are already half-visible in the CLI panel the user can open with Shift+Tab.
- **(c) Declared intent** — an app must declare `"streams": ["agents"]` in `app.json`, bundled-apps-only, mirroring the existing `controls` guard in `features/apps/discovery.ts`.

**Recommend (b) + (c) together**: bundled-app declaration for the capability, session-principal for the session agent's own stream. That keeps `process-explorer` working without handing an arbitrary marketplace app a live tap on everything the user types.

**Resolved: (b)+(c) shipped in Phase 2.** An app declares `"streams": ["agents"]` in its (bundled-only) app.json; the declaration rides the iframe token (`discovery.getAppMeta` → `iframe-tokens` → `access.AppPrincipal.streams`) and is enforced by `requireStream()` in the `/api/verb/subscribe` route. The session agent's own stream is shielded there outright (a `403`, resolved against the live pool's `getSessionAgent().instanceId`).

---

## Change inventory

### Shipped (Phase 1)

**Shared** (`packages/shared`)
- `events.ts` — `ServerEventType.STREAM_FRAME` + `StreamFrame` / `StreamFrameEvent { windowId, subscriptionId, frame }`.
- `iframe-scripts/verb-sdk.ts` — `window.yaar.stream(uri, onFrame, {kinds})`; handles `yaar:stream-frame`; passes `mode`/`kinds` through the subscribe endpoint.

**Server** (`packages/server`)
- `http/subscriptions.ts` — `mode: 'change' | 'stream'`, `kinds?`, per-sub `seq`, 4KB `capPayload`, `publishFrame(uri, kind, data, sessionId)`. `notifyChange` skips stream subs so the modes never cross wires. **Deferred:** coalescer + bounded drop-oldest queue (Guards 1–2) — unneeded for the single low-rate deploy source, mandatory before the Phase 2 agent stream.
- `http/routes/verb.ts` — accepts `mode`/`kinds` on `/api/verb/subscribe`; `yaar://dev/*` streams ride the `yaar-dev` bundle gate, everything else keeps the `read` gate.
- **`streams/stream-hub.ts` (new)** — `publishFrame` producer seam. **Deferred:** the URI-pattern → attach-function source *registry* (belongs here once there's more than one source).
- `features/dev/deploy.ts` + `http/routes/dev.ts` — the Phase 1 source: `doDeploy` emits `progress`/`done`/`error` frames to `yaar://dev/deploy/{appId}`; the route passes `principal.sessionId`.
- `tests/stream-subscriptions.test.ts` — transport-core guarantees (seq, kind filter, session scope, cap, mode isolation).

**Frontend** (`packages/frontend`)
- `use-agent-connection/server-event-dispatcher.ts` — `STREAM_FRAME` → `handleStreamFrame`.
- `store/iframe-bridge.ts` — `handleStreamFrame` posts `yaar:stream-frame` (mirror of the ping path).

**Compiler** (`packages/compiler`)
- `shims/yaar.ts` + `bundled-types/index.d.ts` — export `stream(uri, onFrame, opts?)` + `StreamFrame`.

### Shipped (Phase 2)

**Server** (`packages/server`)
- `agents/session-policies/stream-to-event-mapper.ts` — one `emitStreamFrame(...)` call per case (`text`/`thinking` deltas, `tool`, `done`, `error`); additive, the `sendEvent` path is untouched. `instanceId` + `liveSessionId` threaded from `AgentSession`.
- `streams/agent-stream.ts` (new) — `buildAgentStreamUri`/`parseAgentStreamUri` for `yaar://agents/{instanceId}/stream` (keyed by the roster's `AgentEntry.id`).
- `http/subscriptions.ts` — the coalescer (Guard 1: `text`/`thinking` merge on a 60ms tick, lossless → one `seq`) + early-flush bound (Guard 2, done as flush-not-drop since merging is lossless); discrete frames flush pending deltas first, then deliver immediately; teardown clears pending on unsubscribe.
- `features/apps/discovery.ts` + `http/iframe-tokens.ts` + `http/access.ts` — `streams` capability (bundled-only) rides the iframe token; `requireStream()` gate.
- `http/routes/verb.ts` — subscribe gate: session-agent stream shielded (403), rest requires `streams:["agents"]`.
- `tests/` — `agent-stream-source.test.ts`, `agent-stream-access.test.ts`, coalescing cases in `stream-subscriptions.test.ts`.

**Consumer**
- `apps/process-explorer` — declares `streams:["agents"]`; reconciles a `stream()` per non-session agent as the roster changes; folds frames into an `agentActivity` store; renders a live tool/text line per agent row.

### Shipped (Phase 2.1)

**Server** (`packages/server`)
- `streams/agent-stream.ts` — `'start'` added to `AgentStreamKind`; `AgentTurnStatus` + `AgentStartFrameData`.
- `agents/session-policies/stream-to-event-mapper.ts` — `start()` / `finish(status)` / `fail(error)`, each latched so a turn publishes exactly one open and one terminal. The provider's `complete` now calls `finish('completed')` and its `error` calls `fail(...)`, so the provider path and the session path share one latch instead of racing to close.
- `agents/agent-session.ts` — the mapper is hoisted out of the `try` so `catch` can `fail()` and `finally` can `finish(this.interrupted ? 'interrupted' : 'completed')`. `start()` fires immediately before `provider.query()` is consumed. Interrupts and throws can no longer strand an observer in `responding`.
- **`streams/stream-diagnostics.ts` (new)** — opt-in (`YAAR_STREAM_DIAG=1` or `setStreamDiagnosticsEnabled`) cadence sampling at two seams: `recordSourceDelta` in the mapper (pre-coalescing, provider chunk size) and `recordDeliveredFrame` in `subscriptions.deliverFrame` (post-coalescing). Counts and timestamps only — never content — with a 500-sample ring per seam.
- `tests/provider-delta-parity.test.ts` (new) — Claude `text_delta` and Codex `item/agentMessage/delta` normalize to the same ordered `text` contract; the `assistant` snapshot and `item/agentMessage/completed` do not re-emit streamed text.
- `tests/agent-stream-source.test.ts` — `start → text/tool → done` for both provider-normalized turns, plus double-`start`/double-`finish` idempotence, the interrupted turn with no provider terminal, and `error` suppressing a later `done`.
- `tests/stream-diagnostics.test.ts` (new) — six source samples collapse to one delivered `text` frame with the characters preserved (coalescing, not a provider block), and no sample carries content.

**Consumer**
- `apps/process-explorer` — subscribes to `start`/`error` as well; `start` *replaces* the activity record (per-turn reset); explicit `responding` / `using-tool` / `done` / `error` state with `interrupted` surfaced distinctly; `updatedAt` from `frame.ts` rendered as elapsed time against a 1s clock.

### Remaining

**Server** (`packages/server`)
1. `streams/` — a URI-pattern → attach-function source registry, once a pull-style source or app-channel fan-out lands. *(Phase 4)*

**Consumers**
1. `apps/devtools` — a live deploy-progress bar consuming the Phase 1 `yaar://dev/deploy/{appId}` frames; (later) a CLI-panel app. *(Phase 4 consumer)*

---

## Phasing

- **Phase 1 — Envelope + transport. ✅ Shipped.** `mode:'stream'` on the registry, `STREAM_FRAME` event, frontend hop, `yaar.stream()` SDK, and one real source (deploy progress via `yaar://dev/deploy/{appId}`) to prove the pipe without touching agent auth. `seq` + payload cap + kind filter landed; coalescing + drop-oldest deferred to Phase 2 (the deploy source doesn't need them).
- **Phase 2 — Agent stream source. ✅ Shipped.** `emitStreamFrame` in `StreamToEventMapper`, coalescing (Guard 1) + early-flush bound (Guard 2), access gate (b)+(c). Consumer: `process-explorer` live view.
- **Phase 2.1 — Provider parity + observer UX. ✅ Shipped.** Provider-neutral latched `start`/`done` boundaries published from the query loop (so interrupts close too), Claude/Codex delta parity pinned in tests, Process Explorer's per-turn state made explicit, and opt-in non-content cadence diagnostics at the source and delivery seams.
- **Phase 3 — Agent-side stream subscriptions. Deferred.** Streaming output into another model is not part of observer streaming. Revisit only with a provider/model primitive designed for passive, bounded external context—not `streamInput()` or `turn/steer` token injection.
- **Phase 4 — App-channel fan-out.** `yaar://windows/{id}/events/{channel}` streams `app.emit()` to app subscribers, completing the app_events matrix.

Phase 2.1 is independently useful and keeps all delivery user-facing. Phase 3 is intentionally not a prerequisite.

---

## Phase 2.1 acceptance criteria

1. Claude `text_delta` and Codex `item/agentMessage/delta` produce the same ordered `text` `StreamMessage` contract; provider-completed assistant snapshots do not duplicate text.
2. Every observed turn emits exactly one `start` before `text`, `tool`, `done`, or `error`, for both providers.
3. Process Explorer clears the previous text/tool state on `start` and visibly updates before `done` for a multi-delta response.
4. Text frames retain ordering around tool frames and preserve monotonic `seq` values after coalescing.
5. Development diagnostics can distinguish source delta cadence from the 60ms delivery cadence without recording response content.
6. Existing iframe access controls, session scoping, payload caps, and teardown behavior remain unchanged.
7. Focused stream tests, Process Explorer build/typecheck, and server typecheck pass under both provider mappings.

## Deferred decisions

1. **Agent-to-agent subscriptions.** Separate proposal, deferred until passive bounded streaming input is a credible model/provider capability.
2. **Replay after subscribe/reconnect.** Streams remain from-now-only. A bounded `since: seq` replay window can be added later.
3. **Codex extended item streams.** Command-output, plan, and reasoning-summary deltas may become new kinds after response tracking is solid.
4. **Does `stream` subsume change `subscribe`?** Keep both public names; payload streams and invalidation pings have different consumer behavior.
5. **Cross-reconnect lifetime.** App stream subscriptions are runtime state and are not persisted.
