# Backend Deduplication & Maintainability Audit

## Completed

- **Phase 1: Shared Agent Turn Orchestration** — `turn-helpers.ts` with `buildReloadContext()`, `runAgentTurn()`, `createBudgetOutputCallback()`. Refactored `MainTaskProcessor` and `WindowTaskProcessor`.
- **Phase 2: Shared Window Reducer & MCP Window Helpers** — `applyContentOperation()` in `@yaar/shared`, `formatWindowRef()` and `checkWindowAccess()` in `mcp/window/helpers.ts`. Deduplicated `WindowStateRegistry`, `window-restore.ts`, `create.ts`, `update.ts`, `lifecycle.ts`.
- **Phase 3: Typed Pending Stores And Session Event Bridge** — `PendingStore<TResult, TMeta>` in `mcp/pending-store.ts` replaces four identical pending map patterns in `ActionEmitter`. `subscribeSessionChannels()` helper in `live-session.ts` deduplicates session-scoped emitter listener setup/teardown.

---

## ~~Phase 3: Typed Pending Stores And Session Event Bridge~~ (Completed)

**Files:** new helper under `packages/server/src/mcp/`, modify:

- `packages/server/src/mcp/action-emitter.ts`
- `packages/server/src/session/live-session.ts`

`ActionEmitter` has four pending maps with nearly identical timeout / resolve / session-clear logic:

- rendering feedback
- dialogs
- user prompts
- app protocol requests

### Proposed extraction

Prefer a typed store over a generic `extra?: Record<string, unknown>` shape:

```typescript
class PendingStore<TResult, TMeta = void> {
  create(id: string, opts: {
    timeoutMs: number;
    sessionId?: string;
    defaultValue: TResult;
    meta?: TMeta;
  }): Promise<TResult>

  resolve(id: string, value: TResult): { resolved: boolean; meta?: TMeta }
  clearForSession(sessionId: string, defaultValue: TResult): void
}
```

### Important constraint

Dialogs need typed metadata (`PermissionOptions`) and post-resolution side effects (`savePermission(...)`). That logic should remain explicit in `ActionEmitter`; the store should manage lifecycle, not business rules.

### Related maintainability follow-up

`LiveSession` also repeats session-scoped event rebroadcast plumbing for:

- `'app-protocol'`
- `'approval-request'`
- `'user-prompt'`

Add a small helper for subscribing/unsubscribing session-scoped emitter channels so this logic does not keep growing ad hoc.

---

## Phase 4: Route/Input Helpers And BroadcastCenter Send Loop Dedup

**Files:** modify:

- `packages/server/src/http/routes/api.ts`
- `packages/server/src/http/utils.ts`
- `packages/server/src/session/broadcast-center.ts`

These are central files that will likely keep growing, so even modest cleanup has long-term value.

### HTTP route helpers

`api.ts` repeatedly:

- reads `await req.text()`
- checks for empty body
- parses JSON
- maps parse failures to 400 responses

Add helpers such as:

```typescript
async function readJsonBody<T>(req: Request): Promise<{ ok: true; value: T } | { ok: false; response: Response }>

function notFound(name: string): Response
```

Then use them to trim the shortcut, settings, restore, and domain endpoints.

This is not about turning the file into a framework; it is about removing mechanical parsing boilerplate so route logic remains visible.

### BroadcastCenter send helper

`publishToConnection`, `publishToSession`, `publishToMonitor`, and `broadcast` all repeat the same ready-state / `ws.send` / `try-catch` flow. Extract a private send helper plus a shared iteration path to reduce repeated transport logic.

---

## Phase 5: Opportunistic ID And Constant Cleanup

**Files:** new `packages/server/src/lib/ids.ts`, then targeted updates

This phase is intentionally last. It improves consistency, but it is lower leverage than the phases above.

### Candidate cleanup

- standardize ad hoc IDs where semantics are equivalent:
  - session IDs
  - connection IDs
  - shortcut IDs
  - relay IDs
  - some hook/component message IDs
- import `PORT` from `../../config.js` in `providers/claude/session-provider.ts` instead of re-parsing `process.env.PORT`

### Caution

Do not force all identifiers into one pattern if the current shape carries meaning:

- replay IDs
- request IDs that intentionally use counters
- IDs embedded in user-visible strings or logs

This should be a consistency pass, not an abstraction exercise.

---

## Deferred (not in scope)

| Finding | Reason to defer |
|---------|----------------|
| **Debounce/timer pattern** (session-logger.ts, cache.ts) | Only 2 consumers with slightly different semantics. Not worth abstracting yet. |
| **Path validation** (3 implementations in http/utils.ts, dev/helpers.ts, basic/helpers.ts) | Each serves a distinct purpose (boolean check, path-or-null, mount-aware). Low impact. |
| **PoolContext interface breadth** (pool-types.ts) | Works fine as-is. Interface segregation would add complexity without clear benefit. |
| **Log prefix inconsistency / structured logging** | Cosmetic for now. Worth revisiting only if log volume or observability needs materially increase. |
| **InteractionTimeline.drain()** | Possibly unused (only `drainAndFormat()` is called). Verify and remove if dead code. |
| **Error handling variance** (185 try-catch blocks, 7 patterns) | Too broad to address in one pass. Document conventions instead. |
| **Full route-file split of `api.ts`** | Probably useful eventually, but helper extraction should happen before larger file moves. |

---

## Verification

After each phase:
```bash
bun run --filter @yaar/server typecheck
bun run --filter @yaar/server test
```

After Phase 2 (touches `@yaar/shared`):
```bash
bun run --filter @yaar/shared typecheck
bun run --filter @yaar/shared test
```
