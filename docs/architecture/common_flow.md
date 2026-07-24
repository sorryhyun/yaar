# Agent Architecture: Pools, Context, and Message Flow

> [한국어 버전](../ko/common_flow.md)

How YAAR manages concurrent AI agents through unified pooling, hierarchical context, and
policy-based orchestration. Diagrams are Mermaid — GitHub renders them natively.

## The Big Picture

```mermaid
flowchart LR
    User([User]) -->|types / clicks| FE[Frontend]
    FE <-->|WebSocket| LS[LiveSession]
    LS --> CP[ContextPool]
    CP --> MA["Monitor Agent<br/>(one per monitor, max 4)"]
    CP --> AA["App Agent<br/>(one per appId)"]
    CP --> EA["Ephemeral Agent<br/>(overflow, disposable)"]
    CP --> SA["Session Agent<br/>(lazy singleton)"]
    MA & AA & EA & SA -->|OS Actions| LS
    AA <-->|App Protocol| FE
```

Four agent tiers share one `AgentPool` inside the session's `ContextPool`. Every
server→frontend event flows through `LiveSession.broadcast()` (monitor-scoped routing via
`BroadcastCenter`).

## Agent Types

### 1. Monitor Agent — the orchestrator

The persistent generalist handling the main conversation flow, one per monitor
(primary `0` pre-warmed at connect; others auto-created on demand, `MAX_MONITORS = 4`).

- **Role**: `main-{monitorId}-{messageId}` (set per-message); canonical ID `main-{monitorId}`
- **Session**: resumes the same provider session across messages — full conversation history
- **Tools**: windows, notifications, storage read/list, memory, skills, config hooks,
  cache replay, and delegation (Claude's Task tool; app messaging via
  `invoke('yaar://windows/{id}', { action: "message", ... })`, optionally with
  `hook: "response"` to get the app agent's answer back)
- **URI**: `yaar://agents/{instanceId}`

It understands user intent and dispatches: trivial things (a notification, opening a window,
`reload_cached` replay) it does itself in 1–2 tool calls; app-domain work goes to app agents;
heavier research/build work goes to provider subagents. This keeps its own turns short so it
stays responsive to the next message.

### 2. Ephemeral Agent — overflow

Spawned when the monitor agent is busy and steering fails. Fresh provider, **no conversation
history** (receives open windows + reload options + the task), disposed right after the task;
its actions land in the `InteractionTimeline` for the monitor agent's next turn.

- **Role**: `ephemeral-{monitorId}-{messageId}`; limited by the global `AgentLimiter`

### 3. App Agent — the specialist operator

A persistent agent per `appId` (all windows of one app share it, surviving window close/reopen),
created on first interaction with an app window and routed through `AppTaskProcessor`.

- **Role**: `app-{appId}-{messageId}`; canonical ID `app-{appId}`
- **Context**: first turn bootstraps with the app's prompt (`AGENTS.md` replaces the generic
  prompt, else `SKILL.md` appends to it) + `protocol.json` manifest; later turns reuse the
  provider session
- **Tools** (scoped by design):

| Tool | Purpose |
|------|---------|
| `describe(appId?)` | Read an app's protocol manifest (own window, or another app's) |
| `query(stateKey?, appId?)` | Read iframe state — omit key for the manifest |
| `command(command, params?, appId?)` | Execute an iframe action |
| `relay(message)` | Hand off anything outside the app's domain to the monitor agent |
| `direct_message` | Only when `app.json` declares `"messaging": "all"` |

Passing another app's `appId` to `describe`/`query`/`command` is **cross-app control**, gated by
the caller's `app.json` `controls` list (bundled apps only) — e.g. devtools declares
`"controls": ["browser-user"]` to drive the real browser directly.

### 4. Session Agent — cross-monitor supervisor

A lazy singleton per session, created on first invocation via `yaar://session/agents/session`.
It is the **exclusive principal for `yaar://session/*`** (enforced centrally in
`ResourceRegistry.execute()`; monitor/app agents get a 403) — including
`yaar://session/browser`, the only door to the user's real Chrome.

- **Role**: `session-{action}-{timestamp}`; provider session continuity across invocations
- **Tools**: verb tools only (describe/read/list/invoke/delete) — no WebSearch, no Task
- **No monitor, no windows** — communicates via tool results and relay messages

> There is no separate "Task Agent" tier in the pool. Delegated research/code work runs as
> provider-internal subagents (Claude's Task tool) inside the monitor agent's turn; they never
> appear in `AgentPool`.

## Message Flow

### User message → monitor agent

`MonitorTaskProcessor` tries strategies in order:

```mermaid
flowchart TD
    UM[USER_MESSAGE for monitorId] --> SUS{Monitor<br/>suspended?}
    SUS -->|yes| SQ[Suspend queue<br/>MESSAGE_QUEUED]
    SUS -->|no| IDLE{Monitor agent<br/>idle?}
    IDLE -->|yes| DIRECT[processMainTask<br/>MESSAGE_ACCEPTED]
    IDLE -->|busy| STEER{"Steer: inject into the<br/>active turn (session.steer,<br/>skipped for relay tasks)"}
    STEER -->|succeeded| INC[AI incorporates input mid-turn<br/>MESSAGE_ACCEPTED]
    STEER -->|not supported / failed| EPH{Ephemeral agent<br/>available?<br/>global AgentLimiter}
    EPH -->|yes| PAR[Parallel response from<br/>a disposable agent]
    EPH -->|limit reached| Q{Queue has room?<br/>max 10 per monitor}
    Q -->|yes| ENQ[MonitorQueuePolicy.enqueue<br/>MESSAGE_QUEUED, drained when idle]
    Q -->|full| ERR[ERROR — message refused]
```

Direct processing, end to end:

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant S as Server (ContextPool)
    participant AI as AI Provider

    FE->>S: USER_MESSAGE
    Note over S: budget check (background monitors)<br/>route: idle → direct
    S-->>FE: MESSAGE_ACCEPTED
    Note over S: build prompt: timeline drain +<br/>open windows + reload options + content
    S->>AI: provider.query(prompt, { sessionId, systemPrompt })
    AI-->>S: stream (thinking, tool calls, text)
    S-->>FE: AGENT_THINKING / ACTIONS / AGENT_RESPONSE
    Note over S: actions recorded for reload cache<br/>then drain monitor queue if pending
```

### Interaction with an app window → app agent

`COMPONENT_ACTION` / `WINDOW_MESSAGE` on a plain window goes to the monitor agent's queue;
on an app window it goes to `AppTaskProcessor`:

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant S as Server (AppTaskProcessor)
    participant AI as App Agent

    FE->>S: COMPONENT_ACTION { windowId, action, formData? }
    Note over S: app window → get-or-create app agent (per appId)
    S-->>FE: WINDOW_AGENT_STATUS { status: 'assigned'/'active' }
    Note over S: first turn: AGENTS.md/SKILL.md + manifest<br/>later turns: provider session continuity
    S->>AI: provider.query(prompt, { sessionId })
    AI-->>S: stream + query()/command() against the iframe
    S-->>FE: AGENT_RESPONSE
    Note over S: push summary to InteractionTimeline<br/>(monitor agent sees it next turn)
```

## Monitor Agent ↔ App Agent: Division of Responsibility

The monitor agent is the **generalist** that knows the user and conversation; app agents are
**specialists** that know their app's internal state and commands.

| | Monitor agent | App agent |
|---|---|---|
| Knows | full conversation, all windows on its monitor, app catalog, system state | app manifest (state keys + commands), app skill, its own interaction history |
| Doesn't know | app-internal state (cells, URLs, slides), app protocol mechanics | other windows, the broader conversation, web/code tools |
| Escape hatch | messages the app window (`action: "message"`, optional `hook: "response"`) | `relay()` back to the monitor agent |

```mermaid
sequenceDiagram
    participant U as User
    participant M as Monitor Agent
    participant A as App Agent
    participant I as App Iframe

    U->>M: "open the spreadsheet"
    M->>M: load skill, create iframe window (appId)
    Note over M: done — back to idle
    U->>A: clicks button in the app window
    Note over A: first turn: bootstrap prompt + manifest
    A->>I: query('cells')
    I-->>A: state
    A->>I: command('setCells', { data })
    I-->>A: result
    A->>M: relay("search the web for X") — outside app domain
    Note over M: relay enqueued as a monitor task
```

## App Protocol: How an Agent Talks to an Iframe

Apps register a self-describing contract — state keys to query, commands to invoke — by calling
`app.register(manifest)` from `@bundled/yaar` when the iframe loads. The server stores readiness
**per window key** in `WindowStateRegistry`; `query`/`command` wait up to 5s for registration
(`requireAppReady`) before failing.

```mermaid
sequenceDiagram
    participant AG as App Agent (tool call)
    participant AE as ActionEmitter (PendingStore)
    participant LS as LiveSession.broadcast
    participant FE as Frontend (iframe-bridge)
    participant IF as App Iframe

    AG->>AE: emitAppProtocolRequest(windowKey, request, timeoutMs)
    Note over AE: pending entry + deadline:<br/>query 5s · command 30s default,<br/>caller may raise to 180s
    AE->>LS: 'app-protocol' event
    LS->>FE: WS: APP_PROTOCOL_REQUEST
    FE->>IF: postMessage yaar:app-*-request
    IF-->>FE: postMessage yaar:app-*-response
    FE-->>LS: WS: APP_PROTOCOL_RESPONSE
    LS-->>AE: resolveAppProtocolResponse(requestId)
    AE-->>AG: result (or timeout error)
```

Windows are addressed by their **monitor-scoped key** (`win.id`), never the raw AI-facing id: the
same app open on two monitors shares a raw id, and the frontend resolves raw ids by whichever
monitor the *user* is viewing. The built-in `__console` state key is answered by the injected
protocol script and works even before `app.register()`.

## ContextTape: Hierarchical Message History

Messages are tagged with a URI source for hierarchical tracking:

```typescript
type ContextSource = `yaar://monitors/${string}` | `yaar://windows/${string}`;

interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  source: ContextSource;
}
```

- **Monitor agent prompts** don't inject the tape (provider session continuity carries history)
- **Window close** prunes that window's messages from the tape
- **Session restore** rebuilds the tape from a previous session's JSONL log
- Monitor history is capped (~200 messages, pruned to the most recent half)

## InteractionTimeline

A chronological timeline interleaving user events and agent action summaries. The monitor agent
drains it at the start of its next turn to see everything that happened while it was idle —
window closes, app agent runs, ephemeral agent runs.

```
User closes window → pushUser({ type: 'window.close', windowId })
App agent runs     → pushAI(role, task, actions, windowId)
Ephemeral agent    → pushAI(role, task, actions)

Monitor agent's turn → timeline.format() → drain()   // atomic, no gap
  <timeline>
  <ui:close>settings-win</ui:close>
  <ai agent="app-notes">Updated content of "notes".</ai>
  </timeline>
```

## Concurrency Example

```mermaid
sequenceDiagram
    participant U as User
    participant M as Monitor Agent (monitor 0)
    participant A as App Agent (app-notes)

    par main conversation
        U->>M: types "Hello"
        Note over M: processes with full session history
        M-->>U: response
    and app interaction
        U->>A: clicks Save in the notes window
        Note over A: first turn: skill + manifest bootstrap
        A-->>U: window updated
        A->>M: InteractionTimeline: "app-notes: updated content"
    end
    Note over M: next turn drains the timeline —<br/>sees the Save happened
```

Monitor and app agents run genuinely in parallel; the timeline is what keeps the orchestrator's
picture of the desktop consistent afterward.

### App state across app-agent handoffs

Immediately before an app agent is released, YAAR reads every state key declared by that
app's App Protocol and retains one aggregate fingerprint. Before the next invocation, it
reads the same declared state again and compares the fingerprints. The new prompt receives
only `<app_state_since_handoff changed="true|false" />`; app data itself is not copied into
the prompt. A changed agent can query the authoritative state it needs.

This detects user edits, timers, and any other app-state mutation without waking an idle
agent or requiring the app to emit an event. It reports a net state change, not an event
history: a value changed and then restored before the next invocation compares unchanged.

`app.sendInteraction()` remains instruction delivery. It invokes an idle app agent or steers
the active turn; it is not accumulated as handoff state.
