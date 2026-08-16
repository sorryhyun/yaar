/**
 * Inline JS windows SDK for iframe apps.
 *
 * Provides window.yaar.windows with read/list methods
 * so iframe apps can read other windows' content (read-only).
 * Reimplemented over the verb SDK (POST /api/verb).
 *
 * Plus the one write in it — `openUrl`, an http(s) destination handed to the
 * desktop to open in a window of its own — and the `window.open` override that
 * routes an app's own popups the same way. See the comments on each.
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
    // silently takes the app protocol with it (the link guard in
    // iframe-scripts/app-protocol.ts, which routes here).
    openUrl: function(url, opts) {
      if (typeof url !== 'string' || !url) return;
      postOpenUrl(url, (opts && typeof opts.title === 'string') ? opts.title : '');
    }
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
    var base = (typeof document !== 'undefined' && document.baseURI) || undefined;
    var parsed;
    try { parsed = new URL(raw, base); } catch (e) { return nativePopup(url, target, features); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return nativePopup(url, target, features);
    }
    postOpenUrl(parsed.href, '');
    return openedWindowStub(parsed.href);
  };
})();
`;
