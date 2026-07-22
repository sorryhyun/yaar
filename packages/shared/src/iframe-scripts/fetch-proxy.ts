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
  // App-origin isolation (Stage 1): the backend the SDK talks to. When this app is
  // served from the sibling loopback origin, API calls (including our own proxy
  // endpoint) must target the desktop origin. Empty otherwise → relative as before.
  var API_BASE = '';
  var API_ORIGIN = '';
  try {
    var sp = new URLSearchParams(location.search);
    var raw = sp.get('sessionId') || '';
    if (/^[a-zA-Z0-9_-]+$/.test(raw)) sessionId = raw;
    var _b = sp.get('__yaar_api');
    if (_b && /^https?:\\/\\/[a-zA-Z0-9.:_-]+$/.test(_b)) {
      API_BASE = _b.replace(/\\/$/, '');
      try { API_ORIGIN = new URL(API_BASE).origin; } catch(e) {}
    }
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
      // The desktop API origin is trusted infrastructure, not an external site:
      // the verb/storage SDKs address it absolutely when this app is isolated, so
      // pass it through with the token header rather than routing it back through
      // the proxy (which would wrap our own /api/fetch call and never terminate).
      if (parsed.origin === location.origin || (API_ORIGIN && parsed.origin === API_ORIGIN)) {
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

    // Redirect mode. Only 'manual' is worth forwarding — the server defaults to
    // 'follow', and 'error' has no representation on the proxy path, so it is left
    // to fall back to 'follow' rather than being silently mistranslated.
    var redirect = (init && init.redirect) || (input instanceof Request ? input.redirect : null);

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
      if (redirect === 'manual') payload.redirect = 'manual';

      var proxyHeaders = { 'Content-Type': 'application/json' };
      if (iframeToken) proxyHeaders['X-Iframe-Token'] = iframeToken;

      return realFetch(API_BASE + '/api/fetch', {
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
