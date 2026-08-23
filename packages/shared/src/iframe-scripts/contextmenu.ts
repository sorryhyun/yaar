/**
 * Inline JS interaction helper for iframe apps.
 *
 * Handles interactions inside an app iframe:
 * 1. Right-click drawing — forwards pointer events to parent for freehand drawing
 * 2. Context menu — always suppressed (drawing uses right-click drag)
 * 3. Cursor tracking — posts `yaar:cursor-move` so parent overlays pinned to the
 *    cursor keep following it while the pointer is inside the frame
 * 4. Left click — posts `yaar:click` so parent can dismiss overlays
 * 5. Text drag — posts `yaar:drag-start` so parent can track cross-window drags
 * 6. Reserved shortcuts — posts `yaar:keydown` for the combos the shell owns
 *
 * Reaches the frame two ways, and needs both. `IframeRenderer` injects it on load,
 * which only works **same-origin** — an origin-isolated app (`source: 'user'`, the
 * default locally) throws on `contentDocument` and got none of the above. So the
 * compiler also bakes it into every compiled app (`compile.ts`), where it is the
 * only copy an isolated app ever has. Every listener here is therefore registered
 * at most once by `installGuard`, because a bundled app gets both.
 */
import { APP_MSG } from '../app-protocol.js';
import { installGuard } from './prelude.js';
export const IFRAME_CONTEXTMENU_SCRIPT = `
(function() {
  ${installGuard('__yaarContextMenuInstalled')}

  // Right-click drawing forwarding — the parent uses right-button drag for
  // freehand drawing, but pointer events don't cross iframe boundaries.
  // We use pointer events + setPointerCapture so the iframe keeps receiving
  // events even after the cursor exits, ensuring seamless cross-boundary strokes.
  var rightDragging = false;
  var rightPointerId = -1;

  document.addEventListener('pointerdown', function(e) {
    if (e.button !== 2) return;
    rightDragging = true;
    rightPointerId = e.pointerId;
    try { e.target.setPointerCapture(e.pointerId); } catch(ex) {}
    window.parent.postMessage({
      type: '${APP_MSG.arrowDragStart}',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('pointermove', function(e) {
    if (!rightDragging || e.pointerId !== rightPointerId) return;
    window.parent.postMessage({
      type: '${APP_MSG.arrowDragMove}',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('pointerup', function(e) {
    if (!rightDragging || e.pointerId !== rightPointerId) return;
    rightDragging = false;
    rightPointerId = -1;
    window.parent.postMessage({
      type: '${APP_MSG.arrowDragEnd}',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  // Cursor position forwarding — the desktop draws a spinner pinned to the
  // cursor while an agent runs. Pointer events don't cross the frame boundary,
  // so without this the parent's last sighting of the cursor is the frame's
  // edge and the spinner parks there for as long as the pointer is inside an
  // app. Coalesced to one post per animation frame; only the frame under the
  // cursor sends anything, so this is a single small message per painted frame
  // while the mouse is moving, and none at all while it is still.
  var cursorX = 0, cursorY = 0, cursorQueued = false;

  document.addEventListener('pointermove', function(e) {
    cursorX = e.clientX;
    cursorY = e.clientY;
    if (cursorQueued) return;
    cursorQueued = true;
    requestAnimationFrame(function() {
      cursorQueued = false;
      window.parent.postMessage({
        type: '${APP_MSG.cursorMove}',
        clientX: cursorX,
        clientY: cursorY
      }, '*');
    });
  });

  // Left click — notify parent so it can dismiss overlays, etc.
  document.addEventListener('click', function() {
    window.parent.postMessage({ type: '${APP_MSG.click}' }, '*');
  });

  // Always suppress the native context menu inside iframes.
  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
  });

  // Forward global keyboard shortcuts to the parent so they work even
  // when the iframe has focus (Shift+Tab, Ctrl+1-9, Ctrl+W).
  //
  // Capture phase on \`window\`, and the event is *claimed* — the contract in
  // \`app-protocol.ts\` (RESERVED_KEYBINDINGS) is that the shell handles these
  // "before any app sees them", and a bubble-phase listener on \`document\` is
  // the opposite of that: every app handler runs first, so an app that keys off
  // \`e.key === 'Tab'\` (devtools' editor did) consumed Shift+Tab, and one that
  // called stopPropagation() suppressed the forward entirely. preventDefault()
  // alone does not help there — it stops the browser's focus walk, not the
  // app's own handler.
  window.addEventListener('keydown', function(e) {
    var dominated = false;
    if (e.key === 'Tab' && e.shiftKey) dominated = true;
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') dominated = true;
    // Plain Ctrl+W only. Ctrl+Shift+W and Ctrl+Alt+W are combos an app may legally
    // bind (\`ctrl+w\` alone is reserved), and claiming them here ate the app's own
    // shortcut on its way to closing the window.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') dominated = true;
    if (!dominated) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // A pointer-locked app owns the keyboard, so Ctrl+W there is a player walking
    // forward with Ctrl held, not a request to destroy the window. The app cannot
    // claim the key through \`keybindings\` either: held-key movement is sampled with
    // \`createKeyState\`, never declared as a command, and \`ctrl+w\` itself is reserved.
    // preventDefault() above still stands — that is what keeps Chrome from closing the
    // browser window — so the chord simply does nothing until Esc releases the lock.
    // Only the close is withheld: Shift+Tab and Ctrl+1-9 stay live, because a player
    // locked into a game needs a way out that is not the mouse.
    if (document.pointerLockElement && e.ctrlKey && e.key.toLowerCase() === 'w') return;
    // \`top\`, not \`parent\` — the only message here that skips the intermediate frames.
    // An app can embed another app (devtools' preview does), and \`parent\` is one hop:
    // the inner frame's shortcut landed in the outer app, which has no handler for it,
    // and died there. The rest of this script posts to \`parent\` because it is reporting
    // frame-relative coordinates that only the direct embedder can place.
    (window.top || window.parent).postMessage({
      type: '${APP_MSG.keydown}',
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    }, '*');
  }, true);

  // Drag: notify parent so it can track cross-window drags.
  // Handles both text selection drags and draggable element drags (e.g. storage items).
  // This listener runs on document (bubble phase), so app-specific dragstart handlers
  // that set dataTransfer have already executed by the time we read it.
  document.addEventListener('dragstart', function(e) {
    var text = '';
    try {
      text = (window.getSelection() || '').toString().trim();
    } catch(ex) {}
    if (text) {
      // Text selection drag — also mark it for parent detection
      try { e.dataTransfer.setData('application/x-yaar-text', text); } catch(ex) {}
    } else {
      // Draggable element (no text selection) — read text/plain set by the app
      try { text = (e.dataTransfer.getData('text/plain') || '').trim(); } catch(ex) {}
    }
    if (!text) return;
    window.parent.postMessage({
      type: '${APP_MSG.dragStart}',
      text: text
    }, '*');
  });
})();
`;
