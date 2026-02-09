/**
 * Selectors for the desktop store.
 */
import type { DesktopStore, WindowModel } from './types'
import { getRawWindowId } from './helpers'

export const selectWindowsInOrder = (state: DesktopStore) =>
  state.zOrder.map(id => state.windows[id]).filter(Boolean)

export const selectVisibleWindows = (state: DesktopStore) =>
  state.zOrder
    .map(id => state.windows[id])
    .filter((w): w is WindowModel => w != null && !w.minimized && (w.monitorId ?? 'monitor-0') === state.activeMonitorId)

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

export const selectWindowAgent = (windowId: string) => (state: DesktopStore) => {
  // windowId from component is scoped (e.g. "monitor-0/win-storage"),
  // but windowAgents uses raw IDs from the server. Compare both forms.
  const rawId = getRawWindowId(windowId)
  return Object.values(state.windowAgents).find(wa => wa.windowId === rawId || wa.windowId === windowId)
}

export const selectQueuedActionsCount = (windowId: string) => (state: DesktopStore) =>
  state.queuedActions[windowId]?.length ?? 0
