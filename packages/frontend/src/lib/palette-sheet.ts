/**
 * Raising the phone's palette sheet, from wherever the pull that asked for it was caught.
 *
 * Two places catch one: the handle at the bottom edge (`CommandPalette`) and a pull up
 * from anywhere else on the screen (`PhoneGestures`). The second exists because the
 * bottom edge is the system's too — a pull that starts there keeps bringing up the
 * phone's own navigation bar instead — so both have to raise the sheet the same way,
 * keyboard included, and this is that way.
 *
 * The focus has to happen in the handler the user's gesture is still running, and not in
 * an effect keyed on `paletteSheetOpen`: a phone opens its keyboard only for a focus()
 * that a user gesture is currently activating, and by the time an effect fires that
 * gesture is over — so the sheet came up and the keyboard waited for a second tap on the
 * textarea. `inert` is cleared on the node first because React has not re-rendered yet
 * and nothing inside an inert subtree can take focus.
 */
import { useDesktopStore } from '@/store';

/** The sheet body's id — also what the handle's `aria-controls` names. */
export const PALETTE_SHEET_ID = 'palette-sheet';

/** Raise the sheet and bring the keyboard up with it. Call from inside the gesture. */
export function openPaletteSheetWithKeyboard(): void {
  const sheet = document.getElementById(PALETTE_SHEET_ID);
  if (sheet) {
    sheet.inert = false;
    sheet.querySelector<HTMLElement>('[data-palette-input]')?.focus({ preventScroll: true });
  }
  useDesktopStore.getState().setPaletteSheetOpen(true);
}
