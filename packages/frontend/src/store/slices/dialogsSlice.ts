/**
 * Dialogs slice - manages confirmation dialogs.
 */
import type { SliceCreator, DialogsSlice, DialogsSliceState } from '../types'
import type { OSAction, PermissionOptions } from '@yaar/shared'

/**
 * Pure mutation function that applies a dialog action to an Immer draft.
 */
export function applyDialogAction(state: DialogsSliceState, action: OSAction): void {
  switch (action.type) {
    case 'dialog.confirm': {
      const permissionOptions = (action as { permissionOptions?: PermissionOptions }).permissionOptions
      state.dialogs[action.id] = {
        id: action.id,
        title: action.title,
        message: action.message,
        confirmText: action.confirmText ?? 'Yes',
        cancelText: action.cancelText ?? 'No',
        timestamp: Date.now(),
        permissionOptions,
      }
      break
    }
  }
}

export const createDialogsSlice: SliceCreator<DialogsSlice> = (set, _get) => ({
  dialogs: {},

  handleDialogAction: (action: OSAction) => set((state) => {
    applyDialogAction(state, action)
  }),

  respondToDialog: (id, _confirmed) => set((state) => {
    delete state.dialogs[id]
  }),
})
