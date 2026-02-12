# Parallel Capability: Handling Messages While the Agent is Busy

When a user sends a message while the main agent is already processing, YAAR has three strategies — tried in order. The first one that succeeds handles the message.

## Strategy Priority

```
User sends message while main agent is busy
│
├─ 1. Steer → inject into active turn (both providers)
│     Success: AI incorporates new input mid-response
│     Fail: provider doesn't support it, or turn just ended
│
├─ 2. Ephemeral agent → fresh provider, parallel response
│     Success: user gets a second response from a disposable agent
│     Fail: global agent limit reached
│
└─ 3. Queue → wait for main agent to finish
      Success: message processed when main agent is idle
      Fail: queue full (10 messages)
```

## 1. Mid-Turn Steering

**What it does**: Appends the user's new message into the AI's active turn. The AI sees the additional input and adjusts its response in-flight — no interruption, no separate response.

**When it works**: The main agent is mid-response and the provider supports steering.

**Provider implementations**:

| Provider | Mechanism | Requirement |
|----------|-----------|-------------|
| Claude | `Query.streamInput()` | Query started in streaming input mode (async generator prompt) |
| Codex | `turn/steer` JSON-RPC | Active turn with known `turnId` and `threadId` |

**Flow**:

```
ContextPool.queueMainTask()
  → AgentPool.steerMainAgent(monitorId, content)
    → AgentSession.steer(content)
      → AITransport.steer(content)          // optional interface method
        → Claude: currentQuery.streamInput(...)
        → Codex: appServer.turnSteer({ threadId, input, expectedTurnId })
  → if true: record to contextTape, send MESSAGE_ACCEPTED, done
  → if false: fall through to ephemeral
```

**Trade-offs**:
- Best UX — single coherent response that incorporates both messages
- No extra agent or provider needed
- May fail if the turn completes between the busy check and the steer call (graceful fallback)
- The steered content appears in the AI's context but isn't a separate conversation turn

## 2. Ephemeral Agent

**What it does**: Spins up a temporary agent with a fresh provider. The ephemeral agent processes the message in parallel with the main agent, then self-destructs.

**When it works**: Steer failed or unsupported, and the global agent limit hasn't been reached.

**Characteristics**:
- Fresh provider — no conversation history (gets open windows + reload cache only)
- Runs fully in parallel with the main agent
- Actions are recorded and pushed to the InteractionTimeline so the main agent sees what happened on its next turn
- Disposed immediately after the task completes

**Trade-offs**:
- User gets a response immediately (no waiting)
- No conversation context — ephemeral agent starts cold
- Consumes a global agent slot
- Two agents may issue conflicting actions (e.g., both trying to create windows)

## 3. Queue

**What it does**: Holds the message until the main agent finishes its current task, then processes it sequentially.

**When it works**: Both steer and ephemeral failed. Queue has capacity (max 10 messages per monitor).

**Characteristics**:
- Message processed with full conversation context (main agent has history)
- Sequential — preserves strict message ordering
- Frontend receives `MESSAGE_QUEUED` event with position

**Trade-offs**:
- User waits for the current task to finish
- Full context available — best for follow-up messages that depend on the current response
- No concurrency concerns

## Implementation

The decision logic lives in `ContextPool.queueMainTask()` (`packages/server/src/agents/context-pool.ts`):

```typescript
private async queueMainTask(task: Task): Promise<void> {
  const monitorId = task.monitorId ?? 'monitor-0';

  // Main agent idle → process directly
  if (!this.agentPool.isMainAgentBusy(monitorId)) {
    await this.processMainTask(...);
    return;
  }

  // 1. Try steer
  const steered = await this.agentPool.steerMainAgent(monitorId, task.content);
  if (steered) { /* record + accept */ return; }

  // 2. Try ephemeral
  const ephemeral = await this.agentPool.createEphemeral();
  if (ephemeral) { /* process in parallel */ return; }

  // 3. Queue
  queue.enqueue(task);
}
```

## Key Files

| File | Role |
|------|------|
| `agents/context-pool.ts` | Strategy selection in `queueMainTask()` |
| `agents/agent-pool.ts` | `steerMainAgent()`, `createEphemeral()` |
| `agents/session.ts` | `steer()` forwarding to provider |
| `providers/types.ts` | `AITransport.steer?()` interface |
| `providers/claude/session-provider.ts` | `steer()` via `Query.streamInput()` |
| `providers/codex/provider.ts` | `steer()` via `appServer.turnSteer()` |
| `providers/codex/app-server.ts` | `turnSteer()` JSON-RPC call |
