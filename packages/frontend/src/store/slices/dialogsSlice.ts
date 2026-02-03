/**
 * Dialogs slice - manages confirmation dialogs.
 */
import type { SliceCreator, DialogsSlice } from '../types'
import type { OSAction, PermissionOptions } from '@yaar/shared'

export const createDialogsSlice: SliceCreator<DialogsSlice> = (set, _get) => ({
  dialogs: {},

  handleDialogAction: (action: OSAction) => set((state) => {
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
  }),

  respondToDialog: (id, _confirmed) => set((state) => {
    delete state.dialogs[id]
  }),
})
