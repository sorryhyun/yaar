/**
 * Feedback slice - manages rendering feedback for the server.
 */
import type { SliceCreator, FeedbackSlice } from '../types'

export const createFeedbackSlice: SliceCreator<FeedbackSlice> = (set, get) => ({
  pendingFeedback: [],

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
})
