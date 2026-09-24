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
 * 6. Reserved shortcuts — posts `yaar:keydown` for the combos the shell owns, and
 *    for Shift+Left/Right (monitor stepping) when the app let that one go by
 * 7. File drops — posts `yaar:file-drop` for OS files dropped on content the app did
 *    not handle itself, instead of letting the browser open the file
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

  // Touch drags the phone shell has a use for — but a touch inside an app frame never
  // reaches its listeners, so without this an app card was only pannable from the 20px
  // gutters at the screen's edges and could not pull the shade down at all. Sideways is
  // the monitor pan, downwards the shade. A drag nothing in here has a use for is claimed
  // and its travel handed out; the rules for "has a use for" mirror the shell's own
  // \`panBlockFrom\` / \`canPullFrom\` in PhoneGestures.tsx, plus the two signals only the
  // app has: a \`touch-action\` that keeps that axis for itself, and a touchmove the app
  // already cancelled. Touch screens only, so a desktop is never asked to give up a drag
  // it has no pan for.
  var coarse = false;
  try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch(ex) {}
  var pan = null;

  function keepsAxis(style, axis) {
    var ta = style.touchAction;
    return !!ta && ta !== 'auto' && ta !== 'manipulation' && ta.indexOf(axis) === -1;
  }

  function panBlock(el) {
    var block = { left: false, right: false };
    for (var node = el && el.nodeType === 1 ? el : null; node; node = node.parentElement) {
      if (node.hasAttribute('data-no-pan')) return null;
      if (node.getAttribute('role') === 'slider') return null;
      if (node.tagName === 'INPUT' && String(node.type).toLowerCase() === 'range') return null;
      var style = getComputedStyle(node);
      if (keepsAxis(style, 'pan-x')) return null;
      if (node.scrollWidth > node.clientWidth + 1 &&
          (style.overflowX === 'auto' || style.overflowX === 'scroll')) {
        var at = Math.abs(node.scrollLeft);
        if (at > 1) block.right = true;
        if (at < node.scrollWidth - node.clientWidth - 1) block.left = true;
        if (block.left && block.right) return null;
      }
    }
    return block;
  }

  // Whether a downward drag from here would have scrolled nothing: every scroller under
  // the finger, the document's own included, already at its top.
  function canPull(el) {
    var doc = document.scrollingElement;
    if (doc && doc.scrollTop > 0) return false;
    for (var node = el && el.nodeType === 1 ? el : null; node; node = node.parentElement) {
      if (node.hasAttribute('data-no-pan')) return false;
      var style = getComputedStyle(node);
      if (keepsAxis(style, 'pan-y')) return false;
      if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1 &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll')) return false;
    }
    return true;
  }

  function postPan(phase, dx, dy, axis) {
    window.parent.postMessage(
      { type: '${APP_MSG.touchPan}', phase: phase, dx: dx, dy: dy, axis: axis }, '*');
  }

  if (coarse) {
    document.addEventListener('touchstart', function(e) {
      if (pan && pan.claimed) postPan('cancel', 0, 0, pan.axis);
      pan = null;
      var t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      var block = panBlock(e.target);
      var pull = canPull(e.target);
      if (!block && !pull) return;
      pan = { x: t.screenX, y: t.screenY, block: block, pull: pull, axis: null, claimed: false };
    }, { capture: true, passive: true });

    // Passive, and it must stay so. A non-passive touchmove on \`window\` makes every touch
    // scroll in the frame wait for this frame's main thread to run it, and every isolated
    // app shares one origin and so one main thread. With this listener non-passive, any
    // app busy for ten seconds froze touch scrolling in *every* app for those ten seconds,
    // and tapping did not help. There is nothing to cancel anyway: a drag is only ever
    // claimed when the browser has nothing to scroll in that direction (\`panBlock\`,
    // \`canPull\`). The one thing the browser could still do with it is chain it out of
    // the frame into the shell's pull-to-refresh or back-swipe, and the
    // \`overscroll-behavior\` below stops that without a listener.
    //
    // Bubble phase on \`window\`: every app handler has run, so an app that cancelled the
    // move from its own non-passive listener has already said the drag is its own.
    var contain = document.createElement('style');
    contain.textContent = ':where(html){overscroll-behavior:none}';
    (document.head || document.documentElement).appendChild(contain);

    window.addEventListener('touchmove', function(e) {
      var t = e.touches[0];
      if (!pan || !t) return;
      var dx = t.screenX - pan.x, dy = t.screenY - pan.y;
      if (!pan.axis) {
        var appTook = e.defaultPrevented;
        // DRAG_INTENT_PX / DRAG_AXIS_RATIO from the shell's lib/gestures.ts.
        var ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax >= 10 && ax >= ay * 1.2) pan.axis = 'x';
        else if (ay >= 10) pan.axis = 'y';
        else return;
        var ours = pan.axis === 'y'
          ? pan.pull && dy > 0
          : !!pan.block && !pan.block[dx > 0 ? 'right' : 'left'];
        if (appTook || !ours) {
          pan = null;
          return;
        }
        pan.claimed = true;
        postPan('start', dx, dy, pan.axis);
      }
      postPan('move', dx, dy, pan.axis);
    }, { passive: true });

    window.addEventListener('touchend', function(e) {
      var p = pan;
      pan = null;
      var t = e.changedTouches[0];
      if (!p || !t) return;
      var dx = t.screenX - p.x, dy = t.screenY - p.y;
      // A fast flick can arrive as start and end with no move between: the shell decides
      // from the travel alone whether that was a swipe. SWIPE_MIN_PX / SWIPE_AXIS_RATIO.
      if (!p.claimed) {
        if (p.axis) return;
        var ax = Math.abs(dx), ay = Math.abs(dy);
        if (p.block && ax >= 56 && ax >= ay * 1.4 && !p.block[dx > 0 ? 'right' : 'left']) {
          p.axis = 'x';
        } else if (p.pull && dy >= 56 && ay >= ax * 1.4) {
          p.axis = 'y';
        } else {
          return;
        }
        postPan('start', 0, 0, p.axis);
      }
      postPan('end', dx, dy, p.axis);
    }, true);

    window.addEventListener('touchcancel', function() {
      if (pan && pan.claimed) postPan('cancel', 0, 0, pan.axis);
      pan = null;
    }, true);
  }

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
    // Only the close is withheld: Shift+Tab and Ctrl+1-9 stay live, because a player
    // locked into a game needs a way out that is not the mouse.
    //
    // Do not read this line as the thing holding the window, and do not drop the
    // preventDefault() above on the theory that it is redundant. What we measured:
    // a top-level page cancels Ctrl+W perfectly well (three presses, three keydowns,
    // window intact), yet a pointer-locked app in a normal tabbed Chrome still lost
    // its window with this guard in place. It survives once the browser is opened
    // with --app, which is what scripts/dev/start.sh now does. Which of the two is
    // load-bearing, and where a tabbed window takes the accelerator that a top-level
    // document keeps, is not understood — so both stay until it is.
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

  // Shift+Left/Right steps the shell along its monitors, but it is *not* reserved:
  // text fields and plenty of apps (editors, spreadsheets, games) use it for selection
  // or movement. So this listener claims nothing. It waits until the whole dispatch is
  // over (setTimeout, not a microtask — microtasks run between listeners) and forwards
  // the keystroke only if nobody called preventDefault() on it, which is what a
  // \`keybindings\` entry, CodeMirror, or any app handling the key does. A native field
  // with text in it never preventDefaults its own selection, so that case is excluded
  // up front (\`holdsText\`, which mirrors \`editableHoldsText\` in the frontend's
  // \`lib/shellShortcuts.ts\`), as is a pointer-locked app, which owns the keyboard.
  function holdsText(el) {
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.isContentEditable) return (el.textContent || '') !== '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value !== '';
    return el.tagName === 'SELECT';
  }
  window.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.repeat || e.isComposing || document.pointerLockElement) return;
    if (holdsText(e.target)) return;
    setTimeout(function() {
      if (e.defaultPrevented) return;
      (window.top || window.parent).postMessage({
        type: '${APP_MSG.keydown}',
        key: e.key,
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false
      }, '*');
    }, 0);
  });

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

  // OS files dropped on the frame's content. The shell's drop handling sits on the
  // window frame and never sees a drag over the iframe, and a frame nobody prepared
  // lets the browser open the dropped file itself. So a drop no handler of the app's
  // own took is handed to the desktop, which gives it to the app's \`app.onDrop\` hook
  // or to the agent — one decision for frame and content alike (iframe-bridge/drop.ts).
  //
  // Bubble phase on \`window\`, after every app handler: an app that handles a drop
  // itself (preventDefault on dragover/drop) keeps it. Files only — text dropped into
  // an input is the browser's to insert.
  var localDrag = false;
  document.addEventListener('dragstart', function() { localDrag = true; }, true);
  document.addEventListener('dragend', function() { localDrag = false; }, true);

  function claimableFileDrop(e) {
    // A drag that started in this document is the app's own, not a drop from the OS.
    if (e.defaultPrevented || localDrag) return false;
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    var hasFiles = false;
    for (var i = 0; i < types.length; i++) {
      if (types[i] === 'Files') hasFiles = true;
    }
    if (!hasFiles) return false;
    // A file input takes a dropped file natively — that is its whole job.
    var t = e.target;
    if (t && t.tagName === 'INPUT' && String(t.type).toLowerCase() === 'file') return false;
    return true;
  }

  window.addEventListener('dragover', function(e) {
    if (!claimableFileDrop(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch(ex) {}
  });

  window.addEventListener('drop', function(e) {
    if (!claimableFileDrop(e)) return;
    e.preventDefault();
    var files = Array.prototype.slice.call(e.dataTransfer.files || []);
    if (!files.length) return;
    window.parent.postMessage({ type: '${APP_MSG.fileDrop}', files: files }, '*');
  });
})();
`;
