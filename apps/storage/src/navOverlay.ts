export {};
import { createSignal } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';

/**
 * Open/close state for the left nav overlay that holds the file list + toolbar.
 *
 * This lives in its own module rather than inside a component because both the
 * navigation layer (which closes it after a file is selected) and the protocol
 * layer (which exposes it to the app agent) need to reach it.
 */

/** Grace period before the panel slides out, so a brief cursor exit doesn't flicker. */
export const CLOSE_DELAY_MS = 320;

const [navHovering, setNavHovering] = createSignal(false);
const [navPinned, setNavPinned] = createSignal(false);

export { navPinned };

/** The panel is visible when pinned, or while the cursor is over it. */
export const navOpen = () => navPinned() || navHovering();

let closeTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelNavClose() {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export function openNav() {
  cancelNavClose();
  setNavHovering(true);
}

/**
 * True while the user is dragging the width handle. The pointer routinely leaves
 * the panel box mid-drag — pointer capture keeps routing the move events to the
 * handle, but the browser still fires mouseleave on the panel — and letting that
 * arm the close would collapse the panel out from under the drag.
 */
let resizing = false;

export function setNavResizing(active: boolean) {
  resizing = active;
  if (active) cancelNavClose();
}

/** Arm the delayed close. A re-entry calls openNav(), which cancels this. */
export function scheduleNavClose() {
  cancelNavClose();
  if (resizing) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    setNavHovering(false);
  }, CLOSE_DELAY_MS);
}

/** Close immediately, ignoring the grace period. Pinned state still wins. */
export function closeNav() {
  cancelNavClose();
  setNavHovering(false);
}

/**
 * Pin state is persisted: it is an explicit "keep this open" preference, so it
 * has to survive a restart the same way panelWidth does. The stored value
 * arrives async, and a user toggle that lands first must win over the late load.
 */
const PIN_KEY = 'nav-pin.json';
let pinTouched = false;
let pinLoaded = false;

void appStorage.readJsonOr<boolean>(PIN_KEY, false).then((stored) => {
  if (!pinTouched && stored === true) {
    setNavPinned(true);
    openNav();
  }
  pinLoaded = true;
});

function persistPin() {
  if (!pinLoaded && !pinTouched) return;
  void appStorage.trySave(PIN_KEY, JSON.stringify(navPinned()), {
    label: 'nav pin state',
  });
}

export function setNavPin(pinned: boolean) {
  pinTouched = true;
  setNavPinned(pinned);
  persistPin();
  // Unpinning must also clear the hover flag. On a touch device no mouseleave
  // ever fires, so leaving it set would make the toggle a one-way switch.
  if (pinned) openNav();
  else closeNav();
}

export function toggleNavPin() {
  setNavPin(!navPinned());
}

/**
 * Called after the user picks a file. Pinning is an explicit "keep this open"
 * signal, so it takes priority over the auto-close.
 */
export function closeNavAfterSelect() {
  if (!navPinned()) closeNav();
}
