# Issue: Context assignment logic is broken for parallel agents

## Summary

The context system was designed for parallelism (main agent + multiple window agents running concurrently) but the actual context assignment has two fundamental problems:

1. **Agents carry stale provider sessions** — reused agents continue their old provider thread instead of getting fresh context
2. **ContextTape is a shared mutable singleton** — built as a "single source of truth" but actually creates a confused dual-context system with the provider's own conversation history

The result: agents sometimes operate on outdated context, and the system maintains two diverging views of conversation history (the ContextTape and the provider's session thread).

## The two context systems

There are two independent context tracking mechanisms that are not properly synchronized:

### 1. ContextTape (server-side)

`ContextTape` in `agents/context.ts` is a flat append-only array of `{role, content, source}` messages shared across all agents in a connection. It records what was said and by whom.

- Main messages tagged with source `'main'`
- Window messages tagged with source `{ window: windowId }`
- Window agents receive the main conversation as a `contextPrefix` string injected into their prompt
- No automatic pruning — grows indefinitely

### 2. Provider session thread (provider-side)

Each `AgentSession` tracks a `sessionId` (the provider's thread/conversation ID) and `hasSentFirstMessage`. When an agent sends a message:

```
session.ts:247-256

if (forkSession && parentSessionId)     → use parent's thread (fork)
else if (resumeSessionId && !hasSentFirstMessage) → resume saved thread
else if (hasSentFirstMessage && sessionId)        → continue own thread
else                                              → start fresh
```

The provider (Claude) maintains its own conversation history in the thread. This is the **actual** context the AI sees. The ContextTape `contextPrefix` is injected as a string blob on top.

## Problem 1: Reused agents carry stale sessions

### How it happens

`AgentPool.release()` sets `currentRole = null` and starts an idle timer. It does NOT:
- Clear `sessionId`
- Reset `hasSentFirstMessage`
- Reset or dispose the provider

When `AgentPool.findIdle()` picks up this agent for a new task, the agent still has `hasSentFirstMessage = true` and a `sessionId`. The session resumption logic at `session.ts:254` kicks in:

```typescript
} else if (this.hasSentFirstMessage && this.sessionId) {
  sessionIdToUse = this.sessionId;  // continue old thread
}
```

This means:
- **Main agent reuse**: The primary agent (id=0) is never cleaned up. It continues the same provider thread across all main messages. This is intentional and correct — main conversation should be continuous.
- **Window agent reuse**: An idle agent that previously served `window-A` gets reused for `window-B`. It continues `window-A`'s provider thread with `window-B`'s content. The provider sees the conversation history from window-A, but gets a fresh `contextPrefix` from ContextTape that doesn't include window-A's messages.

### The mismatch

For window agents reused across different windows:

| Layer | What the agent sees |
|-------|-------------------|
| Provider thread | Window-A's full conversation history (stale) |
| ContextTape contextPrefix | Main conversation only (fresh, but no window history) |
| Current message | Window-B's user input (fresh) |

The AI receives contradictory context: the provider thread says "we were just talking about window-A's content" while the injected prefix says nothing about window-A.

## Problem 2: ContextTape contextPrefix duplicates and diverges from provider context

### For window agents (fork path)

When a window agent forks from the main agent's session (`session.ts:249`), the provider creates a child thread that already contains the main conversation. But ContextPool also injects the main conversation as a `contextPrefix` string:

```
context-pool.ts:338
const contextPrefix = this.contextTape.formatForPrompt({ includeWindows: false });
```

This means the window agent sees the main conversation **twice**:
1. In the forked provider thread's history
2. In the `contextPrefix` string injected into the user message

### For main agents (continuation path)

The main agent continues its provider thread, which has the full conversation. ContextPool does NOT inject a contextPrefix for main tasks (only open windows and reload options). This is correct.

### The inconsistency

Main agents rely on provider thread for context continuity. Window agents rely on both provider thread (forked) AND ContextTape prefix. When the two diverge (e.g., main conversation advances after a window agent forked), the window agent has a stale fork but a fresh prefix — contradictory signals.

## Problem 3: No context isolation for parallel window tasks

When multiple window tasks run in parallel, they all read from and write to the same ContextTape:

```
T=0: Window-A starts, reads contextPrefix (main messages 1-5)
T=1: Window-B starts, reads contextPrefix (main messages 1-5)
T=2: Main agent completes message 6, appends to tape
T=3: Window-A completes, appends to tape
T=4: Window-B completes, appends to tape
```

The tape now has: `[main-1, ..., main-5, main-6, window-A-response, window-B-response]`

But Window-A and Window-B both operated with context that only included `main-1...5`. The tape records a linear history that doesn't reflect the actual parallel execution. If a future window-C reads the tape, it sees a misleading sequence.

## Problem 4: Window context is never pruned automatically

`ContextTape.pruneWindow(windowId)` exists but is never called automatically when a window closes. The `WindowStateRegistry` tracks closes and has an `onWindowCloseCallback`, but it's only used for reload cache invalidation. The tape keeps accumulating dead window messages forever.

## Problem 5: Dead agent-to-connection mapping (now fixed)

`BroadcastCenter` had `registerAgent()`/`unregisterAgent()` methods that were never called from production code. `WindowStateRegistryManager.init()` used `getConnectionForAgent()` to route actions to the right connection's window state, but it always returned `undefined` because the mapping was never populated. This meant **server-side window state tracking via the action emitter path was silently broken**.

Fixed: now uses `getCurrentConnectionId()` from `AsyncLocalStorage`, which is set during `agentContext.run()` in `session.ts:298`.

## Root cause

The architecture tried to serve two masters:

1. **Provider-native conversation continuity** — let the AI provider manage conversation history in its thread, with session forking for branches
2. **Server-side context assembly** — manually build prompts from a shared tape and inject context as strings

These two approaches are fundamentally in tension. The provider thread is the "real" context the AI operates on, but the server tries to overlay its own context view on top. When agents are reused or sessions are forked, the two views diverge.

## Possible directions

### Option A: Provider thread as single source of truth

Stop using ContextTape for prompt injection. Let the provider thread be the sole context. Use ContextTape only for logging/debugging. This means:
- Window agents fork cleanly and only see what the provider thread contains
- No duplicate context injection
- Reused agents need explicit session reset or fresh providers

### Option B: ContextTape as single source of truth

Stop relying on provider session continuity. Each message gets a fresh provider thread (no sessionId reuse). Build the full context from ContextTape every time. This means:
- No stale provider threads
- Full control over what the agent sees
- Higher latency (no provider-side caching)
- Larger prompts (full history injected each time)

### Option C: Clean separation

- Main agent: uses provider thread continuity (option A)
- Window agents: always get fresh providers with ContextTape-assembled context (option B)
- Release resets agent session state completely

This avoids the stale-reuse problem for windows while keeping main agent efficiency.

## Problem 6: Logging session survives reset, stale thread IDs persist

### The logging session is never recycled

`ContextPool.initialize()` creates a `SessionLogger` with a `logSessionId` once. When `reset()` fires, it disposes all agents and clears the context tape, but `logSessionId` and `sharedLogger` are kept. The new primary agent logs into the same `session_logs/{id}/` directory. Pre-reset and post-reset activity are stitched into one session file.

This means a single "session" can contain multiple unrelated conversations separated by resets. If the user resets 5 times, the session log has 5 disjoint conversations with no boundary markers.

### Stale thread IDs survive in metadata.json

`SessionLogger.logThreadId()` writes thread IDs to `metadata.json`:

```
metadata.threadIds = {
  "default": "thread-abc",       // from pre-reset main agent
  "window-win1": "thread-xyz"    // from pre-reset window agent
}
```

After reset, old agents are disposed but metadata.json still has their thread IDs. The new primary agent eventually overwrites `default` with a new thread ID on its first message. But window thread IDs from pre-reset linger forever.

On server restart, `lifecycle.ts` reads `metadata.threadIds` and passes all of them as `savedThreadIds`. The system then tries to resume stale pre-reset window threads that no longer have meaningful context.

### Codex resume is silently broken

The resume path assumes provider threads persist across server restarts. This works for Claude (API-side sessions) but not for Codex:

- Codex threads live only inside the `app-server` subprocess
- Server restart kills the app-server, making all saved thread IDs invalid
- `CodexProvider.query()` calls `threadResume({ threadId })` on a thread that doesn't exist
- Error recovery catches the failure, nullifies `currentSession`, and retries with a fresh thread
- Resume silently degrades to a new conversation — the AI loses all provider-side context

The ContextTape prefix still gets injected as a string blob, so the AI sees some history. But it's flat text with no structure — tool results, thinking blocks, and conversation turns are all collapsed into a single user message.

### What should change

- Reset should create a new logging session (new `session_logs/{id}/` directory) or at minimum write a reset boundary marker
- `metadata.threadIds` should be cleared on reset so stale thread IDs don't leak into future restores
- Codex resume should be disabled or handled explicitly — either skip the `threadResume` call entirely, or detect the failure and log a warning instead of silently falling back

## Affected files

| File | Role |
|------|------|
| `agents/context-pool.ts` | Task orchestration, context assembly, agent reuse |
| `agents/agent-pool.ts` | Agent lifecycle, `release()` doesn't reset session state |
| `agents/session.ts` | Session resumption logic, `hasSentFirstMessage` persistence |
| `agents/context.ts` | ContextTape shared mutable state |
| `agents/context-pool-policies/context-assembly-policy.ts` | Dual prompt/contextContent assembly |
| `logging/session-logger.ts` | Thread ID persistence, session metadata not cleared on reset |
| `lifecycle.ts` | Reads stale savedThreadIds on startup, no Codex-awareness |
| `providers/codex/provider.ts` | Silent fallback on failed threadResume |
