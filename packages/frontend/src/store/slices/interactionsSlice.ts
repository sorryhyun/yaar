/**
 * Interactions slice - manages pending user interactions sent to the server.
 */
import type { SliceCreator } from '../types';
import type { UserInteraction } from '@yaar/shared';
import { createConsumeQueue } from '../helpers';

export interface InteractionsSliceState {
  pendingInteractions: UserInteraction[];
  pendingGestureMessages: string[];
}

export interface InteractionsSliceActions {
  consumePendingInteractions: () => UserInteraction[];
  queueGestureMessage: (content: string) => void;
  consumeGestureMessages: () => string[];
}

export type InteractionsSlice = InteractionsSliceState & InteractionsSliceActions;

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
