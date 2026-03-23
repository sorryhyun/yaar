/**
 * Inline JS windows SDK for iframe apps.
 *
 * Provides window.yaar.windows with read/list methods
 * so iframe apps can read other windows' content (read-only).
 * Reimplemented over the verb SDK (POST /api/verb).
 */
export const IFRAME_WINDOWS_SDK_SCRIPT = `
(function() {
  if (window.__yaarWindowsInstalled) return;
  window.__yaarWindowsInstalled = true;

  window.yaar = window.yaar || {};

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
    }
  };
})();
`;
