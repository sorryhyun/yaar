# Claude vs Codex: Provider Behavioral Differences

YAAR supports two AI providers behind a unified `AITransport` interface. While the agent orchestration layer (`ContextPool`, `AgentPool`, policies) treats them identically, the providers themselves differ significantly in architecture, session management, and capabilities.

## Architecture

### Claude (`ClaudeSessionProvider`)

```
YAAR Server Process
└── ClaudeSessionProvider (in-process)
    └── @anthropic-ai/claude-agent-sdk
        └── query() → persistent streaming session (long-lived CLI process)
            ├── InputChannel — pushes turns into the open stream
            └── MCP-connect gating on the first turn (bounded wait)
```

- **In-process, persistent-streaming design**: Each provider opens a long-lived CLI process via `sdkQuery()` fed by an `InputChannel`; the process and its MCP connections survive across turns instead of respawning per query
- **Per-instance `busy` locking**: A provider's persistent session tracks `busy`, so a second turn arriving while one is in flight closes and reopens the stream (or waits) rather than racing it — concurrent turns on the *same* provider are serialized, not parallel
- **Cross-instance parallelism**: Separate `ClaudeSessionProvider` instances (one per agent) each own their own persistent stream, so different agents still run truly in parallel with no cross-instance coordination needed

### Codex (`CodexProvider`)

```
YAAR Server Process
├── AppServer (shared child process manager)
│   └── codex app-server --listen ws://127.0.0.1:4510
└── CodexProvider (one per agent)
    └── Own WebSocket connection (JSON-RPC)
        ├── thread/start → new thread
        ├── thread/fork  → fork from parent
        ├── thread/resume → resume saved thread
        └── turn/start   → run a turn
```

- **Child process**: `codex app-server` is a separate process spawned via `spawn()` with WebSocket transport
- **Shared process, own connections**: One `AppServer` process is shared, but each provider gets its own WebSocket connection via `appServer.createConnection()`
- **True parallelism**: Each connection carries its own notifications/requests, so multiple turns can run simultaneously (no turn serialization needed)

## Session Management

### Claude: Session IDs

```typescript
// First query: SDK creates a new session
const stream = sdkQuery({ prompt, options: { systemPrompt, model } });
// → msg.session_id returned in stream

// Subsequent queries: resume the session
const stream = sdkQuery({ prompt, options: { resume: sessionId } });

// Window agent fork: fork from parent's session
const stream = sdkQuery({ prompt, options: { resume: parentSessionId, forkSession: true } });
```

- Sessions are opaque IDs managed by the Claude backend
- `resume: sessionId` continues the conversation (full history preserved server-side)
- `forkSession: true` creates a new session branching from the parent's history

### Codex: Threads

```typescript
// New thread
const { thread } = await appServer.threadStart({ baseInstructions: systemPrompt });

// Fork from parent thread
const { thread } = await appServer.threadFork({ threadId: parentThreadId });

// Resume a saved thread
await appServer.threadResume({ threadId: savedThreadId });

// Run a turn in a thread
await appServer.turnStart({ threadId, input: [{ type: 'text', text: prompt }] });
```

- Threads are explicitly created and managed via JSON-RPC
- `thread/start` creates a fresh thread with base instructions
- `thread/fork` branches from a parent thread's history
- `thread/resume` reconnects to a previously saved thread
- Each turn is a separate RPC call within a thread

### Comparison

| Aspect | Claude | Codex |
|--------|--------|-------|
| Session creation | Implicit on first query | Explicit `thread/start` |
| Session resume | `resume: sessionId` | `thread/resume` → `turn/start` |
| Session fork | `forkSession: true` | `thread/fork` |
| History storage | Server-side (Anthropic) | Server-side (OpenAI) |
| Concurrency | Unlimited parallel queries | Parallel via per-provider WebSocket connections |

## Mid-Turn Steering

Both providers support injecting additional user input into an active turn, allowing the user to redirect the AI mid-response without interrupting and restarting.

### Claude: `streamInput()`

The Agent SDK's `Query` object exposes `streamInput()` for sending user messages into an active query. Requires streaming input mode (async generator prompt):

```typescript
// query() always uses async generator for streaming input mode
const promptInput = async function*() {
  yield { type: 'user', message: { role: 'user', content: prompt } };
};
const stream = sdkQuery({ prompt: promptInput, options });

// Mid-turn: inject additional input
await stream.streamInput(async function*() {
  yield { type: 'user', message: { role: 'user', content: 'Actually, change approach...' } };
}());
```

### Codex: `turn/steer`

A dedicated JSON-RPC method that appends input to an in-flight turn:

```json
→ {"method": "turn/steer", "params": {"threadId": "thread_abc", "input": [{"type": "text", "text": "Actually..."}], "expectedTurnId": "turn_xyz"}, "id": 5}
← {"id": 5, "result": {"turnId": "turn_xyz"}}
```

### Comparison

| Aspect | Claude | Codex |
|--------|--------|-------|
| Mechanism | `Query.streamInput()` | `turn/steer` JSON-RPC |
| Requirement | Streaming input mode (async generator prompt) | Active turn with known `turnId` |
| Validation | None (SDK handles) | `expectedTurnId` must match active turn |
| Failure mode | Promise rejection | JSON-RPC error |

### Server Integration

Both are exposed through the same `AITransport.steer?(content)` optional method. `ContextPool.queueMainTask()` tries steer first when the monitor agent is busy, falling back to ephemeral/queue if unsupported or failed. See [`docs/architecture/common_flow.md`](../architecture/common_flow.md) for the full concurrency strategy.

## Warmup

Both providers support warmup for faster first response, but the mechanism differs:

### Claude Warmup

```
WebSocket connect → ContextPool.prewarmMonitorAgent()
  → AgentSession.prewarm()
  → ClaudeSessionProvider.prewarm(options)
    → openPersistentSession() — opens the persistent stream with the exact
      SDK options (systemPrompt, mcpServers, model) the first turn will use
    → await session.mcpReady — waits for MCP servers to connect (bounded)
    → "Prewarmed persistent stream (MCP connected)"
```

Warmup pre-opens the long-lived CLI process and waits for its MCP connections, so the first real user message lands on an already-running stream instead of paying process-spawn and MCP-handshake latency. A prompt/tools/model change later still reopens the stream with `resume`, carrying the conversation over.

### Codex Warmup

```
Server startup → WarmPool.initialize()
  → ensureCodexAppServer()
    → spawn('codex', ['app-server', '--listen', 'ws://...', ...flags])
    → connectControlClient() (WS connect + initialize handshake)
    → checkAndLoginCodex() (auth via control client)
  → new CodexProvider(appServer)
  → warmup()
    → appServer.createConnection() (new WS + initialize)
    → Provider has its own dedicated connection
```

Codex warmup starts the child process and establishes a dedicated WebSocket connection for the provider. Thread creation happens on first query. This is lighter than Claude's warmup but means the first query pays the thread creation cost.

## MCP Integration

Both providers connect to the same MCP tool servers: `CORE_SERVERS` (`mcp/server.ts`) is always active — `system`, `verbs`, `app`, `messaging`, `subagent` (5 namespaces). `verbs` exposes the 5 generic URI verbs (`describe`, `read`, `list`, `invoke`, `delete`) that dispatch to `handlers/` via `yaar://` URIs; `app` carries the app-agent tools (`describe`/`query`/`command`/`relay`); `messaging` carries cross-app/user messaging tools; `system` carries `reload_cached`/`list_reload_options`; `subagent` carries the calling [sub-agent](../architecture/agent_tree.md)'s app-declared tools and is empty for every other caller.

### Claude

MCP servers are passed as SDK options:

```typescript
mcpServers: {
  system: { type: 'http', url: 'http://127.0.0.1:8000/mcp/system', headers: { Authorization: 'Bearer ...' } },
  verbs: { type: 'http', url: 'http://127.0.0.1:8000/mcp/verbs', headers: { Authorization: 'Bearer ...' } },
  app: { type: 'http', url: 'http://127.0.0.1:8000/mcp/app', headers: { Authorization: 'Bearer ...' } },
  messaging: { type: 'http', url: 'http://127.0.0.1:8000/mcp/messaging', headers: { Authorization: 'Bearer ...' } },
}
```

### Codex

MCP servers are declared **per thread**, not at process spawn — `CodexProvider.buildMcpScope`
builds an `mcp_servers` override for each `thread/start`/`resume`/`fork`, because that is the only
place that can stamp the calling agent's identity onto them:

```jsonc
// thread/start params.config
{ "mcp_servers": {
    "verbs": { "url": "http://127.0.0.1:8000/mcp/verbs",
               "bearer_token_env_var": "YAAR_MCP_TOKEN",
               "http_headers": { "x-agent-token": "<minted for this agent>" } },
    /* …plus system, app, messaging — `subagent` only for a sub-agent */ }}
```

The shared bearer token rides in an environment variable (`YAAR_MCP_TOKEN`); the per-agent
credential is the `x-agent-token` header. `getCodexAppServerArgs()` deliberately declares no
`mcp_servers` at the process level — an override merges over the loaded config rather than
replacing it, so anything declared there could never be taken away from a thread.

## Model Configuration

| Setting | Claude | Codex |
|---------|--------|-------|
| Model | Sonnet/Opus by agent tier | `gpt-5.6-terra` for both Sonnet-tier and Opus-tier agents (and the default) — `claudeModelToCodex()` maps both to the same Codex model; per-query `options.model` honored via `thread/start`/`thread/fork` |
| Thinking | Not explicitly configured (no `thinking`/`maxThinkingTokens` option set anywhere in the Claude provider — default SDK behavior) | High reasoning effort (`-c model_reasoning_effort=high`) |
| Web search | Enabled (`tools: ['WebSearch', 'Task']`) | Disabled by design (`-c web_search=disabled`) — YAAR controls HTTP access via MCP tools |
| Shell tool | N/A (MCP tools only) | Explicitly disabled (`features.shell_tool=false`) |
| Sandbox | N/A | `danger-full-access` |
| Personality | Default | Feature disabled outright (`features.personality=false`) — no personality value is ever set |
| Permissions | `bypassPermissions` | `approval_policy = "never"` |
| Multi-agent | Task tool (profile-based delegation) | Native Codex multi-agent/collab features disabled (`features.multi_agent=false`, `features.collaboration_modes=false`) — orchestration stays YAAR-tracked, not Codex-internal. Also disabled: `apply_patch_freeform`, `unified_exec`, `code_mode`, `fast_mode`, `skill_mcp_dependency_install`, `image_generation`, `computer_use`, `browser_use`, `skill_search`, `workspace_dependencies`, `memories`, `apps`, `remote_plugin` — see `DISABLED_FEATURES` in `config/providers/codex.ts`. Both rosters are logged at launch (`[codex] feature opt-outs/opt-ins`) |
| Code mode | N/A | Model side off (`features.code_mode=false`) — no `exec` tool that runs model-authored JS against every tool. Host-side runtime left on (`features.code_mode_host=true`, `ENABLED_FEATURES`), which is inert without the model side |
| MCP protocol era | `MCP_SDK_GENERATION=v2` + `MCP_PROTOCOL_NEGOTIATION=auto` (both required) | `features.mcp_2026_07_28=true` (`ENABLED_FEATURES`) — the gate for HTTP MCP servers, which is all of YAAR's. `CODEX_MCP_PROTOCOL_VERSION` is the stdio-server equivalent and does **not** move these |

## Image Handling

### Claude

Images are captured as WebP on the frontend (via Canvas `toDataURL('image/webp')`), then sent as multimodal content blocks:

```typescript
// Images arrive as WebP data URLs from the frontend
// Build multimodal prompt via async generator
promptInput = async function*() {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: '...' } },
        { type: 'text', text: prompt },
      ],
    },
  };
};
```

### Codex

Images are passed directly as data URLs in the input array:

```typescript
const input = [
  { type: 'text', text: prompt, text_elements: [] },
  { type: 'image', url: 'data:image/png;base64,...' },
];

await appServer.turnStart({ threadId, input });
```

No conversion or compression is applied.

## Stream Message Mapping

Both providers emit the same `StreamMessage` types but map from different source formats:

### Claude (`message-mapper.ts`)

Maps from Agent SDK message types. Content deltas arrive as `stream_event` messages wrapping
Anthropic API `content_block_delta` events, not as a top-level `partial_message` type:
- `stream_event` with `content_block_delta` / `text_delta` → `text` (content chunks)
- `stream_event` with `content_block_delta` / `thinking_delta` → `thinking`
- `stream_event` with `content_block_start` / `content_block_stop` (tool_use blocks) → `tool_use_start` / `tool_use`
- `result` → `complete` (with session_id), or `error` if `is_error`/an error subtype
- `assistant` → session-id-only carrier; its text was already streamed via `stream_event`

### Codex (`message-mapper.ts`)

Maps from JSON-RPC notification methods:
- `item/agentMessage/delta` → `text` (content chunks)
- `item/reasoning/textDelta` → `thinking`
- `turn/completed` → `complete`, or `error` when `turn.status` is `'failed'`/`'interrupted'` (there is no separate `turn/failed` method)
- `error` → `error`

## Error Recovery

### Claude

- Abort controller for interruption (`this.createAbortController()`)
- Errors caught and yielded as `error` StreamMessage
- Three auto-retry paths in `session-provider.ts`: the persistent stream ending before any
  message came back retries fresh with a new session (no `resume`); a stale-session error
  detected mid-turn on the main persistent-session path retries without `resume`; the same
  stale-session retry exists on the fork-turn path. Claude and Codex are not asymmetric here —
  both retry around session/thread invalidation.

### Codex

- Process-level resilience: If the AppServer exits unexpectedly, `ensureCodexAppServer()` restarts it on next provider creation
- Session recovery: If a thread becomes invalid, the session is invalidated and the query retries with a new thread
- Connection-level resilience: Each provider checks `client.isConnected` before queries; stale connections are detected via `isAvailable()`

## Shared Process Architecture (Codex-specific)

The Codex provider uses a shared `AppServer` with per-provider WebSocket connections:

```
WarmPool (owns the AppServer singleton)
├── AppServer (one process, WebSocket listener on port 4510)
│   ├── Control client (WS conn for auth/account operations)
│   └── Process lifecycle management (spawn, stop)
├── CodexProvider (monitor agent, monitor 0)
│   └── Own WS connection → own thread → own turns
├── CodexProvider (window agent)
│   └── Own WS connection → forked thread → own turns
└── CodexProvider (ephemeral agent)
    └── Own WS connection → own thread → own turns
```

This means:
1. **Fast provider creation**: New CodexProviders get a new WS connection without spawning a new process
2. **Thread isolation**: Each provider gets its own thread within the shared process
3. **True parallelism**: Each WS connection carries its own notifications/requests, so multiple turns can run simultaneously
4. **Shared lifecycle**: The AppServer lives as long as WarmPool keeps it; providers just close their own connections on dispose

## Key Files

| File | Purpose |
|------|---------|
| `providers/types.ts` | `AITransport` interface, `StreamMessage`, `TransportOptions` |
| `providers/factory.ts` | Auto-detection, dynamic imports, provider registry |
| `providers/warm-pool.ts` | Pre-initialization pool with auto-replenish |
| `providers/base-transport.ts` | Shared abort/interrupt logic |
| `providers/claude/session-provider.ts` | Claude Agent SDK integration — persistent streaming session, prewarm |
| `providers/claude/input-channel.ts` | `InputChannel` — pushes turns into the open persistent stream |
| `providers/claude/message-mapper.ts` | SDK message → StreamMessage |
| `providers/codex/provider.ts` | Codex provider with thread management |
| `providers/codex/app-server.ts` | AppServer process manager (spawn, WS connections, auth) |
| `providers/codex/raw-ws.ts` | Base WebSocket transport (raw TCP, bypasses Bun/tungstenite issues) |
| `providers/codex/jsonrpc-ws-client.ts` | JSON-RPC client layered over `raw-ws.ts` |
| `providers/codex/message-mapper.ts` | Notification → StreamMessage |
| `agents/profiles/orchestrator.ts` | Shared system prompt (`ORCHESTRATOR_PROMPT`/`getOrchestratorPrompt`) — imported by both `providers/claude/session-provider.ts` and `providers/codex/provider.ts`; neither provider has its own `system-prompt.ts` |
