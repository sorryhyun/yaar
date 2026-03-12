/**
 * Toasts slice - manages toast notifications.
 */
import type { SliceCreator, ToastsSlice, ToastsSliceState, DesktopStore } from '../types';
import type { OSAction, ToastShowAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

/**
 * Pure mutation function that applies a toast action to an Immer draft.
 */
export const applyToastAction = createApplyAction<
  ToastsSliceState,
  {
    id: string;
    message: string;
    variant: string;
    timestamp: number;
    action?: { label: string; eventId: string };
    duration?: number;
  }
>(
  'toasts',
  'toast.show',
  (action: ToastShowAction) => ({
    id: action.id,
    message: action.message,
    variant: action.variant ?? 'info',
    timestamp: Date.now(),
    action: action.action,
    duration: action.duration,
  }),
  'toast.dismiss',
);

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
