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

  function extractText(result) {
    if (result && result.content && result.content[0] && result.content[0].text !== undefined) {
      return result.content[0].text;
    }
    return '';
  }

  window.yaar.windows = {
    read: function(windowId, options) {
      return window.yaar.read('yaar://windows/' + windowId).then(function(result) {
        var text = extractText(result);
        try { return JSON.parse(text); } catch(e) { return { id: windowId, content: text }; }
      });
    },
    list: function() {
      return window.yaar.list('yaar://windows').then(function(result) {
        var text = extractText(result);
        try { return JSON.parse(text); } catch(e) { return []; }
      });
    }
  };
})();
`;
