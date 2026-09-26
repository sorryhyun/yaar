/**
 * Inline JS text selection for app frames on a phone (#123).
 *
 * The frame half of the shell's own text selection (the frontend's `lib/textSelection.ts`
 * and `PhoneTextSelection.tsx`). A native selection on a phone brings up Chrome's toolbar,
 * which no page can change, so while the desktop says the form factor is `mobile` (the
 * device SDK's `data-form-factor`) app content is `user-select: none` — fields excepted,
 * for the IME — and this script selects instead: a finger held still on a word selects
 * it, painted with `::highlight(yaar-selection)`.
 *
 * The frame keeps only the `Range`. Everything drawn on top of it — the two handles and
 * the Copy / Select all / Ask AI menu — is the desktop's, the same components it uses for
 * windows it renders itself, so the frame reports where the range is (`yaar:text-selection`)
 * and the desktop answers with what to do to it (`yaar:text-selection-command`): clear it,
 * select all, or move one end to where a handle is being dragged. Copy happens in the
 * desktop with the text it was sent, because the tap on Copy is the desktop's user
 * activation, not the frame's.
 *
 * A long-press claims its touch: `window.__yaarTouchClaimed` is what the contextmenu
 * script's touch relay checks before handing a drag to the desktop as a monitor pan or a
 * shade pull. Unlike the desktop, the frame cannot also stop the page scrolling under a
 * claimed finger that moves on — that takes a non-passive `touchmove`, which every
 * isolated app would then wait on (see contextmenu.ts) — so a finger that selects and
 * then slides scrolls the app, and the selection rides along with it.
 */
import { APP_MSG } from '../app-protocol.js';
import { PALETTE_DARK } from '../design/tokens.js';
import { installGuard } from './prelude.js';

export const IFRAME_TEXT_SELECTION_SCRIPT = `
(function() {
  ${installGuard('__yaarTextSelectionInstalled')}

  // LONG_PRESS_MS and the long-press slop in the frontend's PhoneTextSelection.tsx.
  var LONG_PRESS_MS = 400;
  var SLOP_PX = 8;
  // How close to the edge of what scrolls a dragged handle starts scrolling it, and how
  // far one frame of that scroll goes at most. The same pair as lib/textSelection.ts.
  var EDGE_PX = 40;
  var MAX_SCROLL_PX = 16;
  var HIGHLIGHT = 'yaar-selection';
  var NOT_SELECTABLE = 'input, textarea, select, button, ' +
    '[contenteditable]:not([contenteditable="false"]), [data-no-select]';

  // !important because an app's own \`user-select: text\` on some element would otherwise
  // bring the native selection, and Chrome's toolbar with it, back for that element.
  var style = document.createElement('style');
  style.textContent =
    'html[data-form-factor="mobile"], html[data-form-factor="mobile"] * {' +
    '-webkit-user-select:none !important;user-select:none !important}' +
    'html[data-form-factor="mobile"] :is(input, textarea, ' +
    '[contenteditable]:not([contenteditable="false"]), ' +
    '[contenteditable]:not([contenteditable="false"]) *) {' +
    '-webkit-user-select:text !important;user-select:text !important}' +
    '::highlight(' + HIGHLIGHT + '){background-color:' +
    'color-mix(in srgb, var(--yaar-accent, ${PALETTE_DARK.accent}) 35%, transparent);' +
    'color:inherit}';
  (document.head || document.documentElement).appendChild(style);

  function onPhone() {
    var root = document.documentElement;
    return !!root && root.getAttribute('data-form-factor') === 'mobile';
  }

  function post(message) {
    message.type = '${APP_MSG.textSelection}';
    window.parent.postMessage(message, '*');
  }

  var sel = null;
  var textSent = false;
  var start = null;
  var moved = false;
  var press = 0;
  var drag = null;

  function claim(on) {
    window.__yaarTouchClaimed = on;
  }

  function paint() {
    var highlights = typeof CSS !== 'undefined' && CSS.highlights;
    if (!highlights) return;
    if (sel) highlights.set(HIGHLIGHT, new Highlight(sel));
    else highlights['delete'](HIGHLIGHT);
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
    }
    var range = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  // A caret in text a selection may hold: not a field's, which keeps the native one.
  function textCaretAt(x, y) {
    var caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== 3) return null;
    var parent = caret.node.parentElement;
    if (!parent || parent.closest(NOT_SELECTABLE)) return null;
    return caret;
  }

  // wordBounds() in lib/textSelection.ts: the character after the caret first, then the
  // one before it, and Intl.Segmenter for text with no spaces to split on.
  var segmenter = null;
  function wordRangeAt(x, y) {
    var caret = textCaretAt(x, y);
    if (!caret || typeof Intl === 'undefined' || !Intl.Segmenter) return null;
    segmenter = segmenter || new Intl.Segmenter(undefined, { granularity: 'word' });
    var text = caret.node.textContent || '';
    var segments = segmenter.segment(text);
    var tries = [caret.offset, caret.offset - 1];
    for (var i = 0; i < tries.length; i++) {
      if (tries[i] < 0 || tries[i] >= text.length) continue;
      var seg = segments.containing(tries[i]);
      if (seg && seg.isWordLike) {
        var range = document.createRange();
        range.setStart(caret.node, seg.index);
        range.setEnd(caret.node, seg.index + seg.segment.length);
        return range;
      }
    }
    return null;
  }

  function shown(node) {
    var el = node.parentElement;
    if (!el || el.closest('script, style, noscript, template, ' + NOT_SELECTABLE)) return false;
    return typeof el.checkVisibility !== 'function' || el.checkVisibility();
  }

  // rangeAll() in lib/textSelection.ts: first to last piece of text that shows, so both
  // ends sit in text and the handles have a line to hang from.
  function rangeAll() {
    if (!document.body) return null;
    var walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */, null);
    var nodes = [];
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (/\\S/.test(n.data)) nodes.push(n);
    }
    var first = null, last = null;
    for (var i = 0; i < nodes.length && !first; i++) if (shown(nodes[i])) first = nodes[i];
    for (var j = nodes.length - 1; j >= 0 && !last; j--) if (shown(nodes[j])) last = nodes[j];
    if (!first || !last) return null;
    var range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    return range;
  }

  // spanBetween() in lib/textSelection.ts: whichever order the two points are in.
  function spanBetween(a, b) {
    var range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    if (range.collapsed) {
      range.setStart(b.node, b.offset);
      range.setEnd(a.node, a.offset);
    }
    return range.collapsed ? null : range;
  }

  // caretLine() in lib/textSelection.ts.
  function caretLine(range, atStart) {
    var caret = range.cloneRange();
    caret.collapse(atStart);
    var box = caret.getBoundingClientRect();
    if (box.height) return { x: box.left, top: box.top, bottom: box.bottom };
    var rects = range.getClientRects();
    box = rects.length ? rects[atStart ? 0 : rects.length - 1] : range.getBoundingClientRect();
    return { x: atStart ? box.left : box.right, top: box.top, bottom: box.bottom };
  }

  function report() {
    if (sel && !(sel.startContainer.isConnected && sel.endContainer.isConnected)) {
      // The text under it was re-rendered away.
      sel = null;
      paint();
    }
    if (!sel) {
      post({ selection: null });
      return;
    }
    var box = sel.getBoundingClientRect();
    var out = {
      start: caretLine(sel, true),
      end: caretLine(sel, false),
      bounds: { left: box.left, top: box.top, width: box.width, height: box.height }
    };
    // What scrolls the text, so a handle whose end scrolled out of it is not drawn over
    // the app's own header or footer; the frame's edges are the desktop's to add.
    var scroller = scrollerOf(sel.commonAncestorContainer);
    if (scroller) {
      var c = scroller.getBoundingClientRect();
      out.clip = { left: c.left, top: c.top, width: c.width, height: c.height };
    }
    if (!textSent) out.text = sel.toString();
    textSent = true;
    post({ selection: out });
  }

  function select(range) {
    sel = range;
    textSent = false;
    paint();
    report();
  }

  var reportQueued = false;
  function reportSoon() {
    if (!sel || reportQueued) return;
    reportQueued = true;
    requestAnimationFrame(function() {
      reportQueued = false;
      if (sel) report();
    });
  }

  function cancelPress() {
    if (press) clearTimeout(press);
    press = 0;
  }

  document.addEventListener('touchstart', function(e) {
    claim(false);
    cancelPress();
    moved = false;
    start = null;
    var t = e.touches[0];
    if (!t || e.touches.length > 1 || !onPhone()) return;
    start = { x: t.clientX, y: t.clientY };
    var target = e.target;
    if (!target || target.nodeType !== 1 || target.closest(NOT_SELECTABLE)) return;
    var x = t.clientX, y = t.clientY;
    press = setTimeout(function() {
      press = 0;
      var range = wordRangeAt(x, y);
      if (!range) return;
      claim(true);
      select(range);
    }, LONG_PRESS_MS);
  }, { capture: true, passive: true });

  // Passive, like the relay's in contextmenu.ts, and for the same reason.
  document.addEventListener('touchmove', function(e) {
    var t = e.touches[0];
    if (!start || !t || moved) return;
    if (Math.abs(t.clientX - start.x) > SLOP_PX || Math.abs(t.clientY - start.y) > SLOP_PX) {
      moved = true;
      cancelPress();
    }
  }, { capture: true, passive: true });

  document.addEventListener('touchend', function(e) {
    cancelPress();
    var tapped = start && !moved;
    start = null;
    if (window.__yaarTouchClaimed) {
      // The browser would follow the lift with a click on whatever held the word.
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (tapped && sel) {
      sel = null;
      paint();
      report();
    }
  }, true);

  document.addEventListener('touchcancel', function() {
    cancelPress();
    start = null;
  }, true);

  document.addEventListener('scroll', reportSoon, { capture: true, passive: true });
  window.addEventListener('resize', reportSoon);

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function scrollerOf(node) {
    for (var el = node.nodeType === 1 ? node : node.parentElement;
         el && el !== document.body && el !== document.documentElement;
         el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1) {
        var overflow = getComputedStyle(el).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return el;
      }
    }
    return null;
  }

  // The part of the frame the dragged end can be probed in: what scrolls the text, as
  // much of it as the frame shows.
  function probeBox() {
    var box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    if (drag.scroller) {
      var r = drag.scroller.getBoundingClientRect();
      box.left = Math.max(box.left, r.left);
      box.top = Math.max(box.top, r.top);
      box.right = Math.min(box.right, r.right);
      box.bottom = Math.min(box.bottom, r.bottom);
    }
    return box;
  }

  function extend() {
    var box = probeBox();
    var caret = textCaretAt(
      clamp(drag.x, box.left + 1, box.right - 1),
      clamp(drag.y, box.top + 1, box.bottom - 1)
    );
    if (!caret) return;
    var range = spanBetween(drag.anchor, caret);
    if (range) select(range);
  }

  function autoScroll() {
    drag.frame = 0;
    var box = probeBox();
    var step = 0;
    if (drag.y < box.top + EDGE_PX) {
      step = -Math.ceil(MAX_SCROLL_PX * Math.min(1, (box.top + EDGE_PX - drag.y) / EDGE_PX));
    } else if (drag.y > box.bottom - EDGE_PX) {
      step = Math.ceil(MAX_SCROLL_PX * Math.min(1, (drag.y - box.bottom + EDGE_PX) / EDGE_PX));
    }
    if (!step) return;
    var scroller = drag.scroller || document.scrollingElement || document.documentElement;
    var before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    if (scroller.scrollTop === before) return;
    extend();
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function endDrag() {
    if (drag && drag.frame) cancelAnimationFrame(drag.frame);
    drag = null;
  }

  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || d.type !== '${APP_MSG.textSelectionCommand}' || e.source !== window.parent) return;
    if (d.op === 'clear') {
      // The desktop let go of it already, so nothing is reported back.
      endDrag();
      sel = null;
      paint();
    } else if (d.op === 'selectAll') {
      var all = rangeAll();
      if (all) select(all);
    } else if (d.op === 'dragStart' && sel) {
      endDrag();
      var anchor = d.end === 'start'
        ? { node: sel.endContainer, offset: sel.endOffset }
        : { node: sel.startContainer, offset: sel.startOffset };
      drag = { anchor: anchor, scroller: scrollerOf(anchor.node), x: 0, y: 0, frame: 0 };
    } else if (d.op === 'drag' && drag) {
      drag.x = Number(d.x) || 0;
      drag.y = Number(d.y) || 0;
      extend();
      if (!drag.frame) drag.frame = requestAnimationFrame(autoScroll);
    } else if (d.op === 'dragEnd') {
      endDrag();
    }
  });
})();
`;
