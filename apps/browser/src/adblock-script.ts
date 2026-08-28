/**
 * The page-side half of ad blocking: three self-contained scripts handed to
 * `web.evaluate` and run inside the *remote* page.
 *
 * They live apart from adblock.ts because they are a different language runtime —
 * ES5-flavoured, no imports, no bundler, and they must survive being stringified.
 * Nothing here may use a template placeholder other than `__CFG__`.
 *
 * The contract every script upholds is REVERSIBILITY. `APPLY` records the previous
 * inline style of everything it touches on a `window.__yaarAdBlock` ledger, and
 * `DISABLE` walks that ledger back. A heuristic that hides real content is worse
 * than the ads it removed, so the escape hatch has to be exact rather than a reload.
 */

/** Tunables and rule lists, injected into APPLY as `__CFG__`. */
export interface BlockConfig {
  /** Substrings matched against iframe/img/embed/object/anchor URLs. */
  hosts: string[];
  /** Substrings matched against the same URLs, for path-shaped rules (`/ads/`). */
  urlPatterns: string[];
  /** CSS selectors hidden outright. Anchored patterns only — see DEFAULT_RULES. */
  selectors: string[];
  /** Minimum computed z-index for the overlay sweep. Higher is more conservative. */
  minZIndex: number;
  /** Minimum fraction of the viewport an overlay must cover, 0-1. */
  minCoverage: number;
}

/**
 * Install the blocker and sweep once. Idempotent: a second run re-uses the same
 * ledger and only re-sweeps, so it doubles as the per-navigation refresh.
 */
const APPLY = `(function () {
  var CFG = __CFG__;
  var NS = '__yaarAdBlock';
  var st = window[NS];
  if (!st) {
    st = window[NS] = {
      hidden: [], blanks: [], locks: [],
      count: 0, popups: 0,
      observer: null, openOrig: null, installed: false
    };
  }
  st.cfg = CFG;

  function isBlockedUrl(u) {
    if (!u) return false;
    var s = String(u).toLowerCase();
    var i;
    for (i = 0; i < CFG.hosts.length; i++) {
      var h = CFG.hosts[i];
      if (s.indexOf('//' + h) >= 0 || s.indexOf('.' + h) >= 0) return true;
    }
    for (i = 0; i < CFG.urlPatterns.length; i++) {
      if (s.indexOf(CFG.urlPatterns[i]) >= 0) return true;
    }
    return false;
  }

  function hide(el, why) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (el.getAttribute('data-yaar-blocked')) return false;
    st.hidden.push([el, el.getAttribute('style')]);
    el.setAttribute('data-yaar-blocked', why);
    el.style.setProperty('display', 'none', 'important');
    st.count++;
    return true;
  }

  /*
   * The false-positive brake. A full-screen fixed box that holds the page's own
   * landmark elements, or a paragraph's worth of text, is a layout container or a
   * reader view — not an interstitial. Cheap to check and it is what keeps the
   * overlay sweep from eating articles.
   */
  function looksLikeContent(el) {
    if (el.querySelector('main, article, [role="main"], nav, video')) return true;
    var t = el.textContent || '';
    return t.length > 2000;
  }

  function sweepOverlays() {
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var area = vw * vh;
    if (area < 1) return;
    var all = document.querySelectorAll('div, section, aside, dialog, ins, iframe');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.getAttribute('data-yaar-blocked')) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity) === 0) continue;
      var z = parseInt(cs.zIndex, 10);
      if (!(z >= CFG.minZIndex)) continue;
      var r = el.getBoundingClientRect();
      if (r.width * r.height < area * CFG.minCoverage) continue;
      if (looksLikeContent(el)) continue;
      hide(el, 'overlay');
    }
  }

  function sweepSelectors() {
    for (var i = 0; i < CFG.selectors.length; i++) {
      var list;
      try { list = document.querySelectorAll(CFG.selectors[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) hide(list[j], 'selector');
    }
  }

  function sweepUrls() {
    var list = document.querySelectorAll('iframe[src], img[src], embed[src], object[data], a[href]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.getAttribute('data-yaar-blocked')) continue;
      var u = el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href');
      if (!isBlockedUrl(u)) continue;
      // An anchor is only an ad unit when it is wrapping a creative; a bare text
      // link to a blocked host is left alone so page navigation still works.
      if (el.tagName === 'A' && !el.querySelector('img')) continue;
      hide(el, 'url');
    }
  }

  /* Popups that arrive as a normal link rather than through window.open. */
  function forceSelfTargets() {
    var list = document.querySelectorAll('a[target="_blank"]');
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.getAttribute('data-yaar-blank')) continue;
      a.setAttribute('data-yaar-blank', '1');
      a.setAttribute('target', '_self');
      st.blanks.push(a);
    }
  }

  /* Interstitials lock the page behind them; the lock outlives the element we hid. */
  function unlockScroll() {
    var els = [document.documentElement, document.body];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || el.getAttribute('data-yaar-unlocked')) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.overflow !== 'hidden' && cs.overflowY !== 'hidden' && cs.position !== 'fixed') continue;
      st.locks.push([el, el.getAttribute('style')]);
      el.setAttribute('data-yaar-unlocked', '1');
      el.style.setProperty('overflow', 'auto', 'important');
      if (cs.position === 'fixed') el.style.setProperty('position', 'static', 'important');
    }
  }

  function sweep() {
    try { sweepSelectors(); } catch (e) {}
    try { sweepUrls(); } catch (e) {}
    try { sweepOverlays(); } catch (e) {}
    try { forceSelfTargets(); } catch (e) {}
    try { unlockScroll(); } catch (e) {}
  }

  if (!st.installed) {
    st.installed = true;
    // INIT normally got here first (st.openOrig set); this is the fallback for a
    // page loaded before the init script was installed.
    if (!st.openOrig) {
      st.openOrig = window.open;
      window.open = function () { st.count++; st.popups++; return null; };
      // Defined as an accessor rather than nulled: a page that reassigns it after
      // us would otherwise get its exit-trap back on the next click.
      try {
        Object.defineProperty(window, 'onbeforeunload', {
          configurable: true,
          get: function () { return null; },
          set: function () {}
        });
      } catch (e) {}
    }
    var pending = false;
    st.observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; sweep(); });
    });
    st.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  sweep();
  return { blocked: st.count, popups: st.popups, hidden: st.hidden.length, url: location.href };
})()`;

/**
 * The pre-page half, installed server-side with `web.setInitScript` so it runs
 * before the page's own scripts on every navigation, in every frame, in every tab.
 *
 * Deliberately tiny: only the two hooks that lose a race if installed late. The
 * popunder pattern binds `window.open` (or captures a reference to it) during
 * load, so an override that arrives with APPLY after the fact never fires — that
 * was the `popups: 0` in issue #94's field test. Everything DOM-shaped stays in
 * APPLY, where it can be reversed through the ledger; this shares that ledger so
 * DISABLE restores `window.open` from `st.openOrig` exactly as before.
 */
const INIT = `(function () {
  var NS = '__yaarAdBlock';
  if (window[NS] && window[NS].openOrig) return;
  var st = window[NS] = window[NS] || {
    hidden: [], blanks: [], locks: [],
    count: 0, popups: 0,
    observer: null, openOrig: null, installed: false
  };
  st.openOrig = window.open;
  window.open = function () { st.count++; st.popups++; return null; };
  try {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      get: function () { return null; },
      set: function () {}
    });
  } catch (e) {}
})()`;

/** Walk the ledger back: every hidden element, scroll lock and rewritten target. */
const DISABLE = `(function () {
  var st = window['__yaarAdBlock'];
  if (!st) return { restored: 0, blocked: 0 };
  if (st.observer) { st.observer.disconnect(); st.observer = null; }
  if (st.openOrig) { window.open = st.openOrig; st.openOrig = null; }
  try { delete window.onbeforeunload; } catch (e) {}

  function restore(pair) {
    var el = pair[0];
    var prev = pair[1];
    if (prev === null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
  }

  var i;
  for (i = 0; i < st.hidden.length; i++) {
    restore(st.hidden[i]);
    st.hidden[i][0].removeAttribute('data-yaar-blocked');
  }
  for (i = 0; i < st.locks.length; i++) {
    restore(st.locks[i]);
    st.locks[i][0].removeAttribute('data-yaar-unlocked');
  }
  for (i = 0; i < st.blanks.length; i++) {
    st.blanks[i].setAttribute('target', '_blank');
    st.blanks[i].removeAttribute('data-yaar-blank');
  }
  var out = { restored: st.hidden.length, blocked: st.count };
  try { delete window['__yaarAdBlock']; } catch (e) { window['__yaarAdBlock'] = null; }
  return out;
})()`;

/** Read the ledger without touching it. */
const STATS = `(function () {
  var st = window['__yaarAdBlock'];
  if (!st) return { blocked: 0, popups: 0, hidden: 0, active: false, url: location.href };
  return {
    blocked: st.count,
    popups: st.popups,
    hidden: st.hidden.length,
    active: !!st.observer,
    url: location.href
  };
})()`;

/** What APPLY and STATS answer with. DISABLE answers `{ restored, blocked }`. */
export interface BlockStats {
  blocked: number;
  popups: number;
  hidden: number;
  active?: boolean;
  url: string;
}

export function applyScript(cfg: BlockConfig): string {
  // A function replacer, because a JSON blob containing `$&` would otherwise be
  // spliced into itself by String.replace's substitution patterns.
  return APPLY.replace('__CFG__', () => JSON.stringify(cfg));
}

export const disableScript = DISABLE;
export const initScript = INIT;
export const statsScript = STATS;
