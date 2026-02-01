// Public API for the store
export { useDesktopStore } from './desktop'

// Selectors
export {
  selectWindowsInOrder,
  selectVisibleWindows,
  selectToasts,
  selectNotifications,
  selectDialogs,
  selectActiveAgents,
  selectWindowAgents,
  selectWindowAgent,
  selectQueuedActionsCount,
} from './selectors'

// Types (for consumers that need them)
export type { DesktopStore } from './types'
