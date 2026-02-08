# Codex App Server Integration Guide

This document explains our Codex App Server integration: the architectural decisions, protocol details, and roadmap for full feature utilization.

**Reference:** [Unlocking the Codex Harness](https://openai.com/index/unlocking-the-codex-harness/) — OpenAI's official App Server documentation.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Why App Server Mode](#why-app-server-mode)
3. [Architecture](#architecture)
4. [Protocol Reference](#protocol-reference)
5. [Configuration](#configuration)
6. [Disabled Features & Rationale](#disabled-features--rationale)
7. [Implementation Reference](#implementation-reference)
8. [Roadmap: Full Feature Unlock](#roadmap-full-feature-unlock)
9. [Appendix: Codex Internals](#appendix-codex-internals)

---

## Quick Start

### Installation

```bash
npm install -g @openai/codex
codex login              # Authenticate (opens browser)
codex login status       # Verify authentication
```

### Running App Server

```bash
# Basic
codex app-server

# With YAAR configuration
codex app-server \
  -c "features.shell_tool=false" \
  -c "approval_policy=never" \
  -c "model_reasoning_effort=medium" \
  -c "model_personality=none"

# Debug: send a test message
codex debug app-server send-message-v2 "Hello, world!"

# Generate TypeScript types from the protocol
codex app-server generate-ts

# Generate JSON Schema
codex app-server generate-json-schema
```

### JSON-RPC Protocol (over stdio)

**Initialize (required first):**

```json
→ {"method": "initialize", "params": {"clientInfo": {"name": "yaar", "version": "1.0.0"}}, "id": 0}
← {"id": 0, "result": {"userAgent": "codex/0.94.0 ..."}}
```

**Create a thread:**

```json
→ {"method": "thread/start", "params": {"baseInstructions": "You are a desktop agent..."}, "id": 1}
← {"id": 1, "result": {"thread": {"id": "thread_abc123"}, "model": "gpt-5.3-codex"}}
```

**Send a message (start a turn):**

```json
→ {"method": "turn/start", "params": {"threadId": "thread_abc123", "input": [{"type": "text", "text": "Hello!"}]}, "id": 2}
← {"id": 2, "result": null}
```

Streaming notifications follow (no `id` field):

```json
← {"method": "turn/started", "params": {}}
← {"method": "item/started", "params": {"itemId": "item_1", "itemType": "agent_message"}}
← {"method": "item/agentMessage/delta", "params": {"delta": "Hi there"}}
← {"method": "item/agentMessage/delta", "params": {"delta": "! How can I help?"}}
← {"method": "item/agentMessage/completed", "params": {"text": "Hi there! How can I help?"}}
← {"method": "item/completed", "params": {"itemId": "item_1"}}
← {"method": "turn/completed", "params": {"status": "completed"}}
```

**Resume a thread:**

```json
→ {"method": "thread/resume", "params": {"threadId": "thread_abc123"}, "id": 3}
```

**Fork a thread:**

```json
→ {"method": "thread/fork", "params": {"threadId": "thread_abc123"}, "id": 4}
← {"id": 4, "result": {"thread": {"id": "thread_def456"}}}
```

---

## Why App Server Mode

We evaluated three integration modes:

| Mode | Session State | Multimodal | Streaming |
|------|---------------|------------|-----------|
| `codex` CLI (per-query spawn) | None | Yes | No |
| `codex mcp-server` | Per-call | **Text-only** | No |
| `codex app-server` | Thread-based | Yes | Yes |

### Why not per-query spawn?

2-3 second overhead per message. No conversation context across messages.

### Why not MCP Server?

The MCP server interface is a text-only bottleneck:

```
MCP Client (image support) → MCP Server (text-only) → Codex Core (full multimodal)
```

```rust
// codex-rs/mcp-server/src/codex_tool_config.rs
pub struct CodexToolCallParam {
    pub prompt: String,  // Text only - no image support
}
```

YAAR users share images — this is a dealbreaker.

### Why App Server wins

- **Thread-based sessions** — create once, resume indefinitely
- **Full multimodal** — direct access to Codex core
- **Streaming deltas** — real-time text, reasoning, tool calls
- **Per-thread instructions** — each thread has its own system prompt
- **Bidirectional protocol** — server can request client input (approvals)

---

## Architecture

### Process Model

```
YAAR Server
└── Shared AppServer (child process: codex app-server)
    ├── Thread "default" (main agent)
    ├── Thread "window-1" (forked from default)
    ├── Thread "window-2" (forked from default)
    └── ... (one thread per agent)
```

### Why Shared AppServer

YAAR uses a **single shared AppServer** with multiple threads, rather than per-agent instances:

**Shared approach (current):**
- Lower memory footprint (one process)
- MCP servers configured once at startup, shared by all threads
- Thread forking inherits parent conversation context
- Turn serialization (one active turn at a time) prevents notification cross-talk

**Per-agent approach (future option):**
- Full isolation between agents
- Agent-specific MCP configurations
- Crash isolation (one agent down ≠ all agents down)
- Higher memory usage (one process per agent)

We use the shared approach because YAAR's MCP servers (system, window, storage, apps) are the same for all agents. If we need agent-specific tools, we'd switch to per-agent instances.

### Turn Serialization

App Server notifications lack thread/turn IDs. Only **one turn runs at a time** per AppServer process. YAAR enforces this with a turn semaphore:

```
Agent A wants to send → acquireTurn() → sends turn → receives notifications → releaseTurn()
Agent B wants to send → acquireTurn() blocks → ... → unblocked → sends turn → ...
```

### Connection Lifecycle

```
WebSocket connects → SessionManager
  → First message → ContextPool → AgentPool → acquires warm Codex provider
  → Provider has shared AppServer (via warm pool capture)
  → thread/start with baseInstructions → threadId stored as sessionId
  → Messages flow: prompt → turn/start → streaming notifications → StreamMessages
  → Window interaction → thread/fork from default session → independent window thread
  → WebSocket disconnects → provider.dispose() → release AppServer ref
```

### Warm Pool Integration

```
Server startup
  → initWarmPool()
  → createWarmProvider('codex')
  → new CodexProvider() → new AppServer() → spawn process → initialize()
  → provider.warmup() → thread/start (creates first thread)
  → Capture AppServer reference for sharing
  → Pool ready

New connection
  → warmPool.acquire() → pre-warmed provider with active thread
  → Subsequent providers: new CodexProvider(sharedAppServer)
  → Shares the same child process, creates own thread
```

---

## Protocol Reference

### Conversation Primitives

The App Server protocol has three primitives (per the Codex harness blog):

1. **Item** — Atomic unit of I/O (message, reasoning, tool call, diff, approval)
   - `item/started` → item begins (contains `itemId` and `itemType`)
   - `item/*/delta` → incremental streaming content
   - `item/completed` → item finalized

2. **Turn** — One unit of agent work per user input
   - `turn/started` → turn begins processing
   - Items stream within the turn
   - `turn/completed` → turn finishes (`status: "completed" | "interrupted"`)

3. **Thread** — Durable conversation container
   - `thread/start` → create with `baseInstructions`
   - `thread/resume` → reconnect to existing thread
   - `thread/fork` → branch into independent copy

### Notification Events We Handle

| Event | Maps To | Purpose |
|-------|---------|---------|
| `item/agentMessage/delta` | `StreamMessage { type: 'text' }` | Streaming response text |
| `item/reasoning/textDelta` | `StreamMessage { type: 'thinking' }` | Chain-of-thought |
| `item/mcpToolCall/started` | `StreamMessage { type: 'tool_use' }` | MCP tool invocation |
| `item/mcpToolCall/completed` | `StreamMessage { type: 'tool_result' }` | MCP tool result |
| `item/commandExecution/started` | `StreamMessage { type: 'tool_use' }` | Shell command start |
| `item/commandExecution/completed` | `StreamMessage { type: 'tool_result' }` | Shell command output |
| `turn/completed` | `StreamMessage { type: 'complete' }` | Turn finished |
| `turn/failed` | `StreamMessage { type: 'error' }` | Turn failed |
| `error` | `StreamMessage { type: 'error' }` | Protocol error |

### Events We Skip

| Event | Reason |
|-------|--------|
| `turn/started` | No content to yield |
| `item/agentMessage/completed` | Already streamed via deltas |
| `item/reasoning/completed` | Already streamed via deltas |
| `item/reasoning/summaryTextDelta` | Summary not needed |
| `item/reasoning/summaryTextCompleted` | Summary not needed |
| `item/started` | Item type tracking not yet implemented |
| `item/completed` | Item lifecycle tracking not yet implemented |
| `codex/event/*` | Internal telemetry (planned for Phase 4) |

### Bidirectional Requests (Not Yet Implemented)

The protocol is **fully bidirectional**. The server can send JSON-RPC **requests** (with `id` + `method`) that pause the turn until the client responds:

```
Server → Client (request):
{"id": 42, "method": "item/commandExecution/requestApproval", "params": {"command": "pnpm test"}}

Client → Server (response):
{"id": 42, "result": {"decision": "allow"}}
```

This is the approval flow. See [Roadmap: Phase 2](#phase-2-approval-flow) for implementation plan.

---

## Configuration

### App Server CLI Arguments

```bash
codex app-server \
  # Tools
  -c 'features.shell_tool=false' \          # Disable shell commands
  # MCP servers (YAAR's 4 namespaced servers)
  -c 'mcp_servers.system.url=http://127.0.0.1:8000/mcp/system' \
  -c 'mcp_servers.system.bearer_token_env_var=YAAR_MCP_TOKEN' \
  -c 'mcp_servers.window.url=http://127.0.0.1:8000/mcp/window' \
  -c 'mcp_servers.window.bearer_token_env_var=YAAR_MCP_TOKEN' \
  -c 'mcp_servers.storage.url=http://127.0.0.1:8000/mcp/storage' \
  -c 'mcp_servers.storage.bearer_token_env_var=YAAR_MCP_TOKEN' \
  -c 'mcp_servers.apps.url=http://127.0.0.1:8000/mcp/apps' \
  -c 'mcp_servers.apps.bearer_token_env_var=YAAR_MCP_TOKEN' \
  # Model
  -c 'model=gpt-5.3-codex' \
  -c 'model_reasoning_effort=medium' \
  -c 'model_personality=none' \
  # Execution
  -c 'sandbox_mode=danger-full-access' \
  -c 'approval_policy=never'
```

### Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `CI` | `1` | Disable interactive prompts |
| `YAAR_MCP_TOKEN` | Generated | Bearer token for MCP auth |
| `PORT` | `8000` | Auto-detected from server |

### Working Directory

Uses an isolated temp directory (`mkdtemp('codex-')`) to prevent:
- Reading `AGENTS.md` from the YAAR repo
- Auto-loading `~/.codex/skills/` instructions
- File contamination from shell commands

---

## Disabled Features & Rationale

YAAR is a desktop agent interface, not an IDE. Several Codex defaults work against this:

| Feature | Config | Why Disabled |
|---------|--------|-------------|
| Shell tool | `features.shell_tool=false` | No approval flow yet; re-enable in Phase 2 |
| Approval policy | `approval_policy=never` | No client-side approval UI yet |
| Web search | (default off with shell disabled) | YAAR controls HTTP access via MCP tools |
| View image | (default off) | YAAR handles images directly |
| Skills | Isolated temp dir | Auto-injected prompts contaminate agent personality |
| AGENTS.md | Isolated temp dir | Project files contaminate agent context |

### Instructions Constraint

From Codex source analysis:

> Instructions are applied at **init time** (thread creation), not per-turn.

Resolution order (from `codex.rs:285-294`):
1. `config.base_instructions` override (CLI/API)
2. `conversation_history.get_base_instructions()` (session persistence)
3. `model_info.get_model_instructions()` (model default)

Implications:
- System prompt is set via `baseInstructions` in `thread/start`
- Changing personality mid-conversation requires a new thread
- Per-turn instruction changes are ignored
- YAAR detects system prompt changes and creates new threads automatically

### The `instructions` Config Field is Dead Code

```rust
// ConfigToml struct in config/mod.rs
pub instructions: Option<String>,  // Never used!
```

No code reads `cfg.instructions`. Use `base_instructions` or `model_instructions_file` instead.

---

## Implementation Reference

### Key Files

| File | Purpose |
|------|---------|
| `packages/server/src/providers/codex/provider.ts` | `CodexProvider` implementing `AITransport` |
| `packages/server/src/providers/codex/app-server.ts` | `AppServer` process lifecycle manager |
| `packages/server/src/providers/codex/jsonrpc-client.ts` | JSON-RPC 2.0 client over stdio |
| `packages/server/src/providers/codex/types.ts` | JSON-RPC type definitions |
| `packages/server/src/providers/codex/message-mapper.ts` | Notification → `StreamMessage` mapping |
| `packages/server/src/providers/codex/system-prompt.ts` | YAAR desktop agent system prompt |
| `packages/server/src/providers/warm-pool.ts` | Warm pool with shared AppServer capture |

### Session Recovery

When the AppServer restarts (crash, idle timeout), threads become invalid:

1. `query()` catches errors containing "thread" or "invalid"
2. Invalidates `currentSession` (sets to `null`)
3. Recursively retries `query()` — creates a new thread automatically
4. User sees seamless conversation continuation

### Error Handling

- AppServer auto-restarts up to 3 times on crash (1-second delay between attempts)
- Session is invalidated on each restart
- `interrupt()` signals pending promise resolvers to unblock the query loop
- `dispose()` drains the turn queue so blocked providers unblock and fail gracefully

---

## Roadmap: Full Feature Unlock

See [docs/codex-app-server-plan.md](./docs/codex-app-server-plan.md) for the detailed implementation plan.

### Phase 1: Protocol Foundation
- Bidirectional JSON-RPC (server-initiated requests)
- Generated TypeScript types from `codex app-server generate-ts`
- Item lifecycle tracking (`item/started` → `item/completed`)

### Phase 2: Approval Flow
- Enable `shell_tool` and `apply_patch` with `approval_policy = "always"`
- Handle `item/commandExecution/requestApproval` server requests
- New `StreamMessage` type: `'approval_request'`
- Full-stack approval UI: server → WebSocket → frontend dialog → response

### Phase 3: Diff Handling
- Map `item/patch/*` notifications to a new `'diff'` StreamMessage
- Frontend diff renderer with syntax highlighting

### Phase 4: Enhanced Protocol
- Enriched `initialize` handshake with capabilities
- Thread archiving for memory management
- `codex/event/*` telemetry for operational metrics
- Per-agent AppServer instances (if needed)

---

## Appendix: Codex Internals

### Instruction-Related Fields

| Field | Location | Purpose | Status |
|-------|----------|---------|--------|
| `instructions` | ConfigToml | System instructions | **Dead code** |
| `base_instructions` | Config (runtime) | Actual system prompt | Active |
| `developer_instructions` | Config | Separate "developer" role | Active |
| `user_instructions` | Config | From AGENTS.md file | Active |
| `model_instructions_file` | ConfigToml/Profile | Path to instructions file | Active |

### Tool Disabling Reference

**Tools that CAN be disabled:**

| Tool | Config Option |
|------|---------------|
| Shell tools | `features.shell_tool = false` |
| Web search | `web_search = "disabled"` |
| View image | `tools_view_image = false` |
| Apply patch | `include_apply_patch_tool = false` |
| Collab tools | `features.collab = false` |

**Tools that CANNOT be disabled** (hard-coded in `build_specs()`):

- `plan` — Update plan tool
- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`

### MCP Server Tool Filtering

Per-server tool filtering via config:

```bash
codex app-server \
  -c 'mcp_servers.my_server.enabled_tools=["tool1","tool2"]' \
  -c 'mcp_servers.my_server.disabled_tools=["tool3"]'
```

`enabled_tools` is a whitelist; `disabled_tools` is a blacklist applied second.

### Approval Policies

| Policy | Behavior |
|--------|----------|
| `"never"` | Never ask for approval (current) |
| `"always"` | Ask before every tool execution |
| `"on-failure"` | Ask only after a command fails |

### App Server Process Components

From the Codex harness blog:

```
Client ←→ stdio reader ←→ Codex message processor ←→ Thread manager ←→ Core threads
```

- **stdio reader** — Parses JSON-RPC from stdin
- **Codex message processor** — Translates between JSON-RPC and Codex core operations
- **Thread manager** — Spins up one core session per thread
- **Core threads** — Independent Codex core instances with their own conversation state
