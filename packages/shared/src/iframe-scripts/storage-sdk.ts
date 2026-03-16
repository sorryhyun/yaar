/**
 * Inline JS storage SDK for iframe apps.
 *
 * Provides window.yaar.storage with save/read/list/remove/url methods
 * that dispatch to the /api/storage REST endpoints.
 */
export const IFRAME_STORAGE_SDK_SCRIPT = `
(function() {
  if (window.__yaarStorageInstalled) return;
  window.__yaarStorageInstalled = true;

  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  window.yaar = window.yaar || {};

  var iframeToken = '';
  try {
    var sp = new URLSearchParams(location.search);
    iframeToken = sp.get('__yaar_token') || '';
  } catch(e) {}

  function tokenHeaders(extra) {
    var h = extra || {};
    var t = window.__YAAR_TOKEN__ || iframeToken;
    if (t) h['X-Iframe-Token'] = t;
    return h;
  }

  window.yaar.storage = {
    save: function(path, data) {
      var body;
      if (typeof data === 'string') {
        body = data;
      } else if (data instanceof Blob) {
        body = data;
      } else if (data instanceof ArrayBuffer) {
        body = data;
      } else if (data instanceof Uint8Array) {
        body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        body = String(data);
      }
      return fetch('/api/storage/' + encodePath(path), {
        method: 'POST',
        headers: tokenHeaders(),
        body: body
      }).then(function(res) {
        if (!res.ok) {
          return res.json().catch(function() { return { error: res.statusText }; }).then(function(err) {
            throw new Error(err.error || 'Save failed');
          });
        }
        return res.json();
      });
    },
    read: function(path, options) {
      var mode = (options && options.as) || 'auto';
      return fetch('/api/storage/' + encodePath(path), {
        headers: tokenHeaders()
      }).then(function(res) {
        if (!res.ok) {
          return res.json().catch(function() { return { error: res.statusText }; }).then(function(err) {
            throw new Error(err.error || 'Read failed');
          });
        }
        if (mode === 'blob') return res.blob();
        if (mode === 'arraybuffer') return res.arrayBuffer();
        if (mode === 'json') return res.json();
        if (mode === 'text') return res.text();
        var ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) return res.json();
        if (ct.startsWith('text/')) return res.text();
        return res.blob();
      });
    },
    list: function(dirPath) {
      var p = dirPath ? encodePath(dirPath) : '';
      return fetch('/api/storage/' + p + '?list=true', {
        headers: tokenHeaders()
      }).then(function(res) {
        if (!res.ok) {
          return res.json().catch(function() { return { error: res.statusText }; }).then(function(err) {
            throw new Error(err.error || 'List failed');
          });
        }
        return res.json();
      });
    },
    remove: function(path) {
      return fetch('/api/storage/' + encodePath(path), {
        method: 'DELETE',
        headers: tokenHeaders()
      }).then(function(res) {
        if (!res.ok) {
          return res.json().catch(function() { return { error: res.statusText }; }).then(function(err) {
            throw new Error(err.error || 'Delete failed');
          });
        }
        return res.json();
      });
    },
    url: function(path) {
      return '/api/storage/' + encodePath(path);
    }
  };
})();
`;
