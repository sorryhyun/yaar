/**
 * What a phone's Back button means to the shell: put away the one thing on top.
 *
 * Without this, Back walked the browser's history — and the desktop is a single page with
 * nothing in it, so the first Back left YAAR altogether (issue #118). `usePhoneBack` owns the
 * history plumbing; this is only the decision, in the order the user sees the layers.
 */
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { dismissTopSurface } from '@/hooks/useDismissable';
import { useDesktopStore, selectFullscreenCardId, type DesktopStore } from '@/store';

/** The card on screen: the focused window if it is a visible card, else the topmost one. */
function topCardId(state: DesktopStore): string | null {
  const isCard = (id: string | null): id is string => {
    const w = id ? state.windows[id] : undefined;
    return (
      !!w &&
      !w.minimized &&
      !w.windowStyle &&
      (!w.variant || w.variant === 'standard') &&
      (w.monitorId ?? DEFAULT_MONITOR_ID) === state.activeMonitorId
    );
  };
  if (isCard(state.focusedWindowId)) return state.focusedWindowId;
  for (let i = state.zOrder.length - 1; i >= 0; i--) {
    if (isCard(state.zOrder[i])) return state.zOrder[i];
  }
  return null;
}

/**
 * Take one step back. Returns false when there is nothing left to put away — the desktop
 * is bare, and the next Back is the user's to leave with.
 */
export function stepBack(): boolean {
  // Dialogs and the notification shade already sit on the Escape stack, newest on top.
  if (dismissTopSurface()) return true;

  const state = useDesktopStore.getState();
  if (state.paletteSheetOpen) {
    state.setPaletteSheetOpen(false);
    return true;
  }
  const fullscreen = selectFullscreenCardId(state);
  if (fullscreen) {
    state.toggleFullscreenWindow(fullscreen);
    return true;
  }
  if (state.cliMode) {
    state.setCliMode(false);
    return true;
  }
  // Minimize, never close: closing a card retires its app agent, and Back is a key people
  // press several times without looking. The card is still in the shade's window list.
  const card = topCardId(state);
  if (card) {
    state.userMinimizeWindow(card);
    return true;
  }
  return false;
}
