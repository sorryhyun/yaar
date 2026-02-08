# Codex App Server: Full Feature Unlock Plan

This plan covers the gaps between our current Codex integration and the full App Server protocol surface described in [Unlocking the Codex Harness](https://openai.com/index/unlocking-the-codex-harness/).

---

## Current State Summary

We have a working integration covering:
- JSON-RPC 2.0 over stdio (spawn `codex app-server` child process)
- Thread lifecycle: `thread/start`, `thread/resume`, `thread/fork`
- Turn-based streaming: `turn/start` → notifications → `turn/completed`
- Streaming deltas: `item/agentMessage/delta`, `item/reasoning/textDelta`
- MCP tool calls: `item/mcpToolCall/started|completed` (4 namespaced MCP servers)
- Shared AppServer with reference counting and warm pool
- Session recovery on crash (auto-restart up to 3 times)
- Image input support via `TurnInput`

What we're **not** doing:
- Approval flow (hardcoded `approval_policy = "never"`, `shell_tool = false`)
- Diff/patch items (`item/patch/*` or `apply_patch` tool)
- Server-initiated requests (JSON-RPC messages with `id` FROM server)
- Proper `item/started` → `item/completed` lifecycle tracking
- `codex app-server generate-ts` for type safety
- Thread archiving
- `initialize` capability negotiation
- `codex/event/*` telemetry/status events

---

## Phase 1: Protocol Foundation

**Goal:** Make the JSON-RPC layer bidirectional so the server can send requests (not just notifications) to our client.

### 1.1 — Support server-initiated requests in `JsonRpcClient`

Currently, `handleMessage()` treats any message with an `id` as a response to a pending request. But the App Server also sends **server-initiated requests** (messages with `id` + `method`) that expect a response from us. The approval flow depends on this.

**File:** `packages/server/src/providers/codex/jsonrpc-client.ts`

```
Current behavior:
  message has id → look up pendingRequests → resolve/reject

Required behavior:
  message has id AND method → server-initiated request → emit 'server_request'
  message has id, no method → response to our request → resolve/reject (existing)
  message has no id         → notification → emit 'notification' (existing)
```

Changes:
- Add `'server_request'` event type: `(id: number, method: string, params: unknown) => void`
- Add `respond(id: number, result: unknown)` method to send responses back
- Add `respondError(id: number, code: number, message: string)` method
- Discriminate in `handleMessage()`: if message has both `id` and `method`, it's a server request

### 1.2 — Generate TypeScript types from the protocol

Use `codex app-server generate-ts` to produce canonical type definitions. Compare against our hand-written `types.ts` to find missing notification types and fields.

**Action:**
```bash
codex app-server generate-ts > packages/server/src/providers/codex/generated-types.ts
```

Then either:
- (a) Use generated types directly and delete hand-written ones, or
- (b) Keep hand-written types but validate against generated schema in tests

**Recommendation:** Option (a) — use generated types. Add a `make codex-types` target that regenerates and formats them.

### 1.3 — Track item lifecycle with `item/started` and `item/completed`

Currently skipped. These events carry the item's `type` field which tells us what kind of deltas to expect. Important for distinguishing diff items from message items.

**File:** `packages/server/src/providers/codex/message-mapper.ts`

Changes:
- Parse `item/started` to extract `itemId` and `itemType`
- Maintain an `activeItems: Map<string, ItemType>` in the mapper (or pass through to provider)
- Use `item/completed` to finalize and clean up

---

## Phase 2: Approval Flow

**Goal:** Let Codex execute commands and apply patches with user approval routed through the YAAR UI.

### 2.1 — Enable tools with approval gating

**File:** `packages/server/src/providers/codex/app-server.ts`

Change configuration from:
```typescript
'-c', 'features.shell_tool=false',
'-c', 'approval_policy = "never"',
```
To:
```typescript
'-c', 'features.shell_tool=true',
'-c', 'approval_policy = "always"',
// or "on-failure" for less friction
```

This enables shell commands and `apply_patch` but requires client approval before execution.

### 2.2 — Handle `item/commandExecution/requestApproval`

When the App Server wants to run a command, it sends a **server-initiated request** (not a notification) with an `id`:

```json
{
  "id": 42,
  "method": "item/commandExecution/requestApproval",
  "params": {
    "command": "pnpm test",
    "reasoning": "Need to verify tests pass"
  }
}
```

The client must respond:
```json
{ "id": 42, "result": { "decision": "allow" } }
// or
{ "id": 42, "result": { "decision": "deny" } }
```

The turn **pauses** until we respond.

### 2.3 — New StreamMessage type: `'approval_request'`

**File:** `packages/server/src/providers/types.ts`

Extend `StreamMessage`:
```typescript
export interface StreamMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
       | 'complete' | 'error'
       | 'approval_request';  // NEW
  // ... existing fields ...
  approvalId?: number;        // JSON-RPC request id to respond to
  approvalType?: 'command' | 'patch' | 'other';
  command?: string;
  reasoning?: string;
}
```

### 2.4 — Route approval through YAAR UI

The flow:

```
App Server → requestApproval (JSON-RPC request with id)
  → CodexProvider yields { type: 'approval_request', approvalId, command }
  → AgentSession receives StreamMessage
  → BroadcastCenter → WebSocket → Frontend
  → Frontend shows approval dialog (OS Action window or notification)
  → User clicks Allow/Deny
  → WebSocket → Server → new message type: APPROVAL_RESPONSE
  → CodexProvider calls appServer.respond(approvalId, { decision })
  → App Server continues or aborts the command
```

**New components needed:**
1. **WebSocket event type:** `APPROVAL_RESPONSE` in shared package
2. **Frontend approval UI:** Modal/notification with Allow/Deny buttons
3. **Server routing:** `SessionManager` routes approval responses back to the Codex provider
4. **Provider method:** `respondToApproval(id: number, decision: 'allow' | 'deny')` on CodexProvider

### 2.5 — Auto-approve policy (optional)

For trusted operations, support an auto-approve list in config:
```json
{
  "codex_auto_approve": ["pnpm test", "pnpm typecheck", "pnpm lint"]
}
```

If the command matches a pattern, respond with `allow` immediately without showing UI.

---

## Phase 3: Diff Handling

**Goal:** Render file diffs produced by Codex as rich UI elements.

### 3.1 — Enable `apply_patch` tool

**File:** `packages/server/src/providers/codex/app-server.ts`

Ensure `include_apply_patch_tool` is not set to false (it's enabled by default when shell tools are on).

### 3.2 — Map diff notifications

When Codex applies a patch, it produces item events with diff content. Add handling in `message-mapper.ts`:

```typescript
case 'item/patch/started':
case 'item/patch/delta':
case 'item/patch/completed':
```

Map these to a new StreamMessage type `'diff'` with structured patch data (file path, hunks, before/after).

### 3.3 — Frontend diff renderer

Create a new OS Action or window content type that renders diffs:
- Syntax-highlighted before/after view
- Per-hunk accept/reject (future)
- File path header

---

## Phase 4: Enhanced Protocol Usage

### 4.1 — Enrich `initialize` handshake

**File:** `packages/server/src/providers/codex/app-server.ts`

Current:
```typescript
{ clientInfo: { name: 'yaar', version: '1.0.0' } }
```

Expanded:
```typescript
{
  clientInfo: {
    name: 'yaar',
    title: 'YAAR Desktop Agent',
    version: packageJson.version,  // read from package.json
  }
}
```

Store the server's response (capabilities, `userAgent`) for feature detection.

### 4.2 — Thread archiving

Add `thread/archive` support for cleaning up completed threads:
- Archive threads when a session disconnects
- Provide UI for browsing archived threads
- Reduces memory pressure in the App Server process

### 4.3 — Per-agent AppServer instances (conditional)

The shared AppServer approach works while all agents use the same MCP config. If we need agent-specific tools in the future:

- Factor out an `AppServerPool` that manages multiple processes
- Each "agent profile" gets its own AppServer with tailored MCP config
- Add idle timeout eviction and max instance limits
- Reference-count by active thread count

**Trade-off:** Higher memory usage but full isolation. Only implement when needed.

### 4.4 — `codex/event/*` telemetry

Currently silently skipped. These events carry useful operational data:
- Token usage per turn
- Model latency
- Tool execution timing

Map selected `codex/event/*` notifications to internal metrics or expose via `/api/agents/stats`.

---

## Phase 5: Developer Experience

### 5.1 — Debug tooling

Add a `make codex-debug` target that runs:
```bash
codex debug app-server send-message-v2 "your message here"
```

Useful for testing the protocol in isolation without YAAR.

### 5.2 — JSON Schema generation

Add `make codex-schema` target:
```bash
codex app-server generate-json-schema > docs/codex-app-server-schema.json
```

Use for documentation and client validation.

### 5.3 — Protocol version tracking

Store the App Server version from `initialize` response. Log warnings when the App Server version changes across restarts (potential breaking changes).

---

## Implementation Order

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| 1 | 1.1 — Bidirectional JSON-RPC | Small | Prerequisite for everything |
| 2 | 1.2 — Generated types | Small | Protocol safety |
| 3 | 2.1–2.3 — Approval flow (server side) | Medium | Unlocks shell/patch execution |
| 4 | 2.4 — Approval UI (full stack) | Medium | User-facing feature |
| 5 | 1.3 — Item lifecycle tracking | Small | Better observability |
| 6 | 3.1–3.3 — Diff handling | Medium | Rich code review UX |
| 7 | 4.1 — Initialize handshake | Small | Protocol correctness |
| 8 | 4.4 — Telemetry events | Small | Operational insight |
| 9 | 2.5 — Auto-approve | Small | Quality of life |
| 10 | 4.2 — Thread archiving | Small | Memory management |
| 11 | 4.3 — Per-agent instances | Large | Only if needed |

---

## Risk Notes

- **Approval timeout:** If the user doesn't respond, the turn hangs. Need a configurable timeout (e.g., 60s) with auto-deny.
- **Turn serialization:** Approval pauses the active turn, blocking the turn queue. Other agents waiting for a turn will be delayed. Consider whether approval responses should bypass the turn semaphore.
- **Shell in temp dir:** Commands execute in the isolated temp directory by default. For useful shell access, we may need to configure a proper working directory or let the agent specify one.
- **Security:** Enabling shell tools means Codex can propose arbitrary commands. The approval UI must clearly show what will be executed. Never auto-approve destructive commands (`rm`, `git push --force`, etc.).
