# Claude vs Codex: Provider Behavioral Differences

YAAR supports two AI providers behind a unified `AITransport` interface. While the agent orchestration layer (`ContextPool`, `AgentPool`, policies) treats them identically, the providers themselves differ significantly in architecture, session management, and capabilities.

## Architecture

### Claude (`ClaudeSessionProvider`)

```
YAAR Server Process
└── ClaudeSessionProvider (in-process)
    └── @anthropic-ai/claude-agent-sdk
        └── query() → async iterable of SDK messages
```

- **In-process**: The Agent SDK runs inside the YAAR server process
- **Each provider instance** is lightweight — just an SDK wrapper with session state
- **Multiple instances** can run truly in parallel with no coordination needed

### Codex (`CodexProvider`)

```
YAAR Server Process
└── CodexProvider
    └── AppServer (shared child process)
        └── codex app-server (JSON-RPC over stdio)
            ├── thread/start → new thread
            ├── thread/fork  → fork from parent
            ├── thread/resume → resume saved thread
            └── turn/start   → run a turn
```

- **Child process**: `codex app-server` is a separate process spawned via `spawn()`
- **Shared process**: One `AppServer` instance is shared across all providers for a connection (reference-counted)
- **Turn semaphore**: Only one turn can run at a time per AppServer (notifications lack thread IDs, so turns must be serialized)

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
| Concurrency | Unlimited parallel queries | One turn at a time (semaphore) |

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

Both are exposed through the same `AITransport.steer?(content)` optional method. `ContextPool.queueMainTask()` tries steer first when the main agent is busy, falling back to ephemeral/queue if unsupported or failed. See [`docs/common_flow.md`](./common_flow.md) for the full concurrency strategy.

## Warmup

Both providers support warmup for faster first response, but the mechanism differs:

### Claude Warmup

```
Server startup → WarmPool.initialize()
  → new ClaudeSessionProvider()
  → warmup()
    → sdkQuery({ prompt: "ping", options: { systemPrompt, mcpServers } })
    → SDK creates session, loads MCP tools, processes system prompt
    → Returns "pong" (system prompt instructs this handshake)
    → sessionId captured for resume
```

The warmup is expensive but effective: it pre-loads the entire system prompt and MCP tool definitions into a session. The first real user message then `resume`s this session.

### Codex Warmup

```
Server startup → WarmPool.initialize()
  → new CodexProvider()
  → warmup()
    → ensureAppServer()
      → spawn('codex', ['app-server', ...flags])
      → initialize() (JSON-RPC handshake)
    → Process is running and ready for thread/start
```

Codex warmup just starts the child process. Thread creation happens on first query. This is lighter but means the first query pays the thread creation cost.

## MCP Integration

Both providers connect to the same 4 MCP tool servers, but configure them differently:

### Claude

MCP servers are passed as SDK options:

```typescript
mcpServers: {
  system: { type: 'http', url: 'http://127.0.0.1:8000/mcp/system', headers: { Authorization: 'Bearer ...' } },
  window: { type: 'http', url: 'http://127.0.0.1:8000/mcp/window', headers: { Authorization: 'Bearer ...' } },
  storage: { type: 'http', url: 'http://127.0.0.1:8000/mcp/storage', headers: { Authorization: 'Bearer ...' } },
  apps: { type: 'http', url: 'http://127.0.0.1:8000/mcp/apps', headers: { Authorization: 'Bearer ...' } },
}
```

### Codex

MCP servers are configured via CLI flags at process spawn:

```
codex app-server \
  -c mcp_servers.system.url=http://127.0.0.1:8000/mcp/system \
  -c mcp_servers.system.bearer_token_env_var=YAAR_MCP_TOKEN \
  -c mcp_servers.window.url=http://127.0.0.1:8000/mcp/window \
  -c mcp_servers.window.bearer_token_env_var=YAAR_MCP_TOKEN \
  ...
```

The auth token is passed via environment variable (`YAAR_MCP_TOKEN`) rather than directly in headers.

## Model Configuration

| Setting | Claude | Codex |
|---------|--------|-------|
| Model | `claude-sonnet-4-5-20250929` | `gpt-5.3-codex` |
| Thinking | Enabled, 4096 max tokens | Medium reasoning effort |
| Web search | Enabled (`tools: ['WebSearch']`) | Not available |
| Shell tool | N/A (MCP tools only) | Explicitly disabled |
| Sandbox | N/A | `danger-full-access` |
| Personality | Default | `none` |
| Permissions | `bypassPermissions` | `approval_policy = "never"` |

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

Maps from Agent SDK message types:
- `assistant` / `partial_message` → `text` (content deltas)
- `result` → `complete` (with session_id)
- Thinking blocks → `thinking`

### Codex (`message-mapper.ts`)

Maps from JSON-RPC notification methods:
- `message/delta` → `text` (content chunks)
- `turn/completed` → `complete`
- `turn/failed` / `error` → `error`
- `agent/thinking` → `thinking`

## Error Recovery

### Claude

- Abort controller for interruption (`this.createAbortController()`)
- Errors caught and yielded as `error` StreamMessage
- No auto-retry

### Codex

- Process-level resilience: `AppServer` auto-restarts on crash (up to 3 times with 1s delay)
- Session recovery: If a thread becomes invalid, the session is invalidated and the query retries with a new thread
- Turn queue draining on shutdown: blocked `acquireTurn()` callers are unblocked to fail gracefully
- Shared process reference counting: `retain()` / `release()` prevent premature shutdown

## Shared Process Architecture (Codex-specific)

The Codex provider uses a shared `AppServer` pattern:

```
WarmPool
├── Creates first CodexProvider with new AppServer
├── Captures shared AppServer reference
└── Creates subsequent CodexProviders sharing the same AppServer

AppServer (one per connection lifecycle)
├── refCount tracks active providers
├── Turn semaphore ensures one turn at a time
├── Notifications broadcast to all listeners (no thread ID tagging)
└── Auto-restart on crash (up to 3 times)
```

This means:
1. **Fast provider creation**: New CodexProviders for window/ephemeral agents don't spawn a new process
2. **Thread isolation**: Each provider gets its own thread within the shared process
3. **Turn serialization**: Only one turn runs at a time, which limits parallelism compared to Claude
4. **Shared lifecycle**: The AppServer lives until the last provider releases it

## Key Files

| File | Purpose |
|------|---------|
| `providers/types.ts` | `AITransport` interface, `StreamMessage`, `TransportOptions` |
| `providers/factory.ts` | Auto-detection, dynamic imports, provider registry |
| `providers/warm-pool.ts` | Pre-initialization pool with auto-replenish |
| `providers/base-transport.ts` | Shared abort/interrupt logic |
| `providers/claude/session-provider.ts` | Claude Agent SDK integration with warmup |
| `providers/claude/message-mapper.ts` | SDK message → StreamMessage |
| `providers/claude/system-prompt.ts` | Claude-specific system prompt |
| `providers/codex/provider.ts` | Codex provider with thread management |
| `providers/codex/app-server.ts` | AppServer process manager (spawn, restart, JSON-RPC) |
| `providers/codex/jsonrpc-client.ts` | JSON-RPC client over stdio |
| `providers/codex/message-mapper.ts` | Notification → StreamMessage |
| `providers/codex/system-prompt.ts` | Codex-specific system prompt |
