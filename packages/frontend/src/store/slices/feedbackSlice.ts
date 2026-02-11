/**
 * Feedback slice - manages rendering feedback for the server.
 */
import type { SliceCreator, FeedbackSlice } from '../types'

export const createFeedbackSlice: SliceCreator<FeedbackSlice> = (set, get) => ({
  pendingFeedback: [],
  pendingAppProtocolResponses: [],
  pendingAppProtocolReady: [],
  pendingAppInteractions: [],

  addRenderingFeedback: (feedback) => set((state) => {
    state.pendingFeedback.push(feedback)
  }),

  addPendingFeedback: (feedback) => set((state) => {
    state.pendingFeedback.push(feedback)
  }),

  consumePendingFeedback: () => {
    const feedback = get().pendingFeedback
    if (feedback.length > 0) {
      set((state) => {
        state.pendingFeedback = []
      })
    }
    return feedback
  },

  addPendingAppProtocolResponse: (item) => set((state) => {
    state.pendingAppProtocolResponses.push(item)
  }),

  consumePendingAppProtocolResponses: () => {
    const items = get().pendingAppProtocolResponses
    if (items.length > 0) {
      set((state) => {
        state.pendingAppProtocolResponses = []
      })
    }
    return items
  },

  addAppProtocolReady: (windowId) => set((state) => {
    state.pendingAppProtocolReady.push(windowId)
  }),

  consumeAppProtocolReady: () => {
    const items = get().pendingAppProtocolReady
    if (items.length > 0) {
      set((state) => {
        state.pendingAppProtocolReady = []
      })
    }
    return items
  },

  addPendingAppInteraction: (item) => set((state) => {
    state.pendingAppInteractions.push(item)
  }),

  consumePendingAppInteractions: () => {
    const items = get().pendingAppInteractions
    if (items.length > 0) {
      set((state) => {
        state.pendingAppInteractions = []
      })
    }
    return items
  },
})
