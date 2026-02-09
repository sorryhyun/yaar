/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Captures the largest <canvas> element, or falls back to SVG serialization.
 */
export const IFRAME_CAPTURE_HELPER_SCRIPT = `
(function() {
  if (window.__yaarCaptureInstalled) return;
  window.__yaarCaptureInstalled = true;

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'yaar:capture-request') return;
    var requestId = e.data.requestId;
    var imageData = null;

    try {
      // Try capturing the largest canvas element
      var canvases = document.querySelectorAll('canvas');
      if (canvases.length > 0) {
        var largest = null;
        var largestArea = 0;
        for (var i = 0; i < canvases.length; i++) {
          var area = canvases[i].width * canvases[i].height;
          if (area > largestArea) {
            largestArea = area;
            largest = canvases[i];
          }
        }
        if (largest) {
          imageData = largest.toDataURL('image/png');
        }
      }

      // Fall back to SVG capture
      if (!imageData) {
        var svgs = document.querySelectorAll('svg');
        if (svgs.length > 0) {
          var largest = null;
          var largestArea = 0;
          for (var i = 0; i < svgs.length; i++) {
            var rect = svgs[i].getBoundingClientRect();
            var area = rect.width * rect.height;
            if (area > largestArea) {
              largestArea = area;
              largest = svgs[i];
            }
          }
          if (largest) {
            var serializer = new XMLSerializer();
            var svgStr = serializer.serializeToString(largest);
            var rect = largest.getBoundingClientRect();
            var w = rect.width || 300;
            var h = rect.height || 150;
            var img = new Image();
            var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            img.onload = function() {
              var c = document.createElement('canvas');
              c.width = w;
              c.height = h;
              var ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0, w, h);
              URL.revokeObjectURL(url);
              window.parent.postMessage({
                type: 'yaar:capture-response',
                requestId: requestId,
                imageData: c.toDataURL('image/png')
              }, '*');
            };
            img.onerror = function() {
              URL.revokeObjectURL(url);
              window.parent.postMessage({
                type: 'yaar:capture-response',
                requestId: requestId,
                imageData: null
              }, '*');
            };
            img.src = url;
            return; // async path — response sent from onload/onerror
          }
        }
      }
    } catch (ex) {
      // Capture failed, imageData stays null
    }

    window.parent.postMessage({
      type: 'yaar:capture-response',
      requestId: requestId,
      imageData: imageData
    }, '*');
  });
})();
`;

/**
 * Inline JS storage SDK for iframe apps.
 *
 * Provides window.yaar.storage with save/read/list/remove/url methods
 * so compiled apps can access the server's storage directory via REST.
 */
export const IFRAME_STORAGE_SDK_SCRIPT = `
(function() {
  if (window.__yaarStorageInstalled) return;
  window.__yaarStorageInstalled = true;

  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  window.yaar = window.yaar || {};
  window.yaar.storage = {
    async save(path, data) {
      var body;
      if (typeof data === 'string') {
        body = data;
      } else if (data instanceof Blob) {
        body = await data.arrayBuffer();
      } else if (data instanceof ArrayBuffer) {
        body = data;
      } else if (data instanceof Uint8Array) {
        body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        body = String(data);
      }
      var res = await fetch('/api/storage/' + encodePath(path), { method: 'POST', body: body });
      if (!res.ok) {
        var err = await res.json().catch(function() { return { error: res.statusText }; });
        throw new Error(err.error || 'Save failed');
      }
      return res.json();
    },

    async read(path, options) {
      var mode = (options && options.as) || 'auto';
      var res = await fetch('/api/storage/' + encodePath(path));
      if (!res.ok) {
        var err = await res.json().catch(function() { return { error: res.statusText }; });
        throw new Error(err.error || 'Read failed');
      }
      if (mode === 'blob') return res.blob();
      if (mode === 'arraybuffer') return res.arrayBuffer();
      if (mode === 'json') return res.json();
      if (mode === 'text') return res.text();
      // auto: guess from content-type
      var ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) return res.json();
      if (ct.startsWith('text/')) return res.text();
      return res.blob();
    },

    async list(dirPath) {
      var p = dirPath ? encodePath(dirPath) : '';
      var res = await fetch('/api/storage/' + p + '?list=true');
      if (!res.ok) {
        var err = await res.json().catch(function() { return { error: res.statusText }; });
        throw new Error(err.error || 'List failed');
      }
      return res.json();
    },

    async remove(path) {
      var res = await fetch('/api/storage/' + encodePath(path), { method: 'DELETE' });
      if (!res.ok) {
        var err = await res.json().catch(function() { return { error: res.statusText }; });
        throw new Error(err.error || 'Delete failed');
      }
      return res.json();
    },

    url: function(path) {
      return '/api/storage/' + encodePath(path);
    }
  };
})();
`;

/**
 * Inline JS fetch proxy for iframe apps.
 *
 * Overrides window.fetch so cross-origin requests are routed through
 * POST /api/fetch, which enforces the domain allowlist.
 * Same-origin and relative URLs pass through to the real fetch.
 */
export const IFRAME_FETCH_PROXY_SCRIPT = `
(function() {
  if (window.__yaarFetchProxyInstalled) return;
  window.__yaarFetchProxyInstalled = true;

  var realFetch = window.fetch.bind(window);

  window.fetch = function(input, init) {
    var url;
    if (input instanceof Request) {
      url = input.url;
    } else {
      url = String(input);
    }

    // Relative URLs and same-origin — pass through
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
      return realFetch(input, init);
    }
    try {
      var parsed = new URL(url, location.origin);
      if (parsed.origin === location.origin) {
        return realFetch(input, init);
      }
    } catch(e) {
      return realFetch(input, init);
    }

    // Cross-origin — route through proxy
    var method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    var headers = {};
    if (init && init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach(function(v, k) { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(function(pair) { headers[pair[0]] = pair[1]; });
      } else {
        headers = Object.assign({}, init.headers);
      }
    } else if (input instanceof Request) {
      input.headers.forEach(function(v, k) { headers[k] = v; });
    }

    var bodyPromise;
    if (init && init.body != null) {
      if (typeof init.body === 'string') {
        bodyPromise = Promise.resolve(init.body);
      } else {
        bodyPromise = new Response(init.body).text();
      }
    } else if (input instanceof Request && method !== 'GET' && method !== 'HEAD') {
      bodyPromise = input.text();
    } else {
      bodyPromise = Promise.resolve(undefined);
    }

    return bodyPromise.then(function(bodyStr) {
      var payload = { url: url, method: method, headers: headers };
      if (bodyStr !== undefined) payload.body = bodyStr;

      return realFetch('/api/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function(proxyRes) {
      if (!proxyRes.ok) {
        return proxyRes.json().then(function(err) {
          throw new Error(err.error || 'Fetch proxy error: ' + proxyRes.status);
        });
      }
      return proxyRes.json();
    }).then(function(data) {
      var body;
      if (data.bodyEncoding === 'base64') {
        var bin = atob(data.body);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        body = bytes.buffer;
      } else {
        body = data.body;
      }
      return new Response(body, {
        status: data.status,
        statusText: data.statusText,
        headers: data.headers
      });
    });
  };
})();
`;
