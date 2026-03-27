/**
 * UI slice - manages sessions modal and restore prompt.
 */
import type { SliceCreator, UiSlice } from '../types';

export const createUiSlice: SliceCreator<UiSlice> = (set, _get) => ({
  sessionsModalOpen: false,
  restorePrompt: null,
  selectedWindowIds: [],

  toggleSessionsModal: () =>
    set((state) => {
      state.sessionsModalOpen = !state.sessionsModalOpen;
    }),

  setRestorePrompt: (prompt) =>
    set((state) => {
      state.restorePrompt = prompt;
    }),

  dismissRestorePrompt: () =>
    set((state) => {
      state.restorePrompt = null;
    }),

  setSelectedWindows: (ids) =>
    set((state) => {
      state.selectedWindowIds = ids;
    }),
});
