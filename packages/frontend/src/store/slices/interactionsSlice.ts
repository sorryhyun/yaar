/**
 * Interactions slice - manages pending user interactions sent to the server.
 */
import type { SliceCreator, InteractionsSlice } from '../types';
import { createConsumeQueue } from '../helpers';

export const createInteractionsSlice: SliceCreator<InteractionsSlice> = (set, get) => ({
  pendingInteractions: [],
  pendingGestureMessages: [],

  consumePendingInteractions: createConsumeQueue(get, set, 'pendingInteractions'),

  queueGestureMessage: (content: string) => {
    set((state) => {
      state.pendingGestureMessages.push(content);
    });
  },

  consumeGestureMessages: createConsumeQueue(get, set, 'pendingGestureMessages'),
});
