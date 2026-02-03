/**
 * Toasts slice - manages toast notifications.
 */
import type { SliceCreator, ToastsSlice, DesktopStore } from '../types'
import type { OSAction } from '@yaar/shared'

export const createToastsSlice: SliceCreator<ToastsSlice> = (set, _get) => ({
  toasts: {},

  handleToastAction: (action: OSAction) => set((state) => {
    switch (action.type) {
      case 'toast.show': {
        state.toasts[action.id] = {
          id: action.id,
          message: action.message,
          variant: action.variant ?? 'info',
          timestamp: Date.now(),
        }
        break
      }
      case 'toast.dismiss': {
        delete state.toasts[action.id]
        break
      }
    }
  }),

  dismissToast: (id) => set((state) => {
    const toast = state.toasts[id]
    delete state.toasts[id]
    ;(state as DesktopStore).interactionLog.push({
      type: 'toast.dismiss',
      timestamp: Date.now(),
      details: toast?.message,
    })
  }),
})
