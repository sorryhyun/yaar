# Codex App Server Protocol Reference

This document covers the Codex App Server JSON-RPC protocol, configuration, and internals. For a comparison of Claude vs Codex provider behavior within YAAR, see [claude_codex.md](./claude_codex.md).

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

## Protocol Reference

### JSON-RPC Basics (over stdio)

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
| `codex/event/*` | Internal telemetry |

### Bidirectional Requests (Approval Flow)

The protocol is **fully bidirectional**. The server can send JSON-RPC **requests** (with `id` + `method`) that pause the turn until the client responds:

```
Server → Client (request):
{"id": 42, "method": "item/commandExecution/requestApproval", "params": {"command": "pnpm test"}}

Client → Server (response):
{"id": 42, "result": {"decision": "accept"}}
```

**Handled request types:**

| Method | Description | Decision Values |
|--------|-------------|-----------------|
| `item/commandExecution/requestApproval` | Shell command approval | `accept`, `decline`, `acceptForSession`, `cancel` |
| `item/fileChange/requestApproval` | File modification approval | `accept`, `decline`, `acceptForSession`, `cancel` |

These are routed through YAAR's existing permission dialog system (`actionEmitter.showPermissionDialog()`), which supports "Remember my choice" persistence. The CodexProvider handles the request in `handleServerRequest()`, shows the dialog, and responds back via `appServer.respond()`.

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
| Shell tool | `features.shell_tool=false` | No approval flow yet |
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
