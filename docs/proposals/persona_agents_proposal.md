# Proposal: Persona Agents — app-spawned AI instances (and a ChitChats-class chat room app)

**Status:** Phase 1 landed (the primitive). Phase 2/3 (the ChitChats port) not started —
see [What shipped](#what-shipped) for the delta between this document and the code.
**Reframed by:** [`agent_hierarchy_proposal.md`](./agent_hierarchy_proposal.md) — the agent-tree
redesign, in which the persona primitive is the `compute` grade of app-tier sub-agents.
**Scope:** `packages/server` (agent pool, new verb surface, stream access), `packages/shared` (SDK), one new bundled app (`apps/chitchats`)
**Driving use case:** porting the feature set of [`chitchats-public`](https://github.com/sorryhyun/chitchats-public) — a multi-character AI chat room — into YAAR as a bundled app.

## Summary

Let a (bundled) app spawn N **persona agents**: lightweight, tool-less AI instances, each
with a caller-supplied system prompt, each a real provider session with its own conversation
memory, each streamable token-by-token into the app's iframe. A new manifest field opts in:

```json
{ "personas": { "max": 4 } }
```

On top of this primitive, build `apps/chitchats`: rooms of AI characters that converse with
the user and each other — turn scheduling in the iframe, personas doing the talking,
`appDb`/`appStorage` doing the remembering.

The primitive is the point; the app is the proof. In the OS metaphor, apps (processes)
finally get threads.

## What shipped

Phase 1 landed close to the design below, in ~600 lines of server code across six files plus
tests. Where the code differs from this document, the code is right and the difference is here:

| Design (below) | As built | Why |
|---|---|---|
| Pool tier keyed `{monitorId}::{appId}::{personaId}` | Same, and the key is never parsed back out — `PersonaAgent` carries `{appId, monitorId, personaId}` as fields | The record shape the multi-window proposal §2 also wants |
| `spawn` errors when the persona exists | **Idempotent**: hands back the live persona with `reused: true`, ignoring the new prompt | An iframe reload re-runs the app's spawn calls; refusing costs the app its cast, and swapping the prompt under a live conversation rewrites who the persona has been. Delete and respawn to recast |
| Ownership via `self` resolution | `self` resolution *plus* an appId-in-URI vs. appId-in-context equality check | The permission list says what you may ask for; ownership says whose personas they are. An app cannot forge its context appId, so the second check is the load-bearing one |
| `done` frame gains `{ text }` | Done — on **every** agent's stream, not just personas | It is the same mapper; an interrupted turn carries its partial text too |
| Queue-or-reject when busy | **Reject**, with `busy: true` on the envelope | The app's scheduler is the only thing that knows whether a second message is a follow-up or a race |
| Personas disposed when the app's last window closes | Same, asked of the window registry rather than `AppTaskProcessor.activeWindows` | That map tracks the most-recently-active window and is cleared by the close itself — reading it would report "no windows left" with a second window still open |
| SDK sugar in `@bundled/yaar` (`yaar.agents.*`) | **Not built.** Apps use `invoke`/`list`/`del` + the existing `yaar.stream()` | The verb calls are already one line each; sugar can follow a second consumer |
| §1.3 "verify the Claude path drops WebSearch/Task" | Verified and pinned by a test against the real `buildSDKOptions` | `allowedTools: []` yields no MCP servers, no `WebSearch`, no `Task`. `undefined` yields all of them — the test asserts both halves |

Open question 2 (per-persona model tier) is answered by `spawn`'s optional `model`, with no
default change. Questions 1, 3, 4, and 5 stand as written.

**Not built:** `apps/chitchats` (Phase 2/3). In its place is `apps/personas` ("Round Table"),
a ~700-line bundled app that is the primitive's proof rather than the ChitChats port: a cast of
characters, each a persona, all answering one message concurrently with live streaming and a
thinking fold, persisted in `appDb`. The tape executor, interrupt-weave, `[[skip]]` convergence,
and per-room scheduling are Phase 2/3 and remain unwritten.

## Motivation

ChitChats (~30k LOC standalone: FastAPI + React + per-character Claude/Codex subprocess
pools + SSE + JWT + rate limiting) is, capability-wise, a thin feature riding on heavy
platform plumbing — and YAAR already *is* that plumbing. Rooms/messages map to `appDb`,
character files and avatars to `appStorage`, SSE token streaming to the existing
`yaar://agents/{id}/stream` + `yaar.stream()` pipeline (already coalesced at 60ms —
`http/subscriptions.ts`), auth/rate-limiting/provider-management to the platform itself.
The port should land around 2–4k LOC of app code.

Exactly one capability is missing, and it is the heart of the feature: **N distinct agents
with distinct system prompts owned by one app.** Today an app gets precisely one agent.

The primitive is not chat-specific. Any app that wants a worker/judge/critic/translator
pattern — a code reviewer spawning adversarial checkers, a writing app spawning an editor
persona, a game spawning NPCs — needs the same thing: "give me a cheap, isolated,
custom-prompted AI instance I can talk to and stream from."

## Current state (verified)

Why this cannot be built as an app today:

- **One agent per app, no spawn path.** `AgentPool` has four tiers; app agents are keyed
  strictly `{monitorId}::{appId}` (`agents/agent-pool.ts` — `appAgentKey`,
  `getOrCreateAppAgent`). The only fresh-agent path, `createEphemeral()`, is called solely
  from `monitor-task-processor.ts` as a busy-monitor fallback, reuses the monitor's own
  profile, and takes no system prompt.
- **System prompts are install-time artifacts.** `buildAppAgentProfile(appId)`
  (`agents/profiles/app-agent.ts`) reads `AGENTS.md`/`SKILL.md` from disk and is cached
  per-appId. No API anywhere in `handlers/` or `mcp/` accepts a runtime system prompt.
- **`direct_message` addresses, never spawns.** `parseTarget()`
  (`mcp/messaging/index.ts`) recognizes only `user` / `monitor` / `monitor:{id}` /
  `app:{appId}` / `window:{id}` — all pre-existing.
- **The one app→AI trigger always hits the same agent.** `sendInteraction`
  (`shared/src/iframe-scripts/app-protocol.ts`) → `APP_INTERACTION` →
  `AppTaskProcessor.handleAppTask()` resolves the single persistent app agent. Firing
  "parallel" tasks at it is unsafe: `AgentSession` keeps shared mutable turn state
  (`running`, `currentRole`, `currentMessageId`, `recordedActions` —
  `agents/agent-session.ts`), so concurrent turns clobber each other.
- **The streaming half already exists and is exactly right.** `StreamToEventMapper`
  publishes every provider `StreamMessage` to `yaar://agents/{instanceId}/stream`
  (`streams/agent-stream.ts` — frame kinds `start | text | thinking | tool | done |
  error`); `window.yaar.stream()` (`shared/src/iframe-scripts/verb-sdk.ts`) delivers
  frames into the iframe. Access is gated by `requireStream(principal, 'agents')`
  (`http/routes/verb.ts`), honored only for `streams: ["agents"]` on **bundled** apps
  (`features/apps/discovery.ts` — same source gate as `controls`).
- **The existing agents verb surface is session-principal only.** `yaar://session/agents/*`
  (`handlers/agents.ts`) does list/read/interrupt/dispose — but `yaar://session/*` is
  hard-refused for app principals and `POST /api/verb`. The new surface must live in app
  territory, and `yaar://apps/self/…` already has the right ownership semantics (the
  auto-granted `yaar://apps/self/storage/` precedent in `http/access.ts`).

What ChitChats needs that YAAR already provides, for the record: per-character session
continuity (provider sessions resume across turns), live thinking display (`thinking`
frames), persistence (`appDb` Mongo-style collections, `appStorage` with base64 image
read), audio (iframes get `allow-scripts` everywhere; `speechSynthesis`/WebAudio work),
transcript export (`session_logs/`).

## Design

### Part 1 — the primitive

#### 1.1 Manifest flag

```json
{ "personas": { "max": 4 } }
```

Parsed into `AppInfo` (`features/apps/discovery.ts`), honored **only for `source:
'bundled'` apps**, exactly like `controls` and `streams`. `max` caps live personas per
(monitor, app); absent field means zero (no behavior change for any existing app).
An app using personas will in practice also declare `"streams": ["agents"]` to watch them.

#### 1.2 Verb surface: `yaar://apps/self/agents`

App-principal territory, callable from the iframe via `POST /api/verb` (and by the app's
own agent through the same handlers). Registered alongside the existing
`yaar://apps/*` handlers (`handlers/apps/`):

```ts
list('yaar://apps/self/agents')
// → [{ personaId, instanceId, busy, createdAt }]

invoke('yaar://apps/self/agents', { action: 'spawn', personaId, systemPrompt, model? })
// → { personaId, instanceId }   — instanceId is what yaar.stream() takes

invoke('yaar://apps/self/agents/{personaId}', { action: 'message', content })
// → { taskId }                  — returns immediately; completion arrives on the stream

invoke('yaar://apps/self/agents/{personaId}', { action: 'interrupt' })

read('yaar://apps/self/agents/{personaId}')
// → { busy, instanceId, lastResponse }   — polling fallback if a done frame was missed

delete('yaar://apps/self/agents/{personaId}')
```

`self` resolves to the calling principal's appId on both the HTTP and MCP paths — an app
can never name another app's personas. The final text of a turn rides in the `done`
frame's data (today `done` carries `{ ts }`; add `{ text }`), so the streaming iframe needs
no second round-trip; `read` covers reconnects.

#### 1.3 Pool: a fifth tier

```ts
personaAgents: Map<`${monitorId}::${appId}::${personaId}`, PooledAgent>
```

- **Monitor-scoped like app agents** — the spawning app's agent/window determines
  `monitorId`; nothing crosses monitors. Entries store `{ appId, monitorId, personaId }`
  records rather than re-parsing keys (the multi-window proposal §2 makes the same move
  for the same reason; if both land, coordinate on the record shape).
- **Profile is caller-supplied and minimal.** `buildPersonaProfile(systemPrompt, model?)`:
  the given system prompt verbatim, **no MCP tools, no verb access, no window tools** — a
  persona is compute-only. It receives text, thinks, returns text. This is the key safety
  property: a runtime-supplied system prompt never gets hands. (Providers must be started
  tool-less — `TransportOptions` already carries tool config; verify the Claude path drops
  WebSearch/Task for persona profiles.)
- **One turn at a time per persona**, enforced with a per-persona queue (or
  reject-if-busy, see open questions). *Across* personas, turns run genuinely
  concurrently — each persona is its own `AgentSession`, so the shared-turn-state hazard
  above doesn't apply.
- **Limits.** Personas draw from the global `MAX_AGENTS` semaphore (`agents/limiter.ts`)
  like everyone else, plus the manifest `max` per (monitor, app). A 4-character room costs
  session + monitor + app agent + 4 personas ≈ 7 of 10 default slots — workable, tight;
  spawn returns a clean "agent limit reached" error the app can surface. Warm pool makes
  spawn cheap (`acquireWarmProvider()`).
- **Lifecycle.** Personas are disposed explicitly (`delete`), when their owning app's last
  window on that monitor closes (hook into the same teardown that
  `window-event-coordinator.ts` runs), and by `disposeAppAgentsForMonitor`-equivalent on
  monitor removal. They do **not** persist across sessions — persistence is the app's job
  (appDb); a respawned persona gets its recent history replayed in its first message,
  which is exactly ChitChats' session-recovery behavior.
- **Streaming.** `spawn` returns the `instanceId`; the iframe subscribes to
  `yaar://agents/{instanceId}/stream` through the existing gate. One addition to
  `requireStream`: an app may stream an agent **it owns** (its own app agent or its
  personas) even if we later tighten the blanket `agents` stream scope.
- **Observability.** `agentRole` = `persona-${appId}-m${monitorId}-${personaId}`;
  `listAgents()` and `yaar://session/agents` report the new tier; session logs get one
  JSONL per persona like any agent.

#### 1.4 SDK sugar (`@bundled/yaar`)

Thin wrappers in the shim (`packages/compiler/src/shims/yaar.ts`), nothing the verb calls
don't already do:

```ts
const p = await yaar.agents.spawn({ personaId: 'alice', systemPrompt });
const stop = yaar.agents.watch(p, ({ kind, data }) => { /* text/thinking deltas, done */ });
await yaar.agents.message(p, 'Bob said: ...');
await yaar.agents.dispose(p);
```

### Part 2 — the app (`apps/chitchats`)

A bundled app with `"personas": { "max": 4 }`, `"streams": ["agents"]`. What ports from
ChitChats, and where each piece lands:

| ChitChats | YAAR home |
|---|---|
| Room / character / message tables (SQLAlchemy) | `appDb` collections `rooms`, `characters`, `messages` |
| Character markdown folders + profile pics | `appStorage` (`characters/{name}/…` + avatar images) |
| Per-character provider session (`RoomAgentSession`) | one persona agent per character in the open room |
| System prompt builder (`prompt_builder.py`) | iframe assembles prompt from character doc at spawn |
| Turn tape (`tape/generator.py`, `executor.py`) | **deterministic JS in the iframe** — mention-first → priority → shuffle → interrupt weave → capped follow-up rounds; it ports nearly line-for-line, it's scheduling code, not AI |
| Per-agent context windowing (messages since your last turn) | iframe includes new-since-last-turn messages, speaker-labeled, in each `message` call — persona session memory carries the rest |
| SSE streaming + thinking display | `yaar.stream()` frames → per-character chat bubble with live thinking fold |
| `skip` MCP tool | output sentinel (persona answers `[[skip]]`), personas stay tool-less |
| Interrupt on new user message | `invoke(..., { action: 'interrupt' })` per busy persona, then reschedule |
| 1:1 direct chat | a room with one character — same code path (ChitChats does the same) |
| TTS voice server | `speechSynthesis` in-iframe (v1); real TTS later if wanted |

The app's own **app agent** (via `AGENTS.md`) is the natural-language concierge — "make me
a grumpy pirate character", "summarize this room" — writing character docs into
`appStorage` and driving the app protocol. The iframe never needs it for the room loop.

**Deliberately not ported:** JWT auth + rate limiting (platform-owned), per-room provider
selection (YAAR's provider is server-wide), Postgres path, critic agents, the standalone
voice server, `generated_images` plumbing.

## What does NOT change

- Apps without `personas` in their manifest: zero behavioral change.
- The monitor-scoping invariant — personas belong to one monitor, no cross-monitor route.
- The app agent tier, `AppTaskProcessor`, steering, `activeWindows` — untouched; personas
  are a parallel tier, orthogonal to the multi-window (`windowMode`) proposal.
- The access model: personas hold no principal, no tools, no permissions; only their
  owning app can address them; `yaar://session/*` stays session-principal.
- OS Actions schema, WebSocket events, frontend — the stream pipeline already exists;
  no frontend changes at all.

## Implementation sketch

Phase ordering is the point: the primitive ships and is testable before the app exists.

**Phase 1 — primitive (server + shared, ~400–500 lines)**
1. `features/apps/discovery.ts` — parse `personas` (bundled-only, like `controls`).
2. `agents/agent-pool.ts` — `personaAgents` tier, spawn/get/dispose, limiter + per-app cap.
3. `agents/profiles/persona.ts` — tool-less profile from caller prompt; verify provider
   starts with no tools.
4. `handlers/apps/agents-resource.ts` — the verb surface (§1.2), registered in the
   existing `yaar://apps/*` registration.
5. `streams` — carry final text on the `done` frame; ownership-based `requireStream` allowance.
6. Teardown hooks (window close / monitor removal) + `listAgents` reporting.
7. Shim sugar in `packages/compiler/src/shims/yaar.ts` + `bundled-types`.

**Phase 2 — app MVP (`apps/chitchats`, ~1.5–2k lines Solid.js)**
Rooms list + room view, character editor (docs + avatar upload to `appStorage`),
sequential tape (mention → priority → shuffle, no interrupt-weave yet), streaming bubbles
with thinking fold, appDb persistence, `AGENTS.md` concierge.

**Phase 3 — parity polish**
Interrupt-on-user-message, interrupt-every-turn characters, follow-up rounds with
`[[skip]]` convergence and message caps, per-room pause, `speechSynthesis` voices,
transcript export from appDb.

*(Optional Phase 0, zero server change: a "lite" mode where the single app agent roleplays
all characters sequentially — validates room UX before Phase 1, at the cost of persona
bleed and no parallel streams. Skippable if we're confident in the UX.)*

## Testing

- Unit: spawn/message/dispose lifecycle; per-app `max` and global limiter enforcement
  (spawn past cap → clean error, slot released on dispose); per-persona serialization with
  cross-persona concurrency (two personas generating simultaneously, no shared-state races).
- Unit: tool-lessness — a persona profile's transport options carry no MCP servers/tools;
  a persona attempting a verb call has no path to one.
- Unit: ownership — app A cannot `read`/`invoke`/`stream` app B's personas; non-bundled
  app's `personas` manifest field is ignored at discovery.
- Loopback (`tests/loopback`): iframe `POST /api/verb` spawn → `message` → stream frames
  (`start`/`text`/`done` with final text) → `read` agrees with `done`; window close
  disposes personas and frees limiter slots.
- Manual (headless flow per root CLAUDE.md): open a chitchats room with 3 characters, send
  a message, watch three distinct streams answer in tape order; interrupt mid-generation
  with a new message; close the room and confirm `yaar://session/agents` shows the
  personas gone.

## Alternatives considered

- **One app agent roleplaying all characters** (Phase 0 as the destination): zero server
  work, but one shared context for N personalities — persona bleed, no per-character
  memory shape, no parallel generation, thinking streams indistinguishable. Fine as a
  demo, not as the feature.
- **One installed appId per character** (each with its own `AGENTS.md`): abuses install as
  a runtime operation, floods the app list and dock, prompts still aren't
  runtime-parameterizable (per-room character state), and cross-app messaging gates fight
  you the whole way. Rejected.
- **Personas as full app agents with tools**: strictly more capable, but runtime-supplied
  system prompts with OS hands is a real escalation surface, and no persona use case on
  the table needs tools. Start compute-only; a gated `tools` opt-in can come later if a
  use case demands it.
- **Standalone ChitChats beside YAAR** (status quo): works today, but duplicates provider
  pools, auth, streaming, and storage that YAAR maintains anyway, and YAAR gets no
  reusable primitive out of it.

## Open questions

1. **Queue or reject when a persona is busy?** The tape executor is naturally sequential
   per persona, so reject-if-busy (with `busy` in the error) is simplest and probably
   right; a depth-1 queue would absorb interrupt-weave races. v1 leans reject.
2. **Model tier per persona.** `spawn` takes `model?` — should cheap background characters
   ride a smaller tier by default (`profiles/model-tiers.ts` already exists for this)?
   Real cost lever for 4-persona rooms.
3. **Marketplace apps eventually?** The bundled-only gate mirrors `controls`/`streams`,
   but personas are better contained than either (no tools, no cross-app reach). A
   user-permission prompt ("this app wants to run up to 4 AI characters") could open it
   to installed apps later. Out of scope for v1.
4. **Codex personas.** Codex providers don't support steering and have their own
   process-per-instance economics (`CODEX_MAX_INSTANCES`-style pressure). v1 can ship
   Claude-first with Codex flagged best-effort; the verb surface doesn't change either way.
5. **Persona count vs `MAX_AGENTS`.** 4 personas + the standing trio fits under 10 but
   leaves little headroom for a second monitor. Raise the default, or exempt tool-less
   personas from the global semaphore (they're much lighter than tool-wielding agents)?
