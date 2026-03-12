# Performance Issues

## HIGH Severity

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **`/api/sessions` called on every CONNECTION_STATUS event** | `frontend/src/hooks/useAgentConnection.ts:63-90` | `checkForPreviousSession()` fires on connect, disconnect, reconnect — no caching or rate-limiting. 10-100+ redundant API calls per session. |
| 2 | **Zustand subscriptions fire on ALL state changes** | `frontend/src/hooks/use-agent-connection/usePendingEventDrainer.ts:38-114` | Two store subscriptions trigger on every state update (window moves, resizes, focus) — not just pending queue changes. 100+ wasted callback invocations/min. |
| 3 | **O(N*M) agent lookup on every MCP request** | `server/src/session/session-hub.ts:76-91` + `server/src/agents/agent-pool.ts:262-283` | `findSessionByAgent()` loops all sessions, then `hasAgent()` loops all 3 agent maps. Runs on every MCP tool call. |
| 4 | **`useAgentConnection` subscribes to entire Zustand store** | `frontend/src/hooks/useAgentConnection.ts` | Hook re-renders on every store mutation (window move, selection, incoming events) even when only action methods are needed. Amplifies desktop-level rendering under high event volume. |

## MEDIUM Severity

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 5 | **Monitor sync subscribes to entire store** | `frontend/src/hooks/use-agent-connection/useMonitorSync.ts:16-35` | Creates new Set objects on every state change; monitors rarely change. GC overhead. |
| 6 | **Duplicate `/api/apps` fetches** | `frontend/src/components/overlays/SettingsModal.tsx:58` + `DesktopIcons.tsx:66` | Same endpoint fetched independently by two components. No shared cache. |
| 7 | **Window state O(N) suffix scan on every action** | `server/src/session/window-state.ts:39-50` | `resolve()` does linear scan of all windows for suffix match on every window operation. |
| 8 | **Iframe token regex runs on all iframe requests** | `server/src/http/server.ts:120-140` | Regex for `/api/apps/{appId}/` runs even for unrelated paths. |
| 9 | **MCP sessions grow unbounded** | `server/src/mcp/server.ts:40-42` | No TTL eviction — abandoned connections leak memory. |
| 10 | **Rubber-band selection expensive DOM work on every mousemove** | `frontend/src/components/desktop/DesktopSurface.tsx` | During drag-selection: `document.elementFromPoint` grid scan + two `querySelectorAll` passes + intersection computation. CPU-heavy on large selections. |
| 11 | **Window-agent lookup O(N) scan** | `frontend/src/store/selectors.ts` | `selectWindowAgent(windowId)` uses `Object.values().find()` — linear search per call, effectively O(windows * agents) across updates. |

## LOW Severity

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 12 | **Iframe token not cached on frontend** | `frontend/src/components/desktop/DesktopIcons.tsx:165-176` | Extra roundtrip per app window open. |
| 13 | **Settings sync not debounced** | `frontend/src/store/slices/settingsSlice.ts:93-97` | Language change fires immediate PATCH. |
| 14 | **Subscription registry O(N) prefix scan** | `server/src/http/subscriptions.ts:57-68` | Every URI change scans all subscriptions. |

## Recommended Fix Priority

1. **Add reverse-index `agentId -> sessionId/monitorId`** (#3) — eliminates O(N*M) on every MCP call
2. **Use Zustand selectors everywhere** (#2, #4, #5) — subscribe only to relevant fields, not entire store
3. **Rate-limit/cache `checkForPreviousSession`** (#1) — short-circuit before the API call
4. **Cache `/api/apps` in store** (#6) — single fetch, shared across components
5. **Throttle rubber-band selection** (#10) — `requestAnimationFrame` coalescing, cache bounding boxes
6. **Convert window-agent lookup to direct map** (#11) — O(1) instead of O(N)
7. **Guard iframe regex with path prefix check** (#8) — skip regex for non-app paths
8. **Add MCP session TTL** (#9) — evict idle sessions after 5min
