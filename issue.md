# Consolidate iframe token generation logic

## Problem

The "generate iframe token with app permissions" pattern is duplicated across multiple files:

1. **`handlers/window.ts`** — AI creates window via MCP tool
2. **`http/routes/api.ts`** — Desktop icon click (`/api/iframe-token` endpoint)
3. **`logging/window-restore.ts`** — Session restore / browser reconnect

Each call site independently resolves `appId`, loads `getAppMeta(appId)`, extracts `permissions`, and calls `generateIframeToken(windowId, sessionId, appId, permissions)`. This is error-prone — the original bug was caused by one call site (#2) forgetting to pass permissions.

## Current file layout

| File | Responsibility |
|------|---------------|
| `http/iframe-tokens.ts` | Low-level token store (generate/validate/revoke) |
| `http/routes/api.ts` | REST endpoint that creates tokens for client-side window opens |
| `handlers/window.ts` | Creates tokens when AI opens iframe windows |
| `logging/window-restore.ts` | `refreshIframeTokens()` for restore/reconnect |
| `session/live-session.ts` | Calls `refreshIframeTokens` from `generateSnapshot()` |

## Proposed change

Add a higher-level helper to `http/iframe-tokens.ts`:

```ts
/**
 * Generate an iframe token with permissions resolved from app.json.
 * Single entry point — all callers should use this instead of
 * calling generateIframeToken + getAppMeta separately.
 */
export async function generateAppIframeToken(
  windowId: string,
  sessionId: string,
  appId?: string,
): Promise<string> {
  const appMeta = appId ? await getAppMeta(appId) : null;
  return generateIframeToken(windowId, sessionId, appId, appMeta?.permissions);
}
```

Then each call site becomes a one-liner with no room for forgetting permissions.

`refreshIframeTokens` in `window-restore.ts` can also use `generateAppIframeToken` internally, removing its dependency on `getAppMeta`.

## Scope

Refactor only — no behavioral changes. Touch points:

- `http/iframe-tokens.ts` — add `generateAppIframeToken`
- `handlers/window.ts` — replace inline pattern
- `http/routes/api.ts` — replace inline pattern
- `logging/window-restore.ts` — replace inline pattern



# Performance Audit Notes (multi-window / heavy-app scenarios)

This note captures likely bottlenecks that show up when many windows/apps are open at once, especially GPU-heavy iframe apps (for example three.js-style content).

## 1) `useAgentConnection` subscribes to the entire Zustand store

- In `useAgentConnection`, many actions are pulled via `useDesktopStore()` with no selector.
- This means the hook re-renders on **every** store mutation (window movement, selection updates, incoming events), even when only action methods are needed.
- Because `DesktopSurface` uses this hook, desktop-level rendering work can be amplified under high event volume.

**Evidence:** `packages/frontend/src/hooks/useAgentConnection.ts`.

**Recommendation:**
- Replace the full-store subscription with selector-based picks for stable action references (or use `useDesktopStore.getState()` where reactivity is unnecessary).
- Keep only truly reactive values subscribed.

## 2) Rubber-band selection does expensive DOM work on every mousemove

- During desktop drag-selection, each mouse move:
  - scans a grid and calls `document.elementFromPoint` repeatedly,
  - then runs two global `querySelectorAll` passes (`[data-app-id]`, `[data-shortcut-id]`) and computes intersections.
- On large selections and many windows/icons, this can become CPU-heavy and can starve frame budget.

**Evidence:** `packages/frontend/src/components/desktop/DesktopSurface.tsx`.

**Recommendation:**
- Throttle the mousemove handler (e.g., `requestAnimationFrame` coalescing).
- Cache icon/window bounding boxes during drag-start and reuse until drag-end.
- Increase sampling step adaptively based on rectangle size.

## 3) Window-agent lookup scales poorly with window count

- `selectWindowAgent(windowId)` uses `Object.values(state.windowAgents).find(...)` for each window selector call.
- With many windows, this repeated linear search becomes costly (effectively O(windows × agents) across updates).

**Evidence:** `packages/frontend/src/store/selectors.ts`.

**Recommendation:**
- Maintain a direct map keyed by `windowId` (or precompute normalized IDs) so lookup is O(1).
- Avoid scanning `Object.values` inside selectors that run frequently.

## Suggested priority order

1. Fix full-store subscriptions in connection-layer hooks.
2. Throttle/cap rubber-band selection DOM probing.
3. Convert window-agent lookup to direct map access.
