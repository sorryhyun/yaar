// Public API for the store
export { useDesktopStore } from './desktop';
export {
  handleAppProtocolRequest,
  handleVerbSubscriptionUpdate,
  tryIframeSelfCapture,
  getIframeDragSource,
  consumeIframeDragSource,
} from './iframe-bridge';

// Selectors
export {
  selectWindowsInOrder,
  selectVisibleWindows,
  selectMinimizedWindows,
  selectMinimizedIframeWindows,
  selectAllIframeWindows,
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
