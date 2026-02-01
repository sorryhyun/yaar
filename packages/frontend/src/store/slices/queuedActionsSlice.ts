/**
 * Queued Actions slice - manages queued component actions for locked windows.
 */
import type { SliceCreator, QueuedActionsSlice } from '../types'

export const createQueuedActionsSlice: SliceCreator<QueuedActionsSlice> = (set, get) => ({
  queuedActions: {},

  queueComponentAction: (action) => set((state) => {
    const { windowId } = action
    if (!state.queuedActions[windowId]) {
      state.queuedActions[windowId] = []
    }
    state.queuedActions[windowId].push(action)
  }),

  consumeQueuedActions: (windowId) => {
    const actions = get().queuedActions[windowId] || []
    if (actions.length > 0) {
      set((state) => {
        state.queuedActions[windowId] = []
      })
    }
    return actions
  },

  clearQueuedActions: (windowId) => set((state) => {
    delete state.queuedActions[windowId]
  }),
})
