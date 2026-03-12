/**
 * Dialogs slice - manages confirmation dialogs.
 */
import type { SliceCreator, DialogsSlice, DialogsSliceState } from '../types';
import type { OSAction, PermissionOptions, DialogConfirmAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

/**
 * Pure mutation function that applies a dialog action to an Immer draft.
 */
export const applyDialogAction = createApplyAction<
  DialogsSliceState,
  {
    id: string;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    timestamp: number;
    permissionOptions?: PermissionOptions;
  }
>('dialogs', 'dialog.confirm', (action: DialogConfirmAction) => ({
  id: action.id,
  title: action.title,
  message: action.message,
  confirmText: action.confirmText ?? 'Yes',
  cancelText: action.cancelText ?? 'No',
  timestamp: Date.now(),
  permissionOptions: action.permissionOptions,
}));

export const createDialogsSlice: SliceCreator<DialogsSlice> = (set, _get) => ({
  dialogs: {},

  handleDialogAction: (action: OSAction) =>
    set((state) => {
      applyDialogAction(state, action);
    }),

  respondToDialog: (id, _confirmed) =>
    set((state) => {
      delete state.dialogs[id];
    }),
});
