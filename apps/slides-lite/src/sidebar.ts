import { createSignal } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';

/**
 * Hover-expand state for the collapsible slide-list sidebar.
 *
 * Modelled on thesingularity-reader's nav overlay: the panel is visible when
 * pinned, or while the cursor is over the sidebar. A short grace period before
 * the collapse keeps a brief cursor exit from flickering the panel shut.
 *
 * Lives in its own module (not the component) because the pin state is
 * persisted and the collapse must be cancellable from anywhere.
 */

/** Grace period before the panel folds back, so a brief cursor exit doesn't flicker. */
export const CLOSE_DELAY_MS = 260;

const [hovering, setHovering] = createSignal(false);
const [pinned, setPinned] = createSignal(false);

export { pinned as sidebarPinned };

/** The panel is expanded when pinned, or while the cursor is over the sidebar. */
export const sidebarExpanded = () => pinned() || hovering();

let closeTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelSidebarClose() {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export function openSidebar() {
  cancelSidebarClose();
  setHovering(true);
}

/** Arm the delayed fold. A re-entry calls openSidebar(), which cancels this. */
export function scheduleSidebarClose() {
  cancelSidebarClose();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    setHovering(false);
  }, CLOSE_DELAY_MS);
}

/** Fold immediately, ignoring the grace period. Pinned state still wins. */
export function closeSidebar() {
  cancelSidebarClose();
  setHovering(false);
}

/**
 * Pin state is persisted: it is an explicit "keep this open" preference, so it
 * survives a reload. Mirrors the load guard used elsewhere — the stored value
 * arrives async, and a user toggle that lands first must win over the late load.
 */
const PIN_KEY = 'sidebar-pin.json';
let pinTouched = false;
let pinLoaded = false;

void appStorage.readJsonOr<boolean>(PIN_KEY, false).then((stored) => {
  if (!pinTouched && stored === true) {
    setPinned(true);
    openSidebar();
  }
  pinLoaded = true;
});

function persistPin() {
  if (!pinLoaded && !pinTouched) return;
  void appStorage.trySave(PIN_KEY, JSON.stringify(pinned()), {
    label: 'sidebar pin state',
  });
}

export function setSidebarPin(v: boolean) {
  pinTouched = true;
  setPinned(v);
  persistPin();
  // Unpinning also clears the hover flag so the panel folds back; on a device
  // with no mouseleave, leaving it set would make the pin a one-way switch.
  if (v) openSidebar();
  else closeSidebar();
}

export function toggleSidebarPin() {
  setSidebarPin(!pinned());
}
