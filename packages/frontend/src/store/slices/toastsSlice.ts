/**
 * Toasts slice - manages toast notifications.
 */
import type { SliceCreator, DesktopStore } from '../types';
import type { ToastModel } from '@/types/state';
import type { ToastShowAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

export interface ToastsSliceState {
  toasts: Record<string, ToastModel>;
}

export interface ToastsSliceActions {
  dismissToast: (id: string) => void;
}

export type ToastsSlice = ToastsSliceState & ToastsSliceActions;

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
  },
  ToastShowAction
>(
  'toasts',
  'toast.show',
  (action) => ({
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
