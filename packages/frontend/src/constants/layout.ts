/** Layout constants shared across window management, drag, and monitor logic. */
import { WINDOW_PLACEMENT } from '@yaar/shared';

export const TITLEBAR_HEIGHT = 36;

export const TASKBAR_HEIGHT = 36;

/**
 * Vertical space the command palette occupies at the bottom of the viewport:
 * the minimized-tab slot (36) + the input bar (~56) + its bottom margin (12).
 *
 * Maximized windows subtract this so their content never sits under the palette.
 * Re-exported from `@yaar/shared` rather than redeclared: the server's window
 * placement reserves the same strip when centering, and two copies would drift.
 */
export const COMMAND_PALETTE_HEIGHT = WINDOW_PLACEMENT.paletteInset;

/** Vertical offset to place the cursor in the middle of the title bar on unsnap/restore. */
export const TITLEBAR_CENTER_OFFSET = TITLEBAR_HEIGHT / 2;

/**
 * Minimum pixels of window edge that must remain visible inside the viewport
 * horizontally during creation and drag.
 */
export const MIN_VISIBLE_WINDOW_EDGE = 100;

/** Fallback viewport width when `globalThis.innerWidth` is unavailable (e.g. SSR/tests). */
export const DEFAULT_VIEWPORT_WIDTH = 1280;

/** Fallback viewport height when `globalThis.innerHeight` is unavailable. */
export const DEFAULT_VIEWPORT_HEIGHT = 720;

// The server mints monitor ids and enforces the cap; the frontend only hides the
// "add monitor" button at it. One number, in @yaar/shared.
export { MAX_MONITORS } from '@yaar/shared';

/** CSS class added to `<html>` during a window drag to suppress text selection. */
export const DRAGGING_CSS_CLASS = 'yaar-dragging';

/** `data-*` attribute placed on every WindowFrame root element for DOM queries. */
export const WINDOW_ID_DATA_ATTR = 'data-window-id';
