/**
 * UI slice - manages the restore prompt, window selection, and the shell form factor and
 * orientation.
 */
import { detectFormFactor, type FormFactor } from '@/lib/formFactor';
import { readOrientation, type Orientation } from '@/lib/device';
import type { DesktopStore, SliceCreator } from '../types';
import { selectFullscreenCardId } from '../selectors';
import type { RestorePrompt } from '@/types/state';

export interface UiSliceState {
  restorePrompt: RestorePrompt | null;
  selectedWindowIds: string[];
  /** Shell layout: floating windows, or full-screen cards on a phone. See `lib/formFactor.ts`. */
  formFactor: FormFactor;
  /** How the device is held. See `lib/device.ts`. */
  orientation: Orientation;
  /**
   * The phone card the user blew up to fill the whole screen, command palette and all.
   * Only in effect while that card is the one on top — see `selectFullscreenCardId`.
   */
  fullscreenWindowId: string | null;
  /**
   * The card whose full screen the user last put away. An app may not put that card back
   * in full screen (`requestAppFullscreen`) until the device turns — otherwise an app that
   * goes full screen whenever it is landscape takes it straight back on every Back press.
   */
  fullscreenDeclinedId: string | null;
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
  setOrientation: (orientation: Orientation) => void;
  /** The user's toggle — the card's title bar button, and Back on the way out. */
  toggleFullscreenWindow: (windowId: string) => void;
  /**
   * An app's own request (`yaar.device.setFullscreen`). Leaving is always granted; entering
   * only for the card on top of the phone's active monitor, and not for one the user took
   * out of full screen since the device last turned. A refusal is silent: the app learns
   * the outcome from the `fullscreen` it is pushed.
   */
  requestAppFullscreen: (windowId: string, on: boolean) => void;
  setPaletteSheetOpen: (open: boolean) => void;
  setNotificationShadeOpen: (open: boolean) => void;
}

export type UiSlice = UiSliceState & UiSliceActions;

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  restorePrompt: null,
  selectedWindowIds: [],
  formFactor: detectFormFactor(),
  orientation: readOrientation(),
  fullscreenWindowId: null,
  fullscreenDeclinedId: null,
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

  setOrientation: (orientation) =>
    set((state) => {
      if (state.orientation !== orientation) state.fullscreenDeclinedId = null;
      state.orientation = orientation;
    }),

  toggleFullscreenWindow: (windowId) =>
    set((state) => {
      const leaving = state.fullscreenWindowId === windowId;
      state.fullscreenWindowId = leaving ? null : windowId;
      state.fullscreenDeclinedId = leaving ? windowId : null;
    }),

  requestAppFullscreen: (windowId, on) => {
    const current = get();
    if (!on) {
      if (current.fullscreenWindowId === windowId) set({ fullscreenWindowId: null });
      return;
    }
    if (current.fullscreenDeclinedId === windowId) return;
    // Everything else that makes a card eligible is exactly what the selector honours.
    const would: DesktopStore = { ...current, fullscreenWindowId: windowId };
    if (selectFullscreenCardId(would) !== windowId) return;
    set({ fullscreenWindowId: windowId });
  },

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
