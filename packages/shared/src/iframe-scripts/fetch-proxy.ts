/**
 * Inline JS fetch proxy for iframe apps.
 *
 * Overrides window.fetch so cross-origin requests are routed through
 * POST /api/fetch, which enforces the domain allowlist.
 * Same-origin and relative URLs pass through to the real fetch.
 */
import { API_BOOTSTRAP, installGuard, RESPONSE_FROM_PROXY } from './prelude.js';

export const IFRAME_FETCH_PROXY_SCRIPT = `
(function() {
  ${installGuard('__yaarFetchProxyInstalled')}
  ${API_BOOTSTRAP}
  ${RESPONSE_FROM_PROXY}

  var realFetch = window.fetch.bind(window);

  // Extract sessionId from URL params for domain permission dialogs
  var sessionId = '';
  try {
    var raw = new URLSearchParams(location.search).get('sessionId') || '';
    if (/^[a-zA-Z0-9_-]+$/.test(raw)) sessionId = raw;
  } catch(e) {}

  // Add X-Iframe-Token to same-origin requests for route restriction
  function addTokenHeader(input, init) {
    var token = yaarToken();
    if (!token) return realFetch(input, init);
    var newInit = Object.assign({}, init || {});
    var headers = new Headers(newInit.headers || {});
    headers.set('X-Iframe-Token', token);
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

    // Self-contained URLs carry their own bytes. There is nothing to proxy, and a
    // data: URL's origin parses as the string "null" — so the cross-origin check
    // below would classify it as an external site and POST the entire base64
    // payload to /api/fetch, which rejects it without an iframe token and, with
    // one, would round-trip megabytes to decode a string the app already holds.
    // realFetch rather than addTokenHeader: there is no request to authorize.
    if (/^(data|blob):/i.test(url)) {
      return realFetch(input, init);
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
      var token = yaarToken();
      if (token) proxyHeaders['X-Iframe-Token'] = token;

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
    }).then(responseFromProxyPayload);
  };
})();
`;
