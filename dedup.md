# Code Deduplication Audit

## Server-Side Duplication

### S3. JSON Serialization `ok(JSON.stringify(data, null, 2))` (21 occurrences) — LOW

**Files:** 8 handler files, heaviest in `config.ts` (10) and `window.ts` (5).

**Fix:** Add `okJson(data)` to `handlers/utils.ts`.

---

### S5. Window Lock Checking (3 occurrences) — LOW

**File:** `handlers/window.ts`

```ts
const lockedBy = windowState.isLockedByOther(windowId, agentId);
if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
```

**Fix:** Extract `requireWindowUnlocked()` helper within window.ts.

---

### S7. Window Info Serialization (2 occurrences) — LOW

**File:** `handlers/window.ts` (list and read)

Both construct window info objects with identical conditional spread fields (`appProtocol`, `variant`, `dockEdge`).

**Fix:** Extract `formatWindowInfo(win, opts?)` helper.

---

### S9. App Protocol Readiness Check (2 occurrences) — LOW

**File:** `handlers/window.ts`

Identical `waitForAppReady` + timeout error in both `handleAppQuery` and `handleAppCommand`.

**Fix:** Extract `requireAppReady(windowState, windowId)`.

---

### S10. Window Existence Validation (3 occurrences) — LOW

**File:** `handlers/window.ts`

`if (!windowState.hasWindow(windowId)) return error(...)` repeated three times.

**Fix:** `requireWindowExists(windowState, windowId)`.

---

## Frontend Duplication

### F1. ID Generation Pattern (5+ occurrences) — MEDIUM

**Files:** `hooks/use-agent-connection/outbound-command-helpers.ts`, `store/slices/cliSlice.ts`, `store/helpers.ts`

`` `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` `` repeated with different prefixes.

**Fix:** `generateId(prefix)` utility.

---

### F5. `Object.values()` Selectors (4 occurrences) — LOW

**File:** `store/selectors.ts`

`selectToasts`, `selectNotifications`, `selectDialogs`, `selectUserPrompts` — all just `Object.values(state.x)`.

**Fix:** `createObjectValuesSelector(key)` factory (minor).

---

### F7. Drag/Resize Event Listener Registration (2 occurrences) — LOW

**Files:** `hooks/useDragWindow.ts`, `hooks/useResizeWindow.ts`

Identical `addEventListener` + `removeEventListener` + `listenersRef` cleanup pattern.

**Fix:** Shared `registerMouseTracking(moveHandler, upHandler, listenersRef)`.

---

### F9. CLI History Capping (2 occurrences) — LOW

**File:** `store/slices/cliSlice.ts`

Same `if (arr.length > MAX) arr = arr.slice(-MAX)` logic duplicated.

**Fix:** `capArray(arr, max)` helper.

---

### F10. Agent ID Extraction (3+ occurrences) — LOW

**File:** `hooks/use-agent-connection/server-event-dispatcher.ts`

`(message as { agentId?: string }).agentId || 'default'` repeated.

**Fix:** `extractAgentId(message)` helper.

---

## Cross-Package Issues

### X2. `MARKET_URL` Duplicated — LOW

- `packages/server/src/handlers/apps.ts`
- `packages/server/src/handlers/market.ts`

**Fix:** Move to `config.ts`.

---

### X3. Env Var Parsing Scattered — LOW

- `config.ts` — centralized but incomplete
- `agents/limiter.ts` — inline `parseInt(process.env.MAX_AGENTS ?? '10', 10)`
- `providers/get-forced-provider.ts` — inline `process.env.PROVIDER`

**Fix:** `getEnvInt(key, default)` / `getEnvStr(key, default)` in config.ts; move all env access there.

---

### X4. ID Types Not Formalized — MEDIUM

`WindowId`, `AgentId`, `ConnectionId` used as raw `string` everywhere. No branded/nominal types in shared.

**Fix:** Export type aliases from `@yaar/shared` for documentation and future narrowing.

---

### X5. ESLint/Vitest Config Duplication — LOW

Both packages repeat identical base rules (unused var patterns, `no-explicit-any` warning, test file globs).

**Fix:** Root `eslint.config.base.js` + shared vitest preset.

---

## Recommended Fix Priority

### Phase 3 — Low Impact / Polish
1. **S3** `okJson()` helper
2. **S5, S9, S10** Window handler micro-helpers
3. **F1** ID generation utility
4. **F5** `Object.values()` selector factory
5. **F7** Mouse tracking registration
6. **X2-X5** Config centralization, type aliases, build config
