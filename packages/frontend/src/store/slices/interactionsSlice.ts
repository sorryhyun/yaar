/**
 * Interactions slice - manages pending user interactions sent to the server.
 */
import type { SliceCreator, InteractionsSlice } from '../types';

export const createInteractionsSlice: SliceCreator<InteractionsSlice> = (set, get) => ({
  pendingInteractions: [],
  pendingGestureMessages: [],

  consumePendingInteractions: () => {
    const interactions = get().pendingInteractions;
    if (interactions.length > 0) {
      set((state) => {
        state.pendingInteractions = [];
      });
    }
    return interactions;
  },

  queueGestureMessage: (content: string) => {
    set((state) => {
      state.pendingGestureMessages.push(content);
    });
  },

  consumeGestureMessages: () => {
    const messages = get().pendingGestureMessages;
    if (messages.length > 0) {
      set((state) => {
        state.pendingGestureMessages = [];
      });
    }
    return messages;
  },
});
