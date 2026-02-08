/**
 * Interactions slice - manages user interaction logging.
 */
import type { SliceCreator, InteractionsSlice } from '../types'
import { consolidateInteractions } from '../helpers'

export const createInteractionsSlice: SliceCreator<InteractionsSlice> = (set, get) => ({
  interactionLog: [],
  pendingInteractions: [],

  logInteraction: (interaction) => set((state) => {
    state.interactionLog.push({
      ...interaction,
      timestamp: Date.now(),
    })
    if (state.interactionLog.length > 50) {
      state.interactionLog = state.interactionLog.slice(-50)
    }
  }),

  consumeInteractions: () => {
    const interactions = get().interactionLog
    if (interactions.length > 0) {
      set((state) => {
        state.interactionLog = []
      })
    }
    return consolidateInteractions(interactions)
  },

  consumePendingInteractions: () => {
    const interactions = get().pendingInteractions
    if (interactions.length > 0) {
      set((state) => {
        state.pendingInteractions = []
      })
    }
    return interactions
  },
})
