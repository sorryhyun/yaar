/**
 * Dialogs slice - manages confirmation dialogs.
 */
import type { SliceCreator } from '../types';
import type { DialogModel } from '@/types/state';
import type { PermissionOptions, DialogConfirmAction, CapabilityLine } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

export interface DialogsSliceState {
  dialogs: Record<string, DialogModel>;
}

export interface DialogsSliceActions {
  respondToDialog: (id: string, confirmed: boolean) => void;
}

export type DialogsSlice = DialogsSliceState & DialogsSliceActions;

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
    capabilities?: CapabilityLine[];
  },
  DialogConfirmAction
>(
  'dialogs',
  'dialog.confirm',
  (action) => ({
    id: action.id,
    title: action.title,
    message: action.message,
    confirmText: action.confirmText ?? 'Yes',
    cancelText: action.cancelText ?? 'No',
    timestamp: Date.now(),
    permissionOptions: action.permissionOptions,
    capabilities: action.capabilities,
  }),
  // The server stopped waiting for an answer, so the dialog stops asking for one. Without
  // this the buttons stayed on screen wired to a request that had already been denied.
  'dialog.close',
);

export const createDialogsSlice: SliceCreator<DialogsSlice> = (set, _get) => ({
  dialogs: {},

  respondToDialog: (id, _confirmed) =>
    set((state) => {
      delete state.dialogs[id];
    }),
});
