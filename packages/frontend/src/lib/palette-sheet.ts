/**
 * Raising the phone's palette sheet, from wherever the pull that asked for it was caught.
 *
 * Three places catch one: the handle at the bottom edge (`CommandPalette`), a pull up from
 * anywhere else on the screen (`PhoneGestures`), and the same pull from over an app card,
 * forwarded by the frame script. The second exists because the bottom edge is the system's
 * too — a pull that starts there keeps bringing up the phone's own navigation bar instead —
 * so all of them have to raise the sheet the same way, keyboard included, and this is that way.
 *
 * The sheet comes up **with the finger**, as the shade comes down with it (issue #122). It
 * used to go up the moment a pull said "up" — `paletteSheetOpen` set on touchmove — which
 * left nothing to aim with and no way back once it had started, and set off the effect that
 * focuses the textarea on `paletteSheetOpen`: a phone still inside the transient activation
 * of an earlier tap opens the keyboard for that focus, so a short nudge put the keyboard up
 * mid-drag. Now the drag only moves the collapsed sheet, through `--palette-pull` on the
 * `palette-pull` gesture layer (see `lib/gesture-layer`) and a `data-palette-pull` phase on
 * `<html>`; the store is untouched until the finger lifts, and then either the sheet opens
 * with the keyboard (`shouldRaisePalette`) or it goes back down. Either way the CSS
 * transition the collapsed sheet already has carries it from where the finger left it.
 *
 * The focus has to happen in the handler the user's gesture is still running, and not in
 * an effect keyed on `paletteSheetOpen`: a phone opens its keyboard only for a focus()
 * that a user gesture is currently activating, and by the time an effect fires that
 * gesture is over — so the sheet came up and the keyboard waited for a second tap on the
 * textarea. `inert` is cleared on the node first because React has not re-rendered yet
 * and nothing inside an inert subtree can take focus.
 */
import { useDesktopStore } from '@/store';
import { shouldRaisePalette } from './gestures';
import { clearGestureVars, setGestureVar } from './gesture-layer';

/** The sheet body's id — also what the handle's `aria-controls` names. */
export const PALETTE_SHEET_ID = 'palette-sheet';

const LAYER = 'palette-pull';
/** Set on `<html>` while a finger is pulling the collapsed sheet up. */
const PULL_STATE_ATTR = 'data-palette-pull';
/** How far up the collapsed sheet has been pulled, in px from parked. */
const PULL_VAR = '--palette-pull';

/** Raise the sheet and bring the keyboard up with it. Call from inside the gesture. */
export function openPaletteSheetWithKeyboard(): void {
  const sheet = document.getElementById(PALETTE_SHEET_ID);
  if (sheet) {
    sheet.inert = false;
    sheet.querySelector<HTMLElement>('[data-palette-input]')?.focus({ preventScroll: true });
  }
  useDesktopStore.getState().setPaletteSheetOpen(true);
}

/** Follow the finger: the collapsed sheet is `up` px above where it rests. */
export function trackPaletteRaise(up: number): void {
  const root = document.documentElement;
  if (!root.hasAttribute(PULL_STATE_ATTR)) root.setAttribute(PULL_STATE_ATTR, 'dragging');
  setGestureVar(LAYER, PULL_VAR, `${Math.max(0, up)}px`);
}

/**
 * Let go of a pull up of `up` px that took `elapsedMs`: raise the sheet with the keyboard if
 * it went far enough (or was a flick), otherwise let it fall back. Call from inside the
 * touchend, or the keyboard stays down. Returns whether the sheet went up.
 */
export function finishPaletteRaise(up: number, elapsedMs: number): boolean {
  const raise = shouldRaisePalette(up, elapsedMs);
  // Focused while the sheet is still where the finger holds it: focus() flushes style, and
  // with the pull already gone that flush would start the slide back down first.
  if (raise) openPaletteSheetWithKeyboard();
  cancelPaletteRaise();
  return raise;
}

/**
 * Give the sheet back to CSS without raising it — a pull taken back, a second finger, the
 * system taking the touch. A no-op when no pull is under way.
 */
export function cancelPaletteRaise(): void {
  document.documentElement.removeAttribute(PULL_STATE_ATTR);
  clearGestureVars(LAYER);
}
