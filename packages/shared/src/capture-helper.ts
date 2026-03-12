/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Capture priority:
 *   1. Largest <canvas> element (direct toDataURL)
 *   2. Largest <svg> element (serialize → Image → canvas)
 *   3. Returns null — parent falls back to html2canvas on contentDocument
 */
export const IFRAME_CAPTURE_HELPER_SCRIPT = `
(function() {
  if (window.__yaarCaptureInstalled) return;
  window.__yaarCaptureInstalled = true;

  function respond(requestId, imageData) {
    window.parent.postMessage({
      type: 'yaar:capture-response',
      requestId: requestId,
      imageData: imageData
    }, '*');
  }

  /**
   * Render an SVG string to a canvas PNG data URL, then call cb(dataUrl).
   */
  function svgToCanvas(svgStr, w, h, cb) {
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function() {
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cb(c.toDataURL('image/png'));
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      cb(null);
    };
    img.src = url;
  }

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'yaar:capture-request') return;
    var requestId = e.data.requestId;
    var imageData = null;

    try {
      // Tier 1: capture the largest canvas element
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

      if (imageData) {
        respond(requestId, imageData);
        return;
      }

      // Tier 2: capture the largest SVG element
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
          svgToCanvas(svgStr, rect.width || 300, rect.height || 150, function(data) {
            respond(requestId, data);
          });
          return; // async
        }
      }

      // No canvas or SVG found — return null so the parent can try
      // html2canvas on the iframe's contentDocument (more reliable than
      // foreignObject SVG which often produces blank/white images).
    } catch (ex) {
      // Capture failed, imageData stays null
    }

    respond(requestId, null);
  });
})();
`;

/**
 * Inline JS storage SDK for iframe apps.
 *
 * Provides window.yaar.storage with save/read/list/remove/url methods.
 * Reimplemented over the verb SDK (POST /api/verb) using app-scoped
 * storage at yaar://apps/self/storage/{path}.
 */
export const IFRAME_STORAGE_SDK_SCRIPT = `
(function() {
  if (window.__yaarStorageInstalled) return;
  window.__yaarStorageInstalled = true;

  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  function extractText(result) {
    if (result && result.content && result.content[0] && result.content[0].text !== undefined) {
      return result.content[0].text;
    }
    return '';
  }

  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  window.yaar = window.yaar || {};
  window.yaar.storage = {
    async save(path, data) {
      var content;
      var encoding = 'utf-8';
      if (typeof data === 'string') {
        content = data;
      } else if (data instanceof Blob) {
        var buf = await data.arrayBuffer();
        content = toBase64(new Uint8Array(buf));
        encoding = 'base64';
      } else if (data instanceof ArrayBuffer) {
        content = toBase64(new Uint8Array(data));
        encoding = 'base64';
      } else if (data instanceof Uint8Array) {
        content = toBase64(data);
        encoding = 'base64';
      } else {
        content = String(data);
      }
      await window.yaar.invoke('yaar://apps/self/storage/' + path, {
        action: 'write', content: content, encoding: encoding
      });
      return { ok: true };
    },

    async read(path, options) {
      var mode = (options && options.as) || 'auto';
      if (mode === 'blob' || mode === 'arraybuffer') {
        // Binary modes — use direct URL for efficiency
        var res = await fetch(window.yaar.storage.url(path));
        if (!res.ok) throw new Error('Read failed: ' + res.statusText);
        return mode === 'blob' ? res.blob() : res.arrayBuffer();
      }
      var result = await window.yaar.read('yaar://apps/self/storage/' + path);
      var text = extractText(result);
      if (mode === 'json') return JSON.parse(text);
      if (mode === 'text') return text;
      // auto: try JSON first
      try { return JSON.parse(text); } catch(e) { return text; }
    },

    async list(dirPath) {
      var result = await window.yaar.list('yaar://apps/self/storage/' + (dirPath || ''));
      return JSON.parse(extractText(result));
    },

    async remove(path) {
      await window.yaar.delete('yaar://apps/self/storage/' + path);
      return { ok: true };
    },

    url: function(path) {
      return '/api/storage/apps/self/' + encodePath(path);
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
  var iframeToken = window.__YAAR_TOKEN__ || '';

  // Extract sessionId from URL params for domain permission dialogs
  var sessionId = '';
  try {
    var sp = new URLSearchParams(location.search);
    var raw = sp.get('sessionId') || '';
    if (/^[a-zA-Z0-9_-]+$/.test(raw)) sessionId = raw;
  } catch(e) {}

  // Add X-Iframe-Token to same-origin requests for route restriction
  function addTokenHeader(input, init) {
    if (!iframeToken) return realFetch(input, init);
    var newInit = Object.assign({}, init || {});
    var headers = new Headers(newInit.headers || {});
    headers.set('X-Iframe-Token', iframeToken);
    newInit.headers = headers;
    return realFetch(input, newInit);
  }

  window.fetch = function(input, init) {
    var url;
    if (input instanceof Request) {
      url = input.url;
    } else {
      url = String(input);
    }

    // Relative URLs and same-origin — pass through with token header
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
      return addTokenHeader(input, init);
    }
    try {
      var parsed = new URL(url, location.origin);
      if (parsed.origin === location.origin) {
        return addTokenHeader(input, init);
      }
    } catch(e) {
      return addTokenHeader(input, init);
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
      if (sessionId) payload.sessionId = sessionId;

      var proxyHeaders = { 'Content-Type': 'application/json' };
      if (iframeToken) proxyHeaders['X-Iframe-Token'] = iframeToken;

      return realFetch('/api/fetch', {
        method: 'POST',
        headers: proxyHeaders,
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

/**
 * Inline JS interaction helper for iframe apps.
 *
 * Handles interactions inside same-origin iframes:
 * 1. Context menu — prevents browser default, posts `yaar:contextmenu`
 * 2. Left click — posts `yaar:click` so parent can dismiss context menu
 * 3. Text drag — posts `yaar:drag-start` so parent can track cross-window drags
 */
export const IFRAME_CONTEXTMENU_SCRIPT = `
(function() {
  if (window.__yaarContextMenuInstalled) return;
  window.__yaarContextMenuInstalled = true;

  // Right-click drawing forwarding — the parent uses mousedown/mousemove/mouseup
  // with button 2 for freehand drawing, but those events don't cross
  // iframe boundaries. Forward them via postMessage so the parent can drive the drawing.
  var rightDragging = false;
  var rightDragMoved = false;

  document.addEventListener('mousedown', function(e) {
    if (e.button !== 2) return;
    rightDragging = true;
    rightDragMoved = false;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-start',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('mousemove', function(e) {
    if (!rightDragging) return;
    rightDragMoved = true;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-move',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  document.addEventListener('mouseup', function(e) {
    if (!rightDragging) return;
    rightDragging = false;
    window.parent.postMessage({
      type: 'yaar:arrow-drag-end',
      clientX: e.clientX,
      clientY: e.clientY
    }, '*');
  });

  // Left click — notify parent so it can dismiss context menu, etc.
  document.addEventListener('click', function() {
    window.parent.postMessage({ type: 'yaar:click' }, '*');
  });

  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    // After a right-click drag, suppress the context menu forwarding —
    // the parent already processed the drag gesture.
    if (rightDragMoved) {
      rightDragMoved = false;
      return;
    }
    // Simple right-click (no drag) — cancel drawing tracking.
    // The parent's context menu overlay may steal the mouseup event,
    // leaving rightDragging stuck at true. Reset it and notify parent.
    if (rightDragging) {
      rightDragging = false;
      window.parent.postMessage({
        type: 'yaar:arrow-drag-end',
        clientX: e.clientX,
        clientY: e.clientY
      }, '*');
    }
    var selectedText = '';
    try {
      selectedText = (window.getSelection() || '').toString().trim();
    } catch(ex) {}
    window.parent.postMessage({
      type: 'yaar:contextmenu',
      clientX: e.clientX,
      clientY: e.clientY,
      selectedText: selectedText
    }, '*');
  });

  // Forward global keyboard shortcuts to the parent so they work even
  // when the iframe has focus (Shift+Tab, Ctrl+1-9, Ctrl+W).
  document.addEventListener('keydown', function(e) {
    var dominated = false;
    if (e.key === 'Tab' && e.shiftKey) dominated = true;
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') dominated = true;
    if (e.ctrlKey && e.key === 'w') dominated = true;
    if (!dominated) return;
    e.preventDefault();
    window.parent.postMessage({
      type: 'yaar:keydown',
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    }, '*');
  });

  // Drag: notify parent so it can track cross-window drags.
  // Handles both text selection drags and draggable element drags (e.g. storage items).
  // This listener runs on document (bubble phase), so app-specific dragstart handlers
  // that set dataTransfer have already executed by the time we read it.
  document.addEventListener('dragstart', function(e) {
    var text = '';
    try {
      text = (window.getSelection() || '').toString().trim();
    } catch(ex) {}
    if (text) {
      // Text selection drag — also mark it for parent detection
      try { e.dataTransfer.setData('application/x-yaar-text', text); } catch(ex) {}
    } else {
      // Draggable element (no text selection) — read text/plain set by the app
      try { text = (e.dataTransfer.getData('text/plain') || '').trim(); } catch(ex) {}
    }
    if (!text) return;
    window.parent.postMessage({
      type: 'yaar:drag-start',
      text: text
    }, '*');
  });
})();
`;

/**
 * Inline JS notifications SDK for iframe apps.
 *
 * Provides window.yaar.notifications with list/count/onChange methods
 * so compiled apps can reactively track the parent's notification state.
 * Parent pushes updates via `yaar:notifications-update` postMessages.
 */
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

/**
 * Inline JS verb SDK for iframe apps.
 *
 * Provides window.yaar verb methods (invoke, read, list, describe, delete)
 * that dispatch to POST /api/verb with the iframe token header.
 * Uses the same yaar:// URI pattern the agent uses via MCP.
 */
export const IFRAME_VERB_SDK_SCRIPT = `
(function() {
  if (window.__yaarVerbInstalled) return;
  window.__yaarVerbInstalled = true;

  window.yaar = window.yaar || {};

  // Read token from URL query param (available immediately for compiled apps)
  // before handleLoad injects __YAAR_TOKEN__ via script injection.
  try {
    var sp = new URLSearchParams(location.search);
    var urlToken = sp.get('__yaar_token');
    if (urlToken && !window.__YAAR_TOKEN__) window.__YAAR_TOKEN__ = urlToken;
  } catch(e) {}

  function tokenHeaders() {
    var t = window.__YAAR_TOKEN__ || '';
    var h = { 'Content-Type': 'application/json' };
    if (t) h['X-Iframe-Token'] = t;
    return h;
  }

  function callVerb(verb, uri, payload) {
    var body = { verb: verb, uri: uri };
    if (payload !== undefined) body.payload = payload;
    return fetch('/api/verb', {
      method: 'POST',
      headers: tokenHeaders(),
      body: JSON.stringify(body)
    }).then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok) throw new Error(data.error || 'Verb call failed');
        if (data.isError) {
          var msg = (data.content && data.content[0] && data.content[0].text) || 'Verb error';
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  window.yaar.invoke = function(uri, payload) { return callVerb('invoke', uri, payload); };
  window.yaar.read = function(uri) { return callVerb('read', uri); };
  window.yaar.list = function(uri) { return callVerb('list', uri); };
  window.yaar.describe = function(uri) { return callVerb('describe', uri); };
  window.yaar.delete = function(uri) { return callVerb('delete', uri); };

  // ── Reactive subscriptions ──
  var __yaarSubs = {};
  var __yaarSubCounter = 0;

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'yaar:subscription-update') return;
    var id = e.data.subscriptionId;
    if (__yaarSubs[id]) {
      try { __yaarSubs[id](e.data.uri); } catch(err) {}
    }
  });

  window.yaar.subscribe = function(uri, callback) {
    var headers = tokenHeaders();
    return fetch('/api/verb/subscribe', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ uri: uri, action: 'subscribe' })
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) throw new Error(data.error);
      var serverId = data.subscriptionId;
      __yaarSubs[serverId] = callback;
      return function unsubscribe() {
        delete __yaarSubs[serverId];
        return fetch('/api/verb/subscribe', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ action: 'unsubscribe', subscriptionId: serverId })
        }).then(function() {});
      };
    });
  };

  window.yaar.fetch = function(url, options) {
    var payload = { url: url };
    if (options) {
      if (options.method) payload.method = options.method;
      if (options.headers) payload.headers = options.headers;
      if (options.body) payload.body = options.body;
    }
    return window.yaar.invoke('yaar://http', payload).then(function(result) {
      var text = (result && result.content && result.content[0] && result.content[0].text) || '{}';
      var data = JSON.parse(text);
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

export const IFRAME_NOTIFICATIONS_SDK_SCRIPT = `
(function() {
  if (window.__yaarNotificationsInstalled) return;
  window.__yaarNotificationsInstalled = true;

  window.yaar = window.yaar || {};

  var items = [];
  var callbacks = [];

  function notify() {
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](items); } catch(e) {}
    }
  }

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'yaar:notifications-update') return;
    items = Array.isArray(e.data.items) ? e.data.items : [];
    notify();
  });

  window.yaar.notifications = {
    list: function() { return items; },
    count: function() { return items.length; },
    onChange: function(cb) {
      callbacks.push(cb);
      try { cb(items); } catch(e) {}
      return function() {
        callbacks = callbacks.filter(function(fn) { return fn !== cb; });
      };
    }
  };
})();
`;
