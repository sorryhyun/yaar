/**
 * Toasts slice - manages toast notifications.
 */
import type { SliceCreator, ToastsSlice, ToastsSliceState, DesktopStore } from '../types';
import type { OSAction } from '@yaar/shared';

/**
 * Pure mutation function that applies a toast action to an Immer draft.
 */
export function applyToastAction(state: ToastsSliceState, action: OSAction): void {
  switch (action.type) {
    case 'toast.show': {
      state.toasts[action.id] = {
        id: action.id,
        message: action.message,
        variant: action.variant ?? 'info',
        timestamp: Date.now(),
        action: action.action,
        duration: action.duration,
      };
      break;
    }
    case 'toast.dismiss': {
      delete state.toasts[action.id];
      break;
    }
  }
}

export const createToastsSlice: SliceCreator<ToastsSlice> = (set, _get) => ({
  toasts: {},

  handleToastAction: (action: OSAction) =>
    set((state) => {
      applyToastAction(state, action);
    }),

  dismissToast: (id) =>
    set((state) => {
      const toast = state.toasts[id];
      delete state.toasts[id];
      (state as DesktopStore).pendingInteractions.push({
        type: 'toast.dismiss',
        timestamp: Date.now(),
        details: toast?.message,
      });
    }),
});
