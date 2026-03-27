/**
 * Inline JS interaction helper for iframe apps.
 *
 * Handles interactions inside same-origin iframes:
 * 1. Right-click drawing — forwards pointer events to parent for freehand drawing
 * 2. Context menu — always suppressed (drawing uses right-click drag)
 * 3. Left click — posts `yaar:click` so parent can dismiss overlays
 * 4. Text drag — posts `yaar:drag-start` so parent can track cross-window drags
 */
export const IFRAME_CONTEXTMENU_SCRIPT = `
(function() {
  if (window.__yaarContextMenuInstalled) return;
  window.__yaarContextMenuInstalled = true;

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
      type: 'yaar:arrow-drag-start',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('pointermove', function(e) {
    if (!rightDragging || e.pointerId !== rightPointerId) return;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-move',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('pointerup', function(e) {
    if (!rightDragging || e.pointerId !== rightPointerId) return;
    rightDragging = false;
    rightPointerId = -1;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-end',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  // Left click — notify parent so it can dismiss overlays, etc.
  document.addEventListener('click', function() {
    window.parent.postMessage({ type: 'yaar:click' }, '*');
  });

  // Always suppress the native context menu inside iframes.
  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
  });

  // Forward global keyboard shortcuts to the parent so they work even
  // when the iframe has focus (Shift+Tab, Ctrl+1-9, Ctrl+W).
  document.addEventListener('keydown', function(e) {
    var dominated = false;
    if (e.key === 'Tab' && e.shiftKey) dominated = true;
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') dominated = true;
    if (e.ctrlKey && e.key === 'w') dominated = true;
    if (!dominated) return;
    e.preventDefault();
    window.parent.postMessage({
      type: 'yaar:keydown',
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    }, '*');
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
      type: 'yaar:drag-start',
      text: text
    }, '*');
  });
})();
`;
