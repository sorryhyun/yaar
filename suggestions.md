# YAAR Architectural Suggestions (Multi-Client Live Session + Monitors + Remote Access)

This document captures high-leverage architectural improvements for YAAR with two explicit goals:

1. **Multiple clients share the same live session** (desktop + mobile see the same windows/agents/state).
2. **Complex “monitor1/monitor2/…” subagent chaining** is reliable, observable, and doesn’t degrade interactivity.

It is written against the current codebase structure (`packages/server`, `packages/frontend`, `packages/shared`) and calls out concrete hotspots by file path where relevant.

---

## Executive Summary (Top 8 Improvements)

1. **Introduce a real `sessionId` (stable) and decouple it from `connectionId` (ephemeral).**
2. **Make broadcast, window state, reload cache, and logging session-scoped (not connection-scoped).**
3. **Fix MCP tool-call context routing (session + agent attribution) and delete “activeRegistry/activeCache” fallbacks.**
4. **Add server→client event sequencing + resync to support reconnects and multiple clients deterministically.**
5. **Remote/mobile access needs an auth boundary before tunnels.**
6. **Fix HTTPS WebSocket URL generation (`wss://` vs `ws://`).**
7. **Correct warm-session semantics vs “first user turn” so restore + initial-context behave correctly.**
8. **Add a monitor runtime with priorities/budgets so background chains don’t starve the main UX.**

---

## Current Architecture Snapshot (What You Already Have)

### Server-side (today)

- **WebSocket connection** creates a `SessionManager` keyed by `connectionId`.
- On first relevant message, `SessionManager` lazily constructs a **`ContextPool`**.
- `ContextPool` manages:
  - **Main agent** (persistent, session continuity)
  - **Window agents** (persistent per window/group)
  - **Ephemeral agents** (overflow)
  - **InteractionTimeline** (user events + AI summaries injected into main prompt)
  - **ContextTape** (hierarchical message history by source, used for window agent bootstrapping + restore)
  - **ReloadCache** (fingerprint → actions cache)
- **MCP tools** are exposed over HTTP (`/mcp/system|window|storage|apps`) and emit actions through `ActionEmitter`.
- **BroadcastCenter** routes server events to a WebSocket connection by `connectionId`.

### Frontend-side (today)

- Connects to `/ws` and applies OS actions to a Zustand store.
- Sends user messages + window actions + feedback events.
- Uses `ws://${window.location.host}/ws` which **breaks on https** (cloudflared, reverse proxies, etc).

---

## Design Goal: “Same Live Session as Desktop”

This is the key. Mobile should be “another view/controller” on the **same** running session:

- Both devices see the same windows and their contents.
- Both devices can send messages and interact with windows.
- Both devices observe the same agent streams (thinking/response) and tool progress.

To do that, you need an explicit identity model:

### Identity Model (Recommended)

- `sessionId`: **Stable**. Identifies the “live desktop session” (agents, windows, reload cache, logs).
- `connectionId`: **Ephemeral**. A single WebSocket connection instance (per device tab).
- `clientId`: Optional. Identifies a device (desktop vs mobile) for UX features (focus ownership, notifications, etc).

---

## Biggest Architectural Issue: Connection-Scoped State

Today, many critical subsystems are keyed off `connectionId`:

- `ContextPool` is created per WebSocket connection.
- `WindowStateRegistryManager` stores registries keyed by connection (and has a “global/active” fallback).
- `ReloadCacheManager` stores caches keyed by connection (and has a “global/active” fallback).
- Session logging is created inside `ContextPool.initialize()` for the connection.

This blocks:

- Joining the same session from a second client.
- Reliable MCP routing (tools may hit the “active” session by accident).
- Any future multi-session server (multiple live desktops).

**Recommendation:** Introduce a session hub and move these subsystems under a `LiveSession` object.

---

## Proposed Core Refactor: `SessionHub` + `LiveSession`

### `SessionHub` (server)

A singleton that owns all sessions:

```ts
type SessionId = string;

class SessionHub {
  getOrCreate(sessionId?: SessionId): LiveSession;
  join(sessionId: SessionId, connectionId: ConnectionId, ws: WebSocket): void;
  leave(connectionId: ConnectionId): void;
}
```

### `LiveSession` (server)

A session-scoped container for all state:

- `contextPool: ContextPool` (agents, queues, tape, timeline)
- `windowState: WindowStateRegistry` (authoritative window state)
- `reloadCache: ReloadCache` (session-scoped cache file)
- `logger: SessionLogger` (session-scoped log dir)
- `broadcast: SessionBroadcast` (publishes to all connections in the session)
- `eventSeq: number` + `recentEvents` ring buffer (for resync)

### Join Protocol (WebSocket)

Clients must tell the server which session they want:

Option A (simple): **WS query param**
- `/ws?sessionId=...&token=...`

Option B (cleaner): **first WS message**
- Client connects, server replies “need session”, client sends `JOIN_SESSION`.

Either way, server responds with:

- `SESSION_JOINED { sessionId, clientId?, serverVersion?, provider? }`
- `SESSION_SNAPSHOT { windows, focusedWindowId, ... }` (or replay actions)
- Then starts streaming normal events.

### Why snapshots (not only “replay”)

For multi-client + reconnect, you want:

- A fast **authoritative snapshot** (window list + content + layout + lock state).
- Optional action/event replay for incremental updates.

You already have restore logic from session logs (event-sourcing-ish), so snapshot generation can be:

- “current in-memory window state” (best for a live session), and/or
- “apply latest restore actions” (good for cold-start restore).

---

## Broadcast Center: From Connection → Session

Today `BroadcastCenter.publishToConnection(event, connectionId)` is the default.

For multi-client, you want:

- `publishToSession(sessionId, event)` and optionally `publishToConnection` for device-specific messages.

Recommended shape:

```ts
class BroadcastCenter {
  subscribe(sessionId: SessionId, connectionId: ConnectionId, ws: WebSocket): void;
  unsubscribe(connectionId: ConnectionId): void;
  publishToSession(sessionId: SessionId, event: ServerEvent): void;
  publishToConnection(connectionId: ConnectionId, event: ServerEvent): void;
}
```

Also consider:

- **Backpressure** (slow mobile client shouldn’t block desktop).
- **Per-connection filtering** (e.g., mobile might not want high-frequency `AGENT_THINKING` deltas).

---

## Deterministic Multi-Client Sync: Add Sequence Numbers + Resync

When two clients are connected:

- They must apply actions in the same order.
- If one misses events (temporary disconnect), it must catch up.

### Minimal protocol upgrade

Add a monotonic `seq` to key events (at least `ACTIONS`, and ideally all server→client events):

```ts
type Sequenced<T> = T & { seq: number; sessionId: string };
```

Maintain per session:

- `nextSeq`
- ring buffer of last N events (`N` configurable; e.g. 5k events)

Client stores `lastSeq` and on reconnect sends:

- `RESUME { sessionId, lastSeq }`

Server responds with:

- replay buffered events if available, else
- send snapshot + reset `lastSeq`.

---

## MCP Tool Calls: Fix Context Routing (Critical for Multi-Session + Chaining)

### The current risk

MCP tools are invoked via HTTP to `/mcp/*`. Those HTTP handlers do not inherently know:

- which **session** the call belongs to,
- which **agent** (main/window/ephemeral/monitor) initiated it.

The code currently compensates with “most-recently-active” fallbacks:

- `WindowStateRegistryManager.activeRegistry`
- `ReloadCacheManager.activeCache`

This will break immediately with:

- multiple sessions, or
- even one session + multiple concurrent agents where “active” changes quickly.

### Recommended invariant

Every tool call must have deterministic context:

- `sessionId` (required)
- `agentInstanceId` (ideal; for Claude concurrency)

### How to encode context

**Preferred: HTTP headers**
- `X-YAAR-Session-Id: <sessionId>`
- `X-YAAR-Agent-Instance: <agentInstanceId>`

**Fallback: URL**
- `/mcp/system?sessionId=...&agent=...`

### How to make it work with providers

#### Claude provider
Claude’s SDK MCP config supports `headers` per MCP server. You can:

- Extend `TransportOptions` to include `mcpHeaders`.
- Have `AgentSession.handleMessage()` pass `{ sessionId, agentInstanceId }` into provider query options.
- Provider sets those headers for MCP calls.

This unlocks true parallel tool calls without cross-talk.

#### Codex provider (constraints)
Codex `app-server` MCP URLs are configured at process start.

If it supports extra headers (not currently used), set them there.

If it does not:

- You can still embed **sessionId into the MCP URL** at app-server start (per-session app-server).
- For **agent attribution**, you can often rely on Codex’s turn serialization:
  - since only one turn runs at a time per app-server, tool calls during that window can be routed to the “active turn owner” stored in `LiveSession`.

If you want true Codex parallelism for monitors + interactivity, you may need:

- **separate app-server processes** (e.g., one for foreground, one for monitors), or
- “monitor work runs on Claude” while Codex stays foreground.

### Delete “activeRegistry/activeCache”

Once MCP calls are session-aware:

- remove global fallbacks
- require explicit context or reject the call

This makes multi-client and monitor chaining predictable.

---

## Warmup vs Restore vs “First User Turn” (Bug-Class Issue)

Today, warm provider sessions can cause the system to believe “we already sent the first message”:

- `ProviderLifecycleManager` sets `hasSentFirstMessage = true` when a warm session ID exists.

This can unintentionally:

- skip `resumeSessionId` restore logic for the first real user message,
- skip window-agent “inject recent main context” logic.

### Recommendation

Track two separate states:

- `hasWarmSession` (provider has a pre-created session/thread)
- `hasProcessedFirstUserTurn` (the first actual user input has been sent)

Use `hasProcessedFirstUserTurn` to gate:

- restore `resumeSessionId`
- window initial-context injection decisions

This is especially important once monitors exist, because “warm background chatter” can easily distort what “first meaningful message” means.

---

## Monitors (`monitor1`, `monitor2`, …): A Dedicated Runtime

Treat monitors as **first-class agents** that:

- run in the background,
- chain subtasks,
- publish structured output,
- and optionally render UI panels.

### Why monitors should not just be “windows”

Windows are a visualization surface; monitors are ongoing processes.

If monitors are implemented as “window agents that keep talking”, you’ll hit:

- scheduling issues (monitor chains starve user turn processing),
- messy lifecycle (what happens on reset, close, reconnect),
- no explicit state model.

### Recommended shape: `MonitorManager` per `LiveSession`

Each monitor has:

- `monitorId` (`monitor1`, `monitor2`, …)
- `canonicalAgent` name for persistence (e.g. `monitor-monitor1`)
- scheduling/triggers (interval, event-driven, manual)
- budgets and priority
- a state blob (persistable)

### Scheduling and fairness

Add a priority scheduler:

- Foreground: user main + window interactions
- Background: monitors

Enforce budgets:

- max concurrent monitor tasks
- max “monitor tokens per minute” (provider-specific)
- max action rate (don’t spam UI)

### Chaining model: explicit “work graph”

Give monitors a structured chaining API:

- `spawnSubtask({ kind, goal, inputs, parentId })`
- `awaitSubtasks(parentId)`

Persist:

- subtask lineage
- outcomes + errors
- timestamps

This makes monitor outputs observable, debuggable, and resumable after restart.

### Monitor UI

Optional but recommended:

- each monitor gets a “monitor panel” window that shows:
  - current state
  - last run
  - active subtask graph
  - last errors

The UI is a view of monitor state (not the state machine itself).

---

## Remote / Mobile Access (cloudflared / reverse proxy / LAN)

### Step 0: Fix WebSocket URL for HTTPS

Frontend currently hardcodes `ws://` based on `window.location.host`.
If the site is served over https (cloudflared), the WS must be `wss://`.

Change should be:

- `ws://` for `http:`
- `wss://` for `https:`

### Step 1: Add an authentication boundary (before exposing)

Without auth, remote access grants:

- full UI control
- storage read/write/delete
- any tool chain you enable

Recommended options:

1. **Cloudflare Access** (best UX for tunnels)
   - keep server bound to `127.0.0.1`
   - cloudflared exposes it securely
   - Access handles identity + MFA

2. **In-app bearer token**
   - require `Authorization: Bearer <token>` on:
     - WebSocket upgrade `/ws`
     - all `/api/*`
     - optionally `/` (static frontend)

You can combine both (Access + token) if you want defense in depth.

### Step 2: Session join for mobile

Since mobile joins the same live session:

- desktop shows a “pairing QR” with:
  - `sessionId`
  - optional one-time pairing token

Mobile scans, opens the URL, joins the session.

### Step 3: Consider role-based permissions

Nice-to-have for safety:

- “viewer” (read-only)
- “controller” (can send messages / click buttons)
- “admin” (storage write/delete, app-dev tools)

This becomes important once you tunnel beyond localhost.

---

## Security Hardening Checklist (Highly Recommended Before Remote)

### 1) Gate sensitive APIs

- `/api/storage/*` write/delete should be protected.
- `/api/fetch` is already SSRF-protected; keep it that way.

### 2) Remove or replace code execution primitives

`mcp__system__calculate` uses dynamic evaluation today. Replace with a real parser or disable it in remote mode.

### 3) Introduce a “remote safe mode”

When `YAAR_REMOTE=1`:

- disable app-dev tools, sandbox execution, and any other high-risk tool categories
- enforce strict auth
- consider “viewer-only” default

### 4) Rate limiting

Add per-session and per-connection limits for:

- WS messages/sec
- tool calls/min
- storage writes/min

### 5) Audit logging

You already log sessions. Ensure you also log:

- client joins/leaves
- auth decisions
- monitor activity

---

## Provider Notes (Claude vs Codex) for Monitors + Multi-Client

### Claude

- True parallelism is possible (multiple concurrent agent queries).
- Therefore MCP calls **must** carry agent attribution (headers), or you risk cross-talk.

### Codex

- One active turn at a time per app-server process (turn semaphore).
- If monitors run on the same app-server as foreground, they will increase latency.

Recommended approaches:

1) **Foreground Codex + Monitors Claude**
- simplest, best UX

2) **Two Codex app-servers**
- one for foreground, one for monitors
- more complexity, more resources

3) **Codex only, but strict background budgets**
- acceptable if monitor work is infrequent and short

---

## Suggested Implementation Roadmap (Practical Sequence)

### Phase 1 — Multi-client session foundations

- Add `sessionId` and join protocol.
- Make BroadcastCenter session-aware.
- Move window state, reload cache, and logger under `LiveSession`.
- Add event sequencing + snapshot/resume.

Definition of done:
- Desktop and mobile connect simultaneously and see the same windows.
- Both can send a message; both see identical action stream.

### Phase 2 — MCP context correctness

- Make MCP requests session-aware (and ideally agent-aware).
- Remove `activeRegistry/activeCache` fallbacks.
- Ensure actions are attributed deterministically.

Definition of done:
- Two different sessions can run concurrently without tool/state cross-talk.

### Phase 3 — Monitors runtime

- Add MonitorManager + scheduling.
- Add a chaining API and persistence.
- Add a monitor panel window.

Definition of done:
- `monitor1` can run periodic chains without impacting main message latency beyond budget.

### Phase 4 — Remote exposure

- Fix `wss://` on frontend.
- Add auth boundary (Access and/or in-app token).
- Add remote safe mode + tool gating.

Definition of done:
- Can access from phone over HTTPS tunnel, authenticated, same session as desktop.

---

## “Quick Wins” You Can Do Immediately

1. Fix `wss://` selection in the frontend WS URL logic.
2. Introduce a session-scoped broadcast concept (even if initially there’s only one session).
3. Add an in-app token for WS + API so tunneling is not scary.

---

## Open Questions (Worth Deciding Early)

1. **Do you need multiple sessions concurrently**, or just one “global desktop session” at a time?
2. Should mobile be able to fully control (send messages/click buttons), or is read-only acceptable by default?
3. Where should monitors run by default on a mixed-provider setup (Claude vs Codex)?
4. How durable should monitor state be across restarts (best-effort vs strict)?

