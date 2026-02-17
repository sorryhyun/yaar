// Public API for the store
export { useDesktopStore, handleAppProtocolRequest } from './desktop';

// Selectors
export {
  selectWindowsInOrder,
  selectVisibleWindows,
  selectMinimizedWindows,
  selectWidgetWindows,
  selectPanelWindows,
  selectToasts,
  selectNotifications,
  selectDialogs,
  selectUserPrompts,
  selectActiveAgents,
  selectWindowAgents,
  selectWindowAgent,
  selectQueuedActionsCount,
} from './selectors';

// Types (for consumers that need them)
export type { DesktopStore } from './types';
