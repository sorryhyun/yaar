# Proposal: Stream Subscriptions (Push-with-Payload Channels)

**Status:** Draft for review
**Sibling of:** [`app_events_subscribe_proposal.md`](./app_events_subscribe_proposal.md) — that one adds **app → agent** push. This one adds **server/agent → app (and agent → agent)** *streaming* push.

---

## Motivation

YAAR has two reactive edges today, and both are **discrete, single-shot**:

| Direction | Mechanism | Payload? |
|---|---|---|
| app → agent | `app.emit(channel, payload)` (app_events, Phases 1–3 landed) | yes, one shot |
| server → app | `yaar.subscribe(uri, cb)` (`http/subscriptions.ts`) | **no — just a ping** |

`subscribe()` is a change *notification*: the callback receives a URI string and the app must re-`read()` the whole resource (`verb-sdk.ts:65`, `subscriptions.ts:111`). That is a fine model for "the agent roster changed, refetch it" — which is exactly what `process-explorer` does (`apps/process-explorer/src/data.ts:162`).

It is a bad model for anything that *flows*. And the highest-value flowing thing in the system is already being produced, frame by frame, and thrown at exactly one consumer: `StreamToEventMapper` (`agents/session-policies/stream-to-event-mapper.ts`) turns every provider `StreamMessage` into `AGENT_RESPONSE` / `AGENT_THINKING` / `TOOL_PROGRESS` server events — which reach the **frontend CLI panel and nothing else**. An app cannot see what the agent is doing. An agent cannot see what another agent is doing.

There is no way, today, to say *"push me the frames as they happen."*

**This proposal generalizes `subscribe` from a ping into a feed:** a subscription may declare `mode: 'stream'`, and the server pushes typed **frames** with payloads instead of bare change pings.

---

## What this unlocks (why it's worth a channel, not a one-off)

Once a URI can stream frames, several unrelated features collapse into one mechanism:

- **Live agent observability.** `process-explorer` stops showing `busy/idle` and starts showing *what* — the current tool, the streaming text, the thinking. A CLI panel becomes an ordinary app instead of privileged frontend code.
- **Agent watching agent.** A supervisor/session agent subscribes to a monitor agent's stream in `buffer` mode and sees the transcript on its next turn — oversight without polling `yaar://session/agents`.
- **Long-running verb progress.** `compile`, `deploy`, `browser` actions, `fetch` of a large body: today they're a blocking `invoke()` that returns once. Frames give apps a progress bar for free.
- **Tail-style sources.** Session log tail, `db` collection changes with the changed row attached, notification firehose — all become `stream(uri)` instead of poll-or-refetch.
- **App → app fan-out.** An app's declared event channels (from the app_events proposal) become subscribable *by other apps*, not just by agents — closing the last quadrant of the reactivity matrix.

The unifying claim: **one registry, one frame envelope, many sources.** If we build a bespoke socket for agent streaming, we will build a second one for verb progress six weeks later.

---

## Non-goals (and why)

This proposal is about **event streams** — low-rate JSON frames whose producer is the server. Two adjacent things are *deliberately* out of scope, because they need a different transport and would be silently broken by this one.

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

const stop = await stream('yaar://agents/monitor-1/stream', (frame) => {
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

### Stream sources (registry, not hardcodes)

A source is a URI pattern plus an attach function. Proposed initial set:

| URI | Frames |
|---|---|
| `yaar://agents/{id}/stream` | `text` (delta), `thinking`, `tool` (name/status/input), `done` |
| `yaar://windows/{id}/events/{channel}` | `event` — fan-out of `app.emit()` to *app* subscribers |
| `yaar://dev/compile/{jobId}` etc. | `progress` — long-running verb steps |

The registry lives next to `ResourceRegistry` (`handlers/uri-registry.ts`) and reuses its URI parsing, so `describe`/`list` can advertise which URIs are streamable.

### Agent side

The same source registry backs an agent-facing subscription, reusing `WindowSubscriptionPolicy`'s delivery machinery (which the app_events work already generalized from the `WindowChangeEvent` enum to arbitrary channel strings):

```
invoke('yaar://agents/{id}', { action: 'subscribe_stream', kinds: ['tool','done'], mode: 'buffer' })
```

- **`buffer`** is the *default and strongly recommended* mode for agents — frames fold into the subscriber's next turn via `InteractionTimeline.pushRaw` (the Phase-3 path). Streaming another agent's tokens in `wake` mode is a turn-amplification footgun: one agent's stream would wake the watcher hundreds of times.
- **`wake`** should be allowed only for coarse kinds (`done`, `error`), and probably gated behind an explicit `kinds` filter so it can't be opened onto `text`.

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

Every arrow already exists for the ping case (`subscriptions.ts:111` → `live-session` `'verb-subscription'` listener → `server-event-dispatcher.ts:278` → `iframe-bridge.ts:259` → `verb-sdk.ts:57`). We are widening the envelope, not laying new pipe.

For agent subscribers the last three hops are replaced by `WindowSubscriptionPolicy` → `InteractionTimeline.pushRaw` (buffer) or `pool.handleTask` (wake), exactly as in app_events Phase 2/3.

---

## Guards (the part that decides whether this is safe)

A stream is a firehose pointed at a component that may be slow, so backpressure is a **design requirement**, not a hardening step.

1. **Coalescing per (subscription, kind).** `text` frames merge on a ~50–100ms tick into one delta; `tool` frames do not merge. This mirrors the 200ms `AGENT_THINKING` throttle already in `stream-to-event-mapper.ts:67`.
2. **Bounded queue, drop-oldest.** Per-subscription cap (e.g. 200 frames). Dropping bumps `seq` so the consumer sees the gap. **Never** buffer unboundedly for a slow iframe.
3. **Payload cap** (4KB, matching app_events), truncated with a marker.
4. **Kind filter at subscribe time**, so a progress-bar app doesn't pay for token deltas.
5. **Self-stream suppression** for agent subscribers — an agent never receives its own stream (same `subscriberAgentKey === sourceAgentKey` skip as `window-subscription-policy.ts:110`).
6. **Teardown on window/session close** — already free via `clearForWindow` / `clearForSession` (`subscriptions.ts:87`).

### Access control (open question, and the sharpest one)

`yaar://agents/{id}/stream` is a **transcript**: user prompts, thinking, tool inputs, tool results. It is strictly more sensitive than the roster that `yaar://session/agents` already exposes to any app.

The access-tier system (`ResourceRegistry.execute()` + `access: 'session-principal'`) gives us the lever, and `POST /api/verb` already hard-refuses `yaar://session/*` for apps. The question is where to set it:

- **(a) Session-principal only** — only the session agent may stream any agent. Safest; kills the process-explorer and CLI-app use cases dead.
- **(b) Same-session apps may stream monitor/app agents; the *session* agent's stream stays session-principal.** The session agent is the tier that can drive the user's real browser, so its transcript is the crown jewel; monitor-agent transcripts are already half-visible in the CLI panel the user can open with Shift+Tab.
- **(c) Declared intent** — an app must declare `"streams": ["agents"]` in `app.json`, bundled-apps-only, mirroring the existing `controls` guard in `features/apps/discovery.ts`.

**Recommend (b) + (c) together**: bundled-app declaration for the capability, session-principal for the session agent's own stream. That keeps `process-explorer` working without handing an arbitrary marketplace app a live tap on everything the user types.

---

## Change inventory

**Shared** (`packages/shared`)
1. `events.ts` — `ServerEventType.STREAM_FRAME` + `StreamFrameEvent { windowId, subscriptionId, frame }`.
2. `iframe-scripts/verb-sdk.ts` — handle `yaar:stream-frame`; pass `mode`/`kinds` through `subscribe`.

**Server** (`packages/server`)
3. `http/subscriptions.ts` — `mode: 'change' | 'stream'`, `kinds?`, per-sub `seq`, coalescer + bounded queue, `publishFrame(uri, frame, sessionId)`.
4. `http/routes/verb.ts` — accept `mode`/`kinds` on `/api/verb/subscribe`; enforce the access gate above.
5. **`streams/` (new)** — stream-source registry + `streamHub`. Sources: agent stream, app-channel fan-out, verb progress.
6. `agents/session-policies/stream-to-event-mapper.ts` — one `streamHub.publish(...)` call per case (additive; the existing `sendEvent` path is untouched).
7. `agents/context-pool-policies/window-subscription-policy.ts` — accept stream sources as subscribable channels (mostly free after the app_events generalization).
8. `handlers/agents.ts` — `subscribe_stream` / `unsubscribe_stream` actions; advertise streamability in `describe`.

**Frontend** (`packages/frontend`)
9. `use-agent-connection/server-event-dispatcher.ts` — `STREAM_FRAME` → `handleStreamFrame`.
10. `store/iframe-bridge.ts` — `postMessage('yaar:stream-frame')` (mirror of `:259`).

**Compiler** (`packages/compiler`)
11. `shims/yaar.ts` + `bundled-types/` — export `stream(uri, onFrame, opts?)`.

**Consumers**
12. `apps/process-explorer` — live tool/text per agent instead of busy/idle.
13. (later) a CLI-panel app; `apps/devtools` progress frames.

---

## Phasing

- **Phase 1 — Envelope + transport.** `mode:'stream'` on the registry, `STREAM_FRAME` event, frontend hop, `yaar.stream()` SDK. Ship with **one** trivial source (verb progress from `compile`) to prove the pipe without touching auth.
- **Phase 2 — Agent stream source.** `streamHub.publish` in `StreamToEventMapper`, coalescing + drop-oldest + `seq`, access gate (b)+(c). Consumer: `process-explorer` live view.
- **Phase 3 — Agent-side stream subscriptions.** `subscribe_stream` in `buffer` mode, reusing `WindowSubscriptionPolicy` + `InteractionTimeline`. Unlocks agent-watching-agent.
- **Phase 4 — App-channel fan-out.** `yaar://windows/{id}/events/{channel}` streams `app.emit()` to app subscribers, completing the app_events matrix.

Phases 1 and 2 are independently useful; Phase 3 is the one with real footgun potential and should not ship before the buffer-mode default is enforced.

---

## Open decisions

1. **Access tier for agent streams** — (a) / (b) / (c) above. *This one blocks Phase 2.* (Recommend b+c.)
2. **Frame envelope: closed `kind` enum vs source-defined string?** (Recommend string — avoids a shared-package change per new source.)
3. **Replay on subscribe** — does a new subscriber get the last N frames, or only frames from now on? (Recommend: from-now-only in Phase 1; a `since: seq` replay window is a clean later add and is what makes reconnect survivable.)
4. **Does `stream` subsume `subscribe`?** A change-ping is just a stream with `kind:'change'` and no data. Tempting to unify, but `subscribe()` is already used by shipped apps — recommend keeping both names, one registry underneath.
5. **Do frames survive reconnect?** Subscriptions are keyed by `windowId` and torn down on window close; a WS reconnect that preserves the session should arguably preserve stream subs. Ties to #3.
