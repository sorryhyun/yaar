# YAAR Architectural Suggestions — Remaining Items

Items completed in earlier phases (sessionId/connectionId decoupling, SessionHub + LiveSession, session-scoped broadcast/windows/cache/logging, event sequencing + resync, wss:// URL fix, join protocol) have been removed.

---

## Remaining Items

### 1. MCP Tool-Call Context Routing — Tighten Fallbacks

MCP tools resolve session context via `getSessionHub().getDefault()` closures in `register.ts`. This works for single-session, but fallbacks still create empty instances instead of failing:

```ts
return session?.windowState ?? new WindowStateRegistry()  // silent no-op
return session?.reloadCache ?? new ReloadCache('/dev/null') // silent no-op
```

**TODO:**
- Make MCP context resolution fail deterministically when no session exists (throw or return error to the tool caller).
- For multi-session support: route MCP calls by session using HTTP headers (`X-YAAR-Session-Id`) or URL params, instead of `getDefault()`.

**Files:** `packages/server/src/mcp/register.ts` (lines 25-32)

---

### 2. Warm-Session vs "First User Turn" Tracking

`ProviderLifecycleManager` uses a single `hasSentFirstMessage` flag. When a warm provider session exists, it sets this to `true`, which can skip `resumeSessionId` restore logic for the first real user message.

**TODO:**
- Split into two flags: `hasWarmSession` and `hasProcessedFirstUserTurn`.
- Gate restore and window initial-context injection on `hasProcessedFirstUserTurn`, not on whether a warm session exists.

**Files:** `packages/server/src/agents/session-policies/provider-lifecycle-manager.ts`, `packages/server/src/agents/session.ts`

---

### 3. Monitor Runtime — Scheduling & Budgets

Multi-monitor infrastructure exists (per-monitor main agents, sequential queues, monitor limit of 4), but lacks higher-level management.

**TODO:**
- Add scheduling/triggers (interval, event-driven, manual) for background monitor work.
- Add budgets: max concurrent monitor tasks, max tokens per minute, max action rate.
- Add monitor state persistence across restarts.
- Consider a chaining API (`spawnSubtask` / `awaitSubtasks`) for complex monitor workflows.
- Optional: monitor panel window showing current state, active subtask graph, errors.

**Files:** `packages/server/src/agents/context-pool.ts`, `packages/server/src/agents/agent-pool.ts`

---

### 4. Authentication Boundary (Before Remote Exposure)

No auth exists on WebSocket or HTTP endpoints. Required before exposing via tunnel/LAN.

**TODO:**
- Add bearer token validation on WebSocket upgrade (`/ws`) and all `/api/*` routes.
- Consider Cloudflare Access for tunnel setups.
- Optional: role-based permissions (viewer / controller / admin).
- Optional: pairing QR for mobile session join.

**Files:** `packages/server/src/websocket/server.ts`, `packages/server/src/http/server.ts`

---

### 5. Security Hardening (For Remote Mode)

**TODO:**
- Gate sensitive APIs (`/api/storage/*` write/delete) behind auth.
- Add rate limiting (WS messages/sec, tool calls/min, storage writes/min).
- Consider a "remote safe mode" (`YAAR_REMOTE=1`) that disables sandbox execution and high-risk tools.
- Audit logging for client joins/leaves, auth decisions, monitor activity.

---

## Open Questions

1. Should mobile be able to fully control (send messages / click buttons), or is read-only acceptable by default?
2. Where should monitors run by default on a mixed-provider setup (Claude vs Codex)?
3. How durable should monitor state be across restarts (best-effort vs strict)?
