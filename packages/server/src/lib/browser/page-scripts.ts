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
    activeElement: activeElement,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight
  };
})()`;

/** Expression that returns the page body text. */
export const BODY_TEXT = '(document.body?.innerText || "").trim()';

/** IIFE that returns text from elements currently visible in the viewport. */
export const VIEWPORT_TEXT = `(function() {
  var vw = window.innerWidth, vh = window.innerHeight;
  var SKIP = {SCRIPT:1, STYLE:1, NOSCRIPT:1};
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node, parts = [];
  while (node = walker.nextNode()) {
    var parent = node.parentElement;
    if (!parent || SKIP[parent.tagName]) continue;
    var text = node.textContent;
    if (!text || !text.trim()) continue;
    var rect = parent.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    if (rect.width === 0 || rect.height === 0) continue;
    parts.push(text.trim());
  }
  return parts.join(' ');
})()`;

/** Expression returning {url, title}. */
export const URL_AND_TITLE = '({url: location.href, title: document.title})';

// ── click: findBySelector ─────────────────────────────────────────────

/**
 * Function(sel) → {x, y, tag, text, candidateCount, selector, href?} | null
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
  var href = null;
  var anchor = tag === 'a' ? el : el.closest('a');
  if (anchor) href = anchor.href || anchor.getAttribute('href');
  var result = {x: rect.x + rect.width/2, y: rect.y + rect.height/2, tag: tag, text: text, candidateCount: 1, selector: sel};
  if (href) result.href = href;
  return result;
}`;

// ── click: findByText ─────────────────────────────────────────────────

/**
 * Function(txt, index) → {x, y, tag, text, candidateCount, selector?, href?} | null
 *
 * Walks all elements using innerText (reflects rendered text), collects visible
 * candidates that contain `txt`. Supports prefix matching when txt ends with `...`/`...`.
 * Prefers interactive elements (button, a, summary, input[submit], [role=button]),
 * then picks smallest by area. Filters visibility:hidden and opacity:0.
 */
export const FIND_BY_TEXT = `function(txt, index) {
  var INTERACTIVE = ['button','a','summary'];
  function normalize(s) {
    return s.replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u2014]/g, '-').replace(/[\\u2026]/g, '...').replace(/\\s+/g, ' ').trim();
  }
  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.opacity === '0') return false;
    var pos = style.position;
    if (el.offsetParent === null && pos !== 'fixed' && pos !== 'sticky') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }
  function isInteractive(el, tag) {
    return INTERACTIVE.indexOf(tag) !== -1
      || (tag === 'input' && el.type === 'submit')
      || el.getAttribute('role') === 'button'
      || el.getAttribute('role') === 'link'
      || el.getAttribute('role') === 'tab'
      || el.hasAttribute('onclick');
  }
  function bestSelector(el) {
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\\s+/)[0];
      if (cls) return tag + '.' + CSS.escape(cls);
    }
    return null;
  }
  var norm = normalize(txt);
  var isPrefix = norm.endsWith('...');
  var prefix = isPrefix ? norm.slice(0, -3) : null;
  function matches(elText) {
    var n = normalize(elText);
    if (isPrefix) return n.startsWith(prefix);
    return n.includes(norm);
  }
  var candidates = [];
  // Walk elements using innerText (reflects rendered text, joins child nodes)
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html' || tag === 'script' || tag === 'style' || tag === 'noscript') continue;
    var elText = el.innerText;
    if (!elText || !matches(elText)) continue;
    if (!isVisible(el)) continue;
    var rect = el.getBoundingClientRect();
    var href = null;
    var anchor = tag === 'a' ? el : el.closest('a');
    if (anchor) href = anchor.href || anchor.getAttribute('href');
    candidates.push({el: el, area: rect.width * rect.height, tag: tag, isInteractive: isInteractive(el, tag), href: href});
  }
  if (candidates.length === 0) return null;
  candidates.sort(function(a, b) {
    if (a.isInteractive !== b.isInteractive) return a.isInteractive ? -1 : 1;
    return a.area - b.area;
  });
  var idx = Math.min(index || 0, candidates.length - 1);
  var chosen = candidates[idx];
  var chosenEl = chosen.el;
  if (chosenEl.scrollIntoViewIfNeeded) chosenEl.scrollIntoViewIfNeeded();
  else chosenEl.scrollIntoView({block:'center'});
  var r = chosenEl.getBoundingClientRect();
  var result = {
    x: r.x + r.width/2,
    y: r.y + r.height/2,
    tag: chosen.tag,
    text: (chosenEl.innerText || '').trim().slice(0, 80),
    candidateCount: candidates.length
  };
  var sel = bestSelector(chosenEl);
  if (sel) result.selector = sel;
  if (chosen.href) result.href = chosen.href;
  return result;
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

// ── strip target="_blank" ─────────────────────────────────────────────

/** Expression that removes target attributes from all links so they navigate in-place. */
export const STRIP_TARGET_BLANK = `document.querySelectorAll('a[target]').forEach(function(a) { a.removeAttribute('target'); })`;

// ── viewport links ───────────────────────────────────────────────────

/** IIFE that returns up to 10 visible links with text and href. */
export const VIEWPORT_LINKS = `(function() {
  var vw = window.innerWidth, vh = window.innerHeight;
  var anchors = document.querySelectorAll('a[href]');
  var links = [];
  for (var i = 0; i < anchors.length && links.length < 10; i++) {
    var a = anchors[i];
    var rect = a.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    if (rect.width === 0 || rect.height === 0) continue;
    var text = (a.innerText || '').trim();
    var href = a.href || a.getAttribute('href') || '';
    if (text && href && !href.startsWith('javascript:')) links.push({text: text.slice(0, 60), href: href});
  }
  return links;
})()`;

// ── element at point ─────────────────────────────────────────────────

/**
 * Function(x, y) → {tag, text, href?} | null
 * Returns info about the element at the given coordinates, walking up to find interactive parents.
 */
export const ELEMENT_AT_POINT = `function(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return null;
  var INTERACTIVE = ['a','button','input','select','textarea','summary'];
  var current = el;
  while (current && current !== document.body) {
    var tag = current.tagName.toLowerCase();
    if (INTERACTIVE.indexOf(tag) !== -1 || current.getAttribute('role') === 'button' || current.getAttribute('role') === 'link' || current.hasAttribute('onclick')) {
      el = current;
      break;
    }
    current = current.parentElement;
  }
  var tag = el.tagName.toLowerCase();
  var text = (el.innerText || el.textContent || '').trim().slice(0, 80);
  var href = null;
  var anchor = tag === 'a' ? el : el.closest('a');
  if (anchor) href = anchor.href || anchor.getAttribute('href');
  var result = {tag: tag, text: text};
  if (href) result.href = href;
  return result;
}`;

// ── annotate elements ────────────────────────────────────────────────

/**
 * IIFE that overlays numbered red badges on all visible interactive elements
 * and returns an array of element metadata with index, tag, text, href, selector, x, y.
 */
export const ANNOTATE_ELEMENTS = `(function() {
  var vw = window.innerWidth, vh = window.innerHeight;
  var TAGS = 'a,button,input,select,textarea,[role=button],[role=link],[onclick],summary';
  var els = document.querySelectorAll(TAGS);
  var items = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    if (rect.width === 0 || rect.height === 0) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    var tag = el.tagName.toLowerCase();
    var text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 40);
    var href = null;
    if (tag === 'a') href = el.href || el.getAttribute('href');
    var sel = null;
    if (el.id) sel = '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\\s+/)[0];
      if (cls) sel = tag + '.' + CSS.escape(cls);
    }
    items.push({tag: tag, text: text, href: href, selector: sel, x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2)});
  }
  // Add numbered badges
  var container = document.createElement('div');
  container.id = '__yaar_annotations__';
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647';
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;background:red;color:white;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:8px;line-height:14px;min-width:14px;text-align:center;font-family:Arial,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.5)';
    badge.style.left = (item.x - 7) + 'px';
    badge.style.top = (item.y - 7) + 'px';
    badge.textContent = String(j);
    container.appendChild(badge);
    item.index = j;
  }
  document.body.appendChild(container);
  return items;
})()`;

/** IIFE that removes the annotation overlay. */
export const REMOVE_ANNOTATIONS = `(function() {
  var el = document.getElementById('__yaar_annotations__');
  if (el) el.remove();
})()`;

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
