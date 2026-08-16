/**
 * Inline JS windows SDK for iframe apps.
 *
 * Provides window.yaar.windows with read/list methods
 * so iframe apps can read other windows' content (read-only).
 * Reimplemented over the verb SDK (POST /api/verb).
 */
import { APP_MSG } from '../app-protocol.js';
import { installGuard, YAAR_NAMESPACE } from './prelude.js';
export const IFRAME_WINDOWS_SDK_SCRIPT = `
(function() {
  ${installGuard('__yaarWindowsInstalled')}
  ${YAAR_NAMESPACE}

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
      window.parent.postMessage({
        type: '${APP_MSG.openUrl}',
        url: url,
        title: (opts && typeof opts.title === 'string') ? opts.title : ''
      }, '*');
    }
  };
})();
`;
