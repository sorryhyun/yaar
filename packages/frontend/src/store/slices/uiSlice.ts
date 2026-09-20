/**
 * UI slice - manages the restore prompt, window selection, and the shell form factor.
 */
import { detectFormFactor } from '@/lib/formFactor';
import type { SliceCreator, UiSlice } from '../types';

export const createUiSlice: SliceCreator<UiSlice> = (set, _get) => ({
  restorePrompt: null,
  selectedWindowIds: [],
  formFactor: detectFormFactor(),
  fullscreenWindowId: null,
  // Both phone surfaces start put away. The palette's handle and the shade's badge are
  // what say they are there — see `CommandPalette` and `NotificationShade`.
  paletteSheetOpen: false,
  notificationShadeOpen: false,

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

  toggleFullscreenWindow: (windowId) =>
    set((state) => {
      state.fullscreenWindowId = state.fullscreenWindowId === windowId ? null : windowId;
    }),

  setPaletteSheetOpen: (open) =>
    set((state) => {
      state.paletteSheetOpen = open;
      // The two phone sheets come from opposite edges and would overlap; raising one
      // puts the other away rather than stacking them.
      if (open) state.notificationShadeOpen = false;
    }),

  setNotificationShadeOpen: (open) =>
    set((state) => {
      state.notificationShadeOpen = open;
      if (open) state.paletteSheetOpen = false;
    }),
});
