/**
 * JavaScript expressions evaluated inside the browser page via CDP Runtime.evaluate.
 *
 * Kept in a separate file so session.ts stays focused on CDP orchestration
 * and these scripts are easier to read/modify in isolation.
 *
 * Every export is a string — either a raw expression or an IIFE/function body
 * that session.ts wraps in `(${fn})(arg)` before sending to the page.
 */

// ── getPageState ──────────────────────────────────────────────────────

/** IIFE that returns {url, title, activeElement?}. */
export const PAGE_STATE = `(function() {
  var ae = document.activeElement;
  var activeElement = null;
  if (ae && ae !== document.body && ae !== document.documentElement) {
    activeElement = { tag: ae.tagName.toLowerCase() };
    if (ae.id) activeElement.id = ae.id;
    if (ae.name) activeElement.name = ae.name;
    if (ae.type) activeElement.type = ae.type;
  }
  return {
    url: location.href,
    title: document.title,
    activeElement: activeElement
  };
})()`;

/** Expression that returns the page body text. */
export const BODY_TEXT = '(document.body?.innerText || "").trim()';

/** Expression returning {url, title}. */
export const URL_AND_TITLE = '({url: location.href, title: document.title})';

// ── click: findBySelector ─────────────────────────────────────────────

/**
 * Function(sel) → {x, y, tag, text, candidateCount} | null
 * Finds an element by CSS selector, scrolls it into view, returns click coords + metadata.
 */
export const FIND_BY_SELECTOR = `function(sel) {
  var el = document.querySelector(sel);
  if (!el) return null;
  if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
  else el.scrollIntoView({block:'center'});
  var rect = el.getBoundingClientRect();
  var tag = el.tagName.toLowerCase();
  var text = (el.textContent || '').trim().slice(0, 80);
  return {x: rect.x + rect.width/2, y: rect.y + rect.height/2, tag: tag, text: text, candidateCount: 1};
}`;

// ── click: findByText ─────────────────────────────────────────────────

/**
 * Function(txt) → {x, y, tag, text, candidateCount} | null
 *
 * Walks all text nodes, collects visible candidates that contain `txt`,
 * prefers interactive elements (button, a, summary, input[submit], [role=button]),
 * then picks smallest by area. Filters visibility:hidden and opacity:0.
 */
export const FIND_BY_TEXT = `function(txt) {
  var INTERACTIVE = ['button','a','summary'];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node;
  var candidates = [];
  while (node = walker.nextNode()) {
    if (node.textContent && node.textContent.trim().includes(txt)) {
      var el = node.parentElement;
      if (!el) continue;
      var tag = el.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') continue;
      if (el.offsetParent === null && tag !== 'body' && tag !== 'html') continue;
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var isInteractive = INTERACTIVE.indexOf(tag) !== -1
        || (tag === 'input' && el.type === 'submit')
        || el.getAttribute('role') === 'button';
      candidates.push({el: el, area: rect.width * rect.height, tag: tag, isInteractive: isInteractive});
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(function(a, b) {
    if (a.isInteractive !== b.isInteractive) return a.isInteractive ? -1 : 1;
    return a.area - b.area;
  });
  var chosen = candidates[0].el;
  if (chosen.scrollIntoViewIfNeeded) chosen.scrollIntoViewIfNeeded();
  else chosen.scrollIntoView({block:'center'});
  var r = chosen.getBoundingClientRect();
  return {
    x: r.x + r.width/2,
    y: r.y + r.height/2,
    tag: candidates[0].tag,
    text: (chosen.textContent || '').trim().slice(0, 80),
    candidateCount: candidates.length
  };
}`;

// ── type: focus + clear, fire change ──────────────────────────────────

/**
 * Function(sel) — focuses an input, clears its value, fires input event.
 * Throws if element not found.
 */
export const FOCUS_AND_CLEAR = `function(sel) {
  var el = document.querySelector(sel);
  if (!el) throw new Error('Element not found: ' + sel);
  el.focus();
  el.value = '';
  el.dispatchEvent(new Event('input', {bubbles: true}));
}`;

/**
 * Function(sel) — fires input + change events on the element.
 */
export const FIRE_CHANGE_EVENTS = `function(sel) {
  var el = document.querySelector(sel);
  if (el) {
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }
}`;

// ── extractContent ────────────────────────────────────────────────────

/**
 * Function(sel) → {fullText, links[], forms[]}
 * Extracts text, links, and form fields from the page or a scoped selector.
 */
export const EXTRACT_CONTENT = `function(sel) {
  var root = sel ? document.querySelector(sel) : document.body;
  if (!root) return {fullText: '', links: [], forms: []};

  var fullText = root.innerText || '';

  var links = [];
  var anchors = root.querySelectorAll('a[href]');
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var text = (a.textContent || '').trim();
    var href = a.getAttribute('href') || '';
    if (text && href) links.push({text: text, href: href});
  }

  var forms = [];
  var formEls = root.querySelectorAll('form');
  for (var j = 0; j < formEls.length; j++) {
    var form = formEls[j];
    var fields = [];
    var inputs = form.querySelectorAll('input, select, textarea');
    for (var k = 0; k < inputs.length; k++) {
      var inp = inputs[k];
      fields.push({
        name: inp.name || inp.id || '',
        type: inp.type || inp.tagName.toLowerCase(),
        value: inp.value || undefined
      });
    }
    forms.push({action: form.getAttribute('action') || '', fields: fields});
  }

  return {fullText: fullText, links: links, forms: forms};
}`;

// ── findMainContentSelector ───────────────────────────────────────────

/**
 * IIFE → CSS selector string | null
 * Heuristic: finds the largest text-containing block element on the page.
 * Tries semantic elements first (main, article, [role=main], etc.), falls back to divs.
 */
export const FIND_MAIN_CONTENT = `(function() {
  var blocks = document.querySelectorAll('main, article, [role=main], section, .content, #content, .post, .article');
  var best = null;
  var bestLen = 0;
  for (var i = 0; i < blocks.length; i++) {
    var len = (blocks[i].innerText || '').length;
    if (len > bestLen) { bestLen = len; best = blocks[i]; }
  }
  if (!best) {
    var divs = document.querySelectorAll('div');
    for (var j = 0; j < divs.length; j++) {
      var dLen = (divs[j].innerText || '').length;
      if (dLen > bestLen) { bestLen = dLen; best = divs[j]; }
    }
  }
  if (!best || bestLen < 100) return null;
  if (best.id) return '#' + best.id;
  if (best.className) {
    var cls = best.className.split(/\\s+/)[0];
    if (cls) return best.tagName.toLowerCase() + '.' + cls;
  }
  return best.tagName.toLowerCase();
})()`;
