export {};
import { createCollapsiblePanel } from '@bundled/yaar';

/**
 * Open/close state for the left nav overlay that holds the file list + toolbar.
 *
 * This lives in its own module rather than inside a component because both the
 * navigation layer (which closes it after a file is selected) and the protocol
 * layer (which exposes it to the app agent) need to reach it. The hover-expand +
 * pin machine is the shared `createCollapsiblePanel` primitive; only the app's
 * `nav*` naming and the post-select rule live here.
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

/**
 * Called after the user picks a file. Pinning is an explicit "keep this open"
 * signal, so it takes priority over the auto-close.
 */
export function closeNavAfterSelect() {
  if (!panel.pinned()) panel.close();
}
