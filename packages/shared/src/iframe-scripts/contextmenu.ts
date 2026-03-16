/**
 * Inline JS interaction helper for iframe apps.
 *
 * Handles interactions inside same-origin iframes:
 * 1. Context menu — prevents browser default, posts `yaar:contextmenu`
 * 2. Left click — posts `yaar:click` so parent can dismiss context menu
 * 3. Text drag — posts `yaar:drag-start` so parent can track cross-window drags
 */
export const IFRAME_CONTEXTMENU_SCRIPT = `
(function() {
  if (window.__yaarContextMenuInstalled) return;
  window.__yaarContextMenuInstalled = true;

  // Right-click drawing forwarding — the parent uses mousedown/mousemove/mouseup
  // with button 2 for freehand drawing, but those events don't cross
  // iframe boundaries. Forward them via postMessage so the parent can drive the drawing.
  var rightDragging = false;
  var rightDragMoved = false;

  document.addEventListener('mousedown', function(e) {
    if (e.button !== 2) return;
    rightDragging = true;
    rightDragMoved = false;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-start',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('mousemove', function(e) {
    if (!rightDragging) return;
    rightDragMoved = true;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-move',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('mouseup', function(e) {
    if (!rightDragging) return;
    rightDragging = false;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-end',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  // Left click — notify parent so it can dismiss context menu, etc.
  document.addEventListener('click', function() {
    window.parent.postMessage({ type: 'yaar:click' }, '*');
  });

  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    // After a right-click drag, suppress the context menu forwarding —
    // the parent already processed the drag gesture.
    if (rightDragMoved) {
      rightDragMoved = false;
      return;
    }
    // Simple right-click (no drag) — cancel drawing tracking.
    // The parent's context menu overlay may steal the mouseup event,
    // leaving rightDragging stuck at true. Reset it and notify parent.
    if (rightDragging) {
      rightDragging = false;
      window.parent.postMessage({
        type: 'yaar:arrow-drag-end',
        clientX: e.clientX,
        clientY: e.clientY
      }, '*');
    }
    var selectedText = '';
    try {
      selectedText = (window.getSelection() || '').toString().trim();
    } catch(ex) {}
    window.parent.postMessage({
      type: 'yaar:contextmenu',
      clientX: e.clientX,
      clientY: e.clientY,
      selectedText: selectedText
    }, '*');
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
