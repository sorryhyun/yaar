/**
 * UI slice - manages context menu, sessions modal, and restore prompt.
 */
import type { SliceCreator, UiSlice, DesktopStore } from '../types';

export const createUiSlice: SliceCreator<UiSlice> = (set, _get) => ({
  contextMenu: null,
  sessionsModalOpen: false,
  settingsModalOpen: false,
  restorePrompt: null,
  selectedWindowIds: [],

  showContextMenu: (x, y, windowId?) =>
    set((state) => {
      if (windowId) {
        const win = (state as DesktopStore).windows[windowId];
        if (win) {
          state.contextMenu = { x, y, windowId, windowTitle: win.title };
        }
      } else {
        state.contextMenu = { x, y };
      }
    }),

  hideContextMenu: () =>
    set((state) => {
      state.contextMenu = null;
    }),

  toggleSessionsModal: () =>
    set((state) => {
      state.sessionsModalOpen = !state.sessionsModalOpen;
    }),

  toggleSettingsModal: () =>
    set((state) => {
      state.settingsModalOpen = !state.settingsModalOpen;
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
