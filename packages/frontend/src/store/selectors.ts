/**
 * Selectors for the desktop store.
 */
import type { DesktopStore, WindowModel, WindowAgent } from './types'
import { getRawWindowId } from './helpers'

export const selectWindowsInOrder = (state: DesktopStore) =>
  state.zOrder.map(id => state.windows[id]).filter(Boolean)

let _visibleCache: { zOrder: string[]; windows: Record<string, WindowModel>; monitorId: string; result: WindowModel[] } =
  { zOrder: [], windows: {}, monitorId: '', result: [] }
export const selectVisibleWindows = (state: DesktopStore): WindowModel[] => {
  if (state.zOrder === _visibleCache.zOrder && state.windows === _visibleCache.windows && state.activeMonitorId === _visibleCache.monitorId)
    return _visibleCache.result
  const result = state.zOrder
    .map(id => state.windows[id])
    .filter((w): w is WindowModel => w != null && !w.minimized && (w.monitorId ?? 'monitor-0') === state.activeMonitorId)
  _visibleCache = { zOrder: state.zOrder, windows: state.windows, monitorId: state.activeMonitorId, result }
  return result
}

export const selectMinimizedWindows = (state: DesktopStore) =>
  Object.values(state.windows).filter((w): w is WindowModel => w != null && w.minimized && (w.monitorId ?? 'monitor-0') === state.activeMonitorId)

export const selectToasts = (state: DesktopStore) =>
  Object.values(state.toasts)

export const selectNotifications = (state: DesktopStore) =>
  Object.values(state.notifications)

export const selectDialogs = (state: DesktopStore) =>
  Object.values(state.dialogs)

export const selectActiveAgents = (state: DesktopStore) =>
  Object.values(state.activeAgents)

export const selectWindowAgents = (state: DesktopStore) =>
  state.windowAgents

const windowAgentSelectors = new Map<string, (state: DesktopStore) => WindowAgent | undefined>()
export const selectWindowAgent = (windowId: string) => {
  let sel = windowAgentSelectors.get(windowId)
  if (!sel) {
    const rawId = getRawWindowId(windowId)
    sel = (state: DesktopStore) =>
      Object.values(state.windowAgents).find(wa => wa.windowId === rawId || wa.windowId === windowId)
    windowAgentSelectors.set(windowId, sel)
  }
  return sel
}

const queuedActionsCountSelectors = new Map<string, (state: DesktopStore) => number>()
export const selectQueuedActionsCount = (windowId: string) => {
  let sel = queuedActionsCountSelectors.get(windowId)
  if (!sel) {
    sel = (state: DesktopStore) => state.queuedActions[windowId]?.length ?? 0
    queuedActionsCountSelectors.set(windowId, sel)
  }
  return sel
}
