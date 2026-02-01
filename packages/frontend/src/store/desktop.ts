/**
 * The Desktop Store - where AI decisions become UI reality.
 *
 * When the AI emits an action like:
 *   {"type": "window.create", "windowId": "w1", "title": "Hello", ...}
 *
 * This store processes it and updates the state, causing React to render
 * the new window. The AI literally controls what appears on screen.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { DesktopStore } from './types'
import type { OSAction } from '@claudeos/shared'

// Import all slice creators
import {
  createWindowsSlice,
  createNotificationsSlice,
  createToastsSlice,
  createDialogsSlice,
  createConnectionSlice,
  createDebugSlice,
  createAgentsSlice,
  createUiSlice,
  createFeedbackSlice,
  createInteractionsSlice,
  createQueuedActionsSlice,
} from './slices'

export const useDesktopStore = create<DesktopStore>()(
  immer((...a) => ({
    // Combine all slices
    ...createWindowsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createToastsSlice(...a),
    ...createDialogsSlice(...a),
    ...createConnectionSlice(...a),
    ...createDebugSlice(...a),
    ...createAgentsSlice(...a),
    ...createUiSlice(...a),
    ...createFeedbackSlice(...a),
    ...createInteractionsSlice(...a),
    ...createQueuedActionsSlice(...a),

    // Action router - routes OS actions to appropriate slice handlers
    applyAction: (action: OSAction) => {
      const store = useDesktopStore.getState()

      // Log to activity log
      store.addToActivityLog(action)

      // Route to appropriate slice handler based on action type prefix
      const actionType = action.type

      if (actionType.startsWith('window.')) {
        store.handleWindowAction(action)
      } else if (actionType.startsWith('notification.')) {
        store.handleNotificationAction(action)
      } else if (actionType.startsWith('toast.')) {
        store.handleToastAction(action)
      } else if (actionType.startsWith('dialog.')) {
        store.handleDialogAction(action)
      }
    },

    applyActions: (actions: OSAction[]) => {
      const store = useDesktopStore.getState()
      for (const action of actions) {
        store.applyAction(action)
      }
    },
  }))
)

// Re-export selectors for backward compatibility
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
