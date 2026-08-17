/**
 * Inline JS windows SDK for iframe apps.
 *
 * Provides window.yaar.windows with read/list methods
 * so iframe apps can read other windows' content (read-only).
 * Reimplemented over the verb SDK (POST /api/verb).
 *
 * Plus everything about a link leaving an app, which lives here in one piece:
 * `openUrl` (an http(s) destination handed to the desktop), the `window.open`
 * override that routes an app's own popups the same way, the capture of anchor
 * clicks so a link cannot navigate the app's own document away, and the
 * `yaar.links` surface an app configures all three through. See the comments on
 * each. It used to be split — the guard lived in `app-protocol.ts` — and the two
 * halves disagreed about which links they covered, which is what apps then
 * hand-rolled a third policy to fix.
 */
import { APP_MSG } from '../app-protocol.js';
import { installGuard, YAAR_NAMESPACE } from './prelude.js';
export const IFRAME_WINDOWS_SDK_SCRIPT = `
(function() {
  ${installGuard('__yaarWindowsInstalled')}
  ${YAAR_NAMESPACE}

  function postOpenUrl(url, title) {
    window.parent.postMessage({
      type: '${APP_MSG.openUrl}',
      url: url,
      title: title || ''
    }, '*');
  }

  // ---- Links out of the app ------------------------------------------------

  // Per-app link policy, baked into the compiled HTML from app.json's "links"
  // key (see compiler/src/compile.ts). Every compiled app gets one, empty or
  // not, which is also how the guard below knows it is looking at an app at all
  // and not at a plain HTML document previewed in a window.
  //
  // Read per call, not at install: this script is injected into frames as well as
  // baked into them, so "is the config already there" is a question about script
  // order, and the prelude's rule is to remove those contracts rather than
  // document them.
  function linkConfig() {
    var c = window.__yaar_links__;
    return (c && typeof c === 'object') ? c : null;
  }
  var linkHandler = null;

  // Where a RELATIVE href resolves. The app's own document is usually the wrong
  // answer: an app renders someone else's HTML, so \`/board/123\` in it means that
  // site's path, and resolving it here is exactly how a click used to land on a
  // 404 served by the YAAR shell. app.json's "links": { "base": ... } names the
  // site the content came from; without one, the app's own document is all we
  // know.
  function linkBase() {
    var c = linkConfig();
    if (c && typeof c.base === 'string' && c.base) return c.base;
    return (typeof document !== 'undefined' && document.baseURI) || undefined;
  }

  function trim(s) {
    return String(s === undefined || s === null ? '' : s).replace(/^\\s+|\\s+$/g, '');
  }

  // Absolute, openable URL for an href — or null when there is nothing to open
  // (empty, a bare #fragment, mailto:, an unparseable value). One policy, used by
  // openUrl, by the window.open shim and by the guard, so none of them can end up
  // laxer than the others.
  function resolveLink(raw) {
    var href = trim(raw);
    if (!href || href.charAt(0) === '#') return null;
    var u;
    try { u = new URL(href, linkBase()); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  }

  // Hand a link to the app's own hook before it becomes a window. Returns the URL
  // to open, or null when the app claimed it (routed the destination in-app) or
  // rewrote it to something unopenable.
  //
  // A throwing hook opens the link unchanged rather than swallowing it: a bug in
  // an app's routing must not resurrect the failure this module exists to
  // prevent.
  function routeLink(url, anchor) {
    if (!linkHandler) return url;
    var out;
    try {
      out = linkHandler(url, anchor || null);
    } catch (e) {
      console.error('[yaar] links.onOpen threw; opening the link unchanged', e);
      return url;
    }
    if (out === false) return null;
    if (typeof out === 'string') return resolveLink(out);
    return url;
  }

  window.yaar.windows = {
    read: function(windowId) {
      return window.yaar.read('yaar://windows/' + windowId).then(function(data) {
        if (typeof data === 'string') {
          try { return JSON.parse(data); } catch(e) { return { id: windowId, content: data }; }
        }
        return data || { id: windowId, content: '' };
      });
    },
    list: function() {
      return window.yaar.list('yaar://windows').then(function(data) {
        if (Array.isArray(data)) return data;
        if (typeof data === 'string') {
          try { return JSON.parse(data); } catch(e) { return []; }
        }
        return [];
      });
    },
    // Open a URL in a window of its own. Fire-and-forget: the desktop owns window
    // creation, and an app that had to await one would be waiting on the shell to
    // finish rendering.
    //
    // The alternative an app used to have was \`window.open\`, which leaves YAAR for
    // a browser tab, or a plain link — which navigates the app's own frame and
    // silently takes the app protocol with it (the link guard below).
    //
    // Deliberately does NOT run the app's own \`links.onOpen\` hook: this is the app
    // asking for a specific destination, not content asking to go somewhere.
    openUrl: function(url, opts) {
      if (typeof url !== 'string' || !url) return;
      var resolved = resolveLink(url);
      if (!resolved) return;
      postOpenUrl(resolved, (opts && typeof opts.title === 'string') ? opts.title : '');
    }
  };

  // The app-facing surface for all of the above. Three apps had grown their own
  // copy of this file (a resolver, an openExternal wrapper, a capture-phase
  // listener) because the pieces were not reachable from app code; these are the
  // two things those copies actually needed that a default cannot supply.
  window.yaar.links = {
    // Same door as windows.openUrl, named for what it is.
    open: function(url, opts) { window.yaar.windows.openUrl(url, opts); },
    // Decide what a link in this app's content means. The hook receives the
    // resolved absolute URL and the anchor it came from (null for a
    // \`window.open\` call), and returns:
    //   a string  -> open that instead (rewrite: unwrap an interstitial, swap a
    //                mirror, canonicalize)
    //   false     -> the app claimed it; no window opens (in-app routing)
    //   undefined -> open the URL as given
    onOpen: function(fn) { linkHandler = typeof fn === 'function' ? fn : null; },
    // The resolver the guard uses, for an app that needs the same answer for
    // something that is not an anchor click.
    resolve: resolveLink
  };

  // \`window.open\` means the same thing as \`openUrl\` here, so it lands in the same
  // place: a YAAR window, not a browser tab. An app that reaches for it is not
  // asking to leave the desktop — it is asking for a link it renders to open
  // *somewhere other than its own frame*, and \`window.open\` was the only such door
  // an app knew about before \`openUrl\` existed. Apps that predate it (and any the
  // agent writes from memory of the web) keep working without an edit.
  //
  // The failure this removes is the second-order one: a blocked popup returns
  // null, so those apps carry a fallback — copy the address, toast an apology —
  // and that apology is what the user actually sees. A stub window is returned
  // for exactly that reason: \`if (!w)\` must not read as "blocked" when the
  // destination did open.
  //
  // Passed through to the browser: a call with no URL (the caller wants a handle
  // to write into, which a YAAR window cannot give it) and any non-http(s) scheme
  // (mailto:, blob:, data: — none of them a page the desktop can host). Set
  // \`window.__yaarAllowPopups = true\` to opt out entirely, as
  // \`__yaarAllowFrameNavigation\` opts out of the link guard.
  var nativeOpen = typeof window.open === 'function' ? window.open : null;
  function nativePopup(url, target, features) {
    return nativeOpen ? nativeOpen.call(window, url, target, features) : null;
  }
  function openedWindowStub(href) {
    function noop() {}
    return {
      closed: false,
      close: noop, focus: noop, blur: noop, postMessage: noop,
      opener: null,
      location: { href: href, assign: noop, replace: noop, toString: function() { return href; } }
    };
  }
  window.open = function(url, target, features) {
    if (window.__yaarAllowPopups) return nativePopup(url, target, features);
    var raw = (url === undefined || url === null) ? '' : String(url);
    if (!raw) return nativePopup(url, target, features);
    var resolved = resolveLink(raw);
    if (!resolved) return nativePopup(url, target, features);
    // Foreign code asking to leave the frame, same category as an anchor — so the
    // app's hook sees it too.
    var routed = routeLink(resolved, null);
    if (routed) postOpenUrl(routed, '');
    return openedWindowStub(routed || resolved);
  };

  /**
   * Keep a link in app content from navigating the app's own document away.
   *
   * An app frame is same-origin and unsandboxed, and **no** sandbox token governs a
   * frame navigating *itself* — the \`allow-top-navigation\` family only governs the
   * top-level context — so nothing at the frame level could have prevented this. A
   * plain \`<a href>\` in app-rendered HTML therefore replaced the app document and
   * every script injected into it, this SDK included: no exception, no console
   * output, and an app that simply stopped answering the protocol. Indistinguishable
   * from a crash.
   *
   * Bubble phase on the document, after the app's own handlers, so a link the app
   * already handles (a router link, a \`preventDefault()\` anywhere on the path) is
   * left alone — that is the cooperation point, and \`links.onOpen\` is the other.
   * It arms for an app (a compiled app, or one that has registered) and not for a
   * plain HTML document previewed in a window, which still browses in place.
   *
   * What it stands aside for is now exactly the set of clicks that do NOT replace
   * the app's document — a download, a right-click, a frame the app owns — and
   * nothing else. It used to also stand aside for \`target="_blank"\` and for
   * ctrl/cmd/shift-clicks, on the reasoning that the user had asked for a browser
   * tab. Inside YAAR there is no tab to ask for: those clicks left the desktop, or
   * hit the popup blocker and did nothing at all. Since \`target="_blank"\` is the
   * ordinary way to write an external link — and what an agent writes from memory
   * of the web — that exemption covered most real links in most real apps, and was
   * the single reason apps kept hand-rolling a stricter guard of their own.
   *
   * Escape hatch for an app that really does want its frame navigated:
   * \`window.__yaarAllowFrameNavigation = true\`.
   */
  function guardArmed() {
    if (window.__yaarAllowFrameNavigation) return false;
    return !!(linkConfig() || window.__yaarAppRegistered);
  }

  // A named target the app itself frames is the app's own business. Every other
  // target — _blank, _top, a name with no frame behind it — says "not in my
  // document", which is what a YAAR window is.
  function framedTarget(name) {
    if (typeof document === 'undefined' || !document.querySelector) return false;
    try {
      return !!document.querySelector('iframe[name="' + name + '"], frame[name="' + name + '"]');
    } catch (e) { return false; }
  }

  // The href resolved against the app's OWN document, whatever \`base\` says.
  // Needed on its own because a link back into the app must keep working in an app
  // that configures a base for the foreign content it renders.
  function selfRelative(href) {
    try {
      return new URL(href, (typeof document !== 'undefined' && document.baseURI) || undefined).href;
    } catch (e) { return null; }
  }

  function onLinkActivation(e) {
    if (!guardArmed()) return;
    if (e.defaultPrevented) return;
    // Left and middle only. Right opens the context menu, which navigates nothing.
    if (e.button !== 0 && e.button !== 1) return;
    // Alt+click is "save this link", not "go there" — it never replaces the
    // document, so it stays the browser's.
    if (e.altKey) return;
    var a = null;
    var node = e.target;
    if (node && node.closest) {
      try { a = node.closest('a[href]'); } catch (err) { a = null; }
    }
    if (!a) return;
    // \`download\` is not a navigation.
    if (a.hasAttribute('download')) return;
    var target = a.getAttribute('target');
    if (target && target.charAt(0) !== '_' && framedTarget(target)) return;
    var href = trim(a.getAttribute('href'));
    if (!href || href.charAt(0) === '#') return;
    // A link to this same document (differing only by hash) stays in the app.
    var here = String(location.href).split('#')[0];
    var self = selfRelative(href);
    if (self && self.split('#')[0] === here) return;
    var url = resolveLink(href);
    if (!url) return;
    // Cancel first, decide after: even a link the app claims must not be allowed
    // to navigate this document while the hook runs.
    e.preventDefault();
    var routed = routeLink(url, a);
    if (!routed) return;
    postOpenUrl(routed, trim(a.textContent).slice(0, 80));
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', onLinkActivation);
    // \`auxclick\` is the middle button, whose default action is its own navigation
    // and is not reported as a \`click\`.
    document.addEventListener('auxclick', onLinkActivation);
  }
})();
`;
