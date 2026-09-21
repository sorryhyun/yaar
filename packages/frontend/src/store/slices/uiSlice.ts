/**
 * UI slice - manages the restore prompt, window selection, and the shell form factor.
 */
import { detectFormFactor, type FormFactor } from '@/lib/formFactor';
import type { SliceCreator } from '../types';
import type { RestorePrompt } from '@/types/state';

export interface UiSliceState {
  restorePrompt: RestorePrompt | null;
  selectedWindowIds: string[];
  /** Shell layout: floating windows, or full-screen cards on a phone. See `lib/formFactor.ts`. */
  formFactor: FormFactor;
  /**
   * The phone card the user blew up to fill the whole screen, command palette and all.
   * Only in effect while that card is the one on top — see `selectFullscreenCardId`.
   */
  fullscreenWindowId: string | null;
  /**
   * Whether the phone's command palette is pulled up. It is a bottom sheet there:
   * collapsed to a handle by default so the screen belongs to the content, raised by
   * a pull-up from the bottom edge or a tap on the handle. Meaningless on a desktop,
   * where the palette is always on screen.
   */
  paletteSheetOpen: boolean;
  /** Whether the phone's notification shade is pulled down. See `NotificationShade`. */
  notificationShadeOpen: boolean;
}

export interface UiSliceActions {
  setRestorePrompt: (prompt: RestorePrompt | null) => void;
  dismissRestorePrompt: () => void;
  setSelectedWindows: (ids: string[]) => void;
  setFormFactor: (formFactor: FormFactor) => void;
  toggleFullscreenWindow: (windowId: string) => void;
  setPaletteSheetOpen: (open: boolean) => void;
  setNotificationShadeOpen: (open: boolean) => void;
}

export type UiSlice = UiSliceState & UiSliceActions;

export const createUiSlice: SliceCreator<UiSlice> = (set, _get) => ({
  restorePrompt: null,
  selectedWindowIds: [],
  formFactor: detectFormFactor(),
  fullscreenWindowId: null,
  // Both phone surfaces start put away. The palette's handle says it is there; the
  // shade answers a pull from the top edge — see `CommandPalette` and `PhoneGestures`.
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
