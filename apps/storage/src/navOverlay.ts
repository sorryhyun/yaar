export {};
import { createCollapsiblePanel, isNarrow } from '@bundled/yaar';

/**
 * Open/close state for the left nav overlay that holds the file list + toolbar, shared by the
 * UI and the protocol. The hover-expand + pin machine is `createCollapsiblePanel`; this module
 * only gives it `nav*` names.
 *
 * On a narrow window the panel is full-width, so it is a modal drawer there: the pin is
 * ignored (a pinned full-width panel would hide the preview on every mount, with no edge
 * to hover away from), and only the hamburger, the close button and opening a file move it.
 */

/** Grace period before the panel slides out, so a brief cursor exit doesn't flicker. */
export const CLOSE_DELAY_MS = 320;

const panel = createCollapsiblePanel({
  pinKey: 'nav-pin.json',
  closeDelayMs: CLOSE_DELAY_MS,
  pinLabel: 'nav pin state',
  drawer: isNarrow,
});

/** The panel is visible when pinned, or while the cursor is over it; a drawer only while opened. */
export const navOpen = panel.expanded;
export const navPinned = panel.pinned;
/** True on a narrow window, where the panel is a full-width drawer. */
export const navDrawer = panel.drawer;
export const openNav = panel.open;
export const scheduleNavClose = panel.scheduleClose;
export const closeNav = panel.close;
export const cancelNavClose = panel.cancelClose;
export const setNavPin = panel.setPin;
export const toggleNavPin = panel.togglePin;
/** True while the user is dragging the width handle — suppresses the auto-close. */
export const setNavResizing = panel.setResizing;
