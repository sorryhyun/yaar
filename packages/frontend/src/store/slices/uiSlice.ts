/**
 * UI slice - manages the restore prompt, window selection, and the shell form factor.
 */
import { detectFormFactor } from '@/lib/formFactor';
import type { SliceCreator, UiSlice } from '../types';

export const createUiSlice: SliceCreator<UiSlice> = (set, _get) => ({
  restorePrompt: null,
  selectedWindowIds: [],
  formFactor: detectFormFactor(),

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

  setFormFactor: (formFactor) =>
    set((state) => {
      state.formFactor = formFactor;
    }),
});
