/**
 * Selectors for the desktop store.
 */
import type { DesktopStore, WindowModel } from './types'

export const selectWindowsInOrder = (state: DesktopStore) =>
  state.zOrder.map(id => state.windows[id]).filter(Boolean)

export const selectVisibleWindows = (state: DesktopStore) =>
  state.zOrder
    .map(id => state.windows[id])
    .filter((w): w is WindowModel => w != null && !w.minimized)

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

export const selectWindowAgent = (windowId: string) => (state: DesktopStore) =>
  state.windowAgents[windowId]

export const selectQueuedActionsCount = (windowId: string) => (state: DesktopStore) =>
  state.queuedActions[windowId]?.length ?? 0
