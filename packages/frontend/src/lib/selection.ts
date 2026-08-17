/**
 * Selection handling for the shell's drag surfaces.
 */

/**
 * Start a shell drag: drop any live text selection, then suppress the browser's own.
 *
 * `preventDefault()` on mousedown is what stops a drag from painting a text
 * selection across the desktop — but the same call also suppresses mousedown's
 * *other* default, collapsing whatever was already selected. Every shell drag
 * surface (titlebar, resize edges, desktop background, widget frames) prevents
 * default, and most window content is an iframe, which never clears the parent
 * document's selection. So a stray selection — from dragging the padding gap
 * inside a window, or double-clicking an unselectable spot like the gutter
 * between the titlebar buttons, both of which make Chrome select the whole
 * containing block — would have no click anywhere on screen that dismisses it.
 * Collapsing it explicitly here is what keeps "click away to deselect" true.
 */
export function beginShellDrag(e: { preventDefault: () => void }): void {
  globalThis.getSelection?.()?.removeAllRanges();
  e.preventDefault();
}
