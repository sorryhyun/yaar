# Performance Issues

## MEDIUM Severity

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **Monitor sync subscribes to entire store** | `frontend/src/hooks/use-agent-connection/useMonitorSync.ts:16-35` | Creates new Set objects on every state change; monitors rarely change. GC overhead. |
| 2 | **Duplicate `/api/apps` fetches** | `frontend/src/components/overlays/SettingsModal.tsx:58` + `DesktopIcons.tsx:66` | Same endpoint fetched independently by two components. No shared cache. |
| 3 | **Window state O(N) suffix scan on every action** | `server/src/session/window-state.ts:39-50` | `resolve()` does linear scan of all windows for suffix match on every window operation. |
| 4 | **Iframe token regex runs on all iframe requests** | `server/src/http/server.ts:120-140` | Regex for `/api/apps/{appId}/` runs even for unrelated paths. |
| 5 | **MCP sessions grow unbounded** | `server/src/mcp/server.ts:40-42` | No TTL eviction — abandoned connections leak memory. |
| 6 | **Rubber-band selection expensive DOM work on every mousemove** | `frontend/src/components/desktop/DesktopSurface.tsx` | During drag-selection: `document.elementFromPoint` grid scan + two `querySelectorAll` passes + intersection computation. CPU-heavy on large selections. |
| 7 | **Window-agent lookup O(N) scan** | `frontend/src/store/selectors.ts` | `selectWindowAgent(windowId)` uses `Object.values().find()` — linear search per call, effectively O(windows * agents) across updates. |

## LOW Severity

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 8 | **Iframe token not cached on frontend** | `frontend/src/components/desktop/DesktopIcons.tsx:165-176` | Extra roundtrip per app window open. |
| 9 | **Settings sync not debounced** | `frontend/src/store/slices/settingsSlice.ts:93-97` | Language change fires immediate PATCH. |
| 10 | **Subscription registry O(N) prefix scan** | `server/src/http/subscriptions.ts:57-68` | Every URI change scans all subscriptions. |

## Recommended Fix Priority

1. **Use Zustand selectors for monitor sync** (#1) — subscribe only to relevant fields
2. **Cache `/api/apps` in store** (#2) — single fetch, shared across components
3. **Throttle rubber-band selection** (#6) — `requestAnimationFrame` coalescing, cache bounding boxes
4. **Convert window-agent lookup to direct map** (#7) — O(1) instead of O(N)
5. **Guard iframe regex with path prefix check** (#4) — skip regex for non-app paths
6. **Add MCP session TTL** (#5) — evict idle sessions after 5min
