/** Layout constants shared across window management, drag, and monitor logic. */

/** Height of a window's title bar in pixels. */
export const TITLEBAR_HEIGHT = 36;

/** Height of the taskbar in pixels. */
export const TASKBAR_HEIGHT = 36;

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

/** Maximum number of virtual monitors (desktops) allowed per session. */
export const MAX_MONITORS = 4;

/** ID of the first monitor created automatically for every session. */
export const DEFAULT_MONITOR_ID = 'monitor-0';

/** CSS class added to `<html>` during a window drag to suppress text selection. */
export const DRAGGING_CSS_CLASS = 'yaar-dragging';

/** `data-*` attribute placed on every WindowFrame root element for DOM queries. */
export const WINDOW_ID_DATA_ATTR = 'data-window-id';
