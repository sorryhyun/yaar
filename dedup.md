# Code Deduplication Audit

## Server-Side Duplication

### S2. URI Path Extraction (3 occurrences) — MEDIUM

**Files:** `handlers/apps.ts:42-46`, `handlers/market.ts:28-31`, `handlers/skills.ts:29-32`

Three nearly identical `extractXxxFromUri()` functions differing only in the regex authority segment.

**Fix:** Single `extractIdFromUri(uri, authority)` helper.

---

### S3. JSON Serialization `ok(JSON.stringify(data, null, 2))` (21 occurrences) — LOW

**Files:** 8 handler files, heaviest in `config.ts` (10) and `window.ts` (5).

**Fix:** Add `okJson(data)` to `handlers/utils.ts`.

---

### S4. Payload Field Validation (85+ occurrences) — HIGH

**Files:** All handler files. Pattern: `if (!payload?.field) return error('"field" is required.');`

No shared validation utility — each handler does ad-hoc null checks with templated error messages.

**Fix:** Create `requireField(payload, 'field')` / `requireAction(payload, ...validActions)` helpers. Or adopt Zod schemas for handler payloads.

---

### S5. Window Lock Checking (3 occurrences) — LOW

**File:** `handlers/window.ts:423-425, 475-477, 508-510`

```ts
const lockedBy = windowState.isLockedByOther(windowId, agentId);
if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
```

**Fix:** Extract `requireWindowUnlocked()` helper within window.ts.

---

### S7. Window Info Serialization (2 occurrences) — LOW

**File:** `handlers/window.ts:72-88` (list), `handlers/window.ts:197-209` (read)

Both construct window info objects with identical conditional spread fields (`appProtocol`, `variant`, `dockEdge`).

**Fix:** Extract `formatWindowInfo(win, opts?)` helper.

---

### S8. Action Emitter + Feedback Checking (4+ occurrences) — MEDIUM

**Files:** `handlers/window.ts`, `handlers/browser.ts`

```ts
const feedback = await actionEmitter.emitActionWithFeedback(osAction, timeout);
if (feedback && !feedback.success) return error(`Failed: ${feedback.error}`);
```

**Fix:** `emitActionChecked(osAction, timeout, contextMsg)` helper.

---

### S9. App Protocol Readiness Check (2 occurrences) — LOW

**File:** `handlers/window.ts:549-551, 591-593`

Identical `waitForAppReady` + timeout error in both `handleAppQuery` and `handleAppCommand`.

**Fix:** Extract `requireAppReady(windowState, windowId)`.

---

### S10. Window Existence Validation (3 occurrences) — LOW

**File:** `handlers/window.ts:421, 473, 506`

`if (!windowState.hasWindow(windowId)) return error(...)` repeated three times.

**Fix:** `requireWindowExists(windowState, windowId)`.

---

### S11. Type Assertion Functions (5+ occurrences) — MEDIUM

**Files:** `handlers/config.ts`, `handlers/window.ts`, `handlers/user.ts`, `handlers/agents.ts`

Multiple `assertXxx(resolved)` functions with identical structure, differing only in the `kind` string.

**Fix:** Generic `assertUri(resolved, 'window')` that narrows via discriminated union.

---

### S12. App Metadata Merging (2 occurrences) — MEDIUM

**Files:** `handlers/apps.ts:154-184`, `handlers/window.ts:302-327`

Both spread `appMeta?.variant`, `appMeta?.dockEdge`, `appMeta?.frameless`, `appMeta?.windowStyle` with identical conditional logic.

**Fix:** `mergeAppMetaDefaults(data, appMeta)` helper.

---

## Frontend Duplication

### F1. ID Generation Pattern (5+ occurrences) — MEDIUM

**Files:** `hooks/use-agent-connection/outbound-command-helpers.ts`, `store/slices/cliSlice.ts`, `store/helpers.ts`

`` `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` `` repeated with different prefixes.

**Fix:** `generateId(prefix)` utility.

---

### F3. Auto-Dismiss Timer Management (2 occurrences) — MEDIUM

**Files:** `components/overlays/NotificationCenter.tsx:13-36`, `components/overlays/ToastContainer.tsx:16-38`

Identical `useRef<Map>` + `useEffect` timer pattern for auto-dismissing timed items.

**Fix:** `useAutoDismiss(items, onDismiss, defaultDuration)` hook.

---

### F5. `Object.values()` Selectors (4 occurrences) — LOW

**File:** `store/selectors.ts:93-101`

`selectToasts`, `selectNotifications`, `selectDialogs`, `selectUserPrompts` — all just `Object.values(state.x)`.

**Fix:** `createObjectValuesSelector(key)` factory (minor).

---

### F6. Event Draining Blocks (6 occurrences) — MEDIUM

**File:** `hooks/use-agent-connection/usePendingEventDrainer.ts:42-112`

Six sequential if-blocks: check length → consume → loop send. Same structure, different queue/event-type pairs.

**Fix:** Data-driven drain config: `[{ key, consume, eventType }]` iterated in a single loop.

---

### F7. Drag/Resize Event Listener Registration (2 occurrences) — LOW

**Files:** `hooks/useDragWindow.ts:111-133`, `hooks/useResizeWindow.ts:101-113`

Identical `addEventListener` + `removeEventListener` + `listenersRef` cleanup pattern.

**Fix:** Shared `registerMouseTracking(moveHandler, upHandler, listenersRef)`.

---

### F8. Apply-Action Handler Pattern (4 occurrences) — MEDIUM

**Files:** `store/slices/notificationsSlice.ts`, `toastsSlice.ts`, `dialogsSlice.ts`, `userPromptsSlice.ts`

Each exports `applyXxxAction()` with identical show/dismiss switch structure over a `Record<string, T>`.

**Fix:** `createApplyAction(showType, dismissType)` factory.

---

### F9. CLI History Capping (2 occurrences) — LOW

**File:** `store/slices/cliSlice.ts:35-37, 66-68`

Same `if (arr.length > MAX) arr = arr.slice(-MAX)` logic duplicated.

**Fix:** `capArray(arr, max)` helper.

---

### F10. Agent ID Extraction (3+ occurrences) — LOW

**File:** `hooks/use-agent-connection/server-event-dispatcher.ts:99, 106, 119`

`(message as { agentId?: string }).agentId || 'default'` repeated.

**Fix:** `extractAgentId(message)` helper.

---

## Cross-Package Issues

### X1. `DEFAULT_MONITOR_ID` Defined Twice — MEDIUM

- `packages/shared/src/index.ts` (source of truth)
- `packages/frontend/src/constants/layout.ts` (duplicate)

**Fix:** Remove frontend duplicate, import from `@yaar/shared`.

---

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

### Phase 2 — Medium Impact
1. **S2** URI extraction helper
2. **S11** Generic `assertUri` function
3. **S12** App metadata merging helper
4. **S8** Action emitter feedback helper
5. **S4** Payload validation utilities (`requireField`, `requireAction`)
6. **F3** Auto-dismiss hook
7. **F6** Data-driven event drainer
8. **F8** Apply-action factory
9. **X1** Remove `DEFAULT_MONITOR_ID` duplicate

### Phase 3 — Low Impact / Polish
10. **S3** `okJson()` helper
11. **S5, S9, S10** Window handler micro-helpers
12. **F1** ID generation utility
13. **F5** `Object.values()` selector factory
14. **F7** Mouse tracking registration
15. **X2-X5** Config centralization, type aliases, build config
