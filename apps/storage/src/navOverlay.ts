export {};
import { createCollapsiblePanel } from '@bundled/yaar';

/**
 * Open/close state for the left nav overlay that holds the file list + toolbar, shared by the
 * UI and the protocol. The hover-expand + pin machine is `createCollapsiblePanel`; this module
 * only gives it `nav*` names.
 */

/** Grace period before the panel slides out, so a brief cursor exit doesn't flicker. */
export const CLOSE_DELAY_MS = 320;

const panel = createCollapsiblePanel({
  pinKey: 'nav-pin.json',
  closeDelayMs: CLOSE_DELAY_MS,
  pinLabel: 'nav pin state',
});

/** The panel is visible when pinned, or while the cursor is over it. */
export const navOpen = panel.expanded;
export const navPinned = panel.pinned;
export const openNav = panel.open;
export const scheduleNavClose = panel.scheduleClose;
export const closeNav = panel.close;
export const cancelNavClose = panel.cancelClose;
export const setNavPin = panel.setPin;
export const toggleNavPin = panel.togglePin;
/** True while the user is dragging the width handle — suppresses the auto-close. */
export const setNavResizing = panel.setResizing;
