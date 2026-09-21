/**
 * Queued Actions slice - manages queued component actions for locked windows.
 */
import type { SliceCreator } from '../types';
import type { QueuedComponentAction } from '@/types/state';

export interface QueuedActionsSliceState {
  queuedActions: Record<string, QueuedComponentAction[]>;
}

export interface QueuedActionsSliceActions {
  queueComponentAction: (action: QueuedComponentAction) => void;
  consumeQueuedActions: (windowId: string) => QueuedComponentAction[];
}

export type QueuedActionsSlice = QueuedActionsSliceState & QueuedActionsSliceActions;

export const createQueuedActionsSlice: SliceCreator<QueuedActionsSlice> = (set, get) => ({
  queuedActions: {},

  queueComponentAction: (action) =>
    set((state) => {
      const { windowId } = action;
      if (!state.queuedActions[windowId]) {
        state.queuedActions[windowId] = [];
      }
      state.queuedActions[windowId].push(action);
    }),

  consumeQueuedActions: (windowId) => {
    const actions = get().queuedActions[windowId] || [];
    if (actions.length > 0) {
      set((state) => {
        state.queuedActions[windowId] = [];
      });
    }
    return actions;
  },
});
