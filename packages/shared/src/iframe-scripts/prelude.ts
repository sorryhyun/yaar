/**
 * Shared source fragments for the injected iframe scripts.
 *
 * Every script in this directory is a template literal of ES5 that gets injected
 * into an app iframe, so "sharing code" between them is string interpolation —
 * there is no module system on the other side. These fragments are the pieces
 * that were previously written out once per script, each time slightly
 * differently.
 *
 * The important one is {@link API_BOOTSTRAP}. Token discovery used to have three
 * spellings: `verb-sdk` read the `__yaar_token` URL param and back-filled
 * `window.__YAAR_TOKEN__`, `storage-sdk` read the param into a local and
 * preferred the global at call time, and `fetch-proxy` read *only* the global,
 * once, at install. That last one worked solely because `verb-sdk` is listed
 * before it at both injection sites (`compiler/src/compile.ts` and
 * `IframeRenderer.tsx`) and back-filled the global it reads — reorder those
 * arrays and cross-origin fetches lose their token silently. One semantics for
 * all three (read the param, prefer the live global at call time) removes the
 * ordering contract rather than documenting it.
 *
 * Each script is its own IIFE, so the `var`/`function` names declared here are
 * local to whichever script interpolates them and cannot collide across scripts.
 */

/**
 * The install-once guard every script opens with. `flag` is the property on
 * `window` that records the install, e.g. `__yaarVerbInstalled`.
 */
export const installGuard = (flag: string): string => `
  if (window.${flag}) return;
  window.${flag} = true;
`;

/** The `window.yaar` namespace every SDK hangs its surface off. */
export const YAAR_NAMESPACE = `
  window.yaar = window.yaar || {};
`;

/**
 * Declares `API_BASE`, `API_ORIGIN` and `yaarToken()`.
 *
 * `API_BASE` is the backend the SDK talks to. App-origin isolation serves an app
 * from a sibling loopback origin, and `__yaar_api` carries the desktop origin so
 * the app's `/api` calls cross the boundary deliberately. Absent (bundled apps,
 * isolation off) it stays `''` and every call built on it is relative, as before.
 *
 * `yaarToken()` is read at call time, not at install time, so a token injected
 * after this script still reaches the requests this script makes.
 */
export const API_BOOTSTRAP = `
  var __yaarUrlToken = '';
  var API_BASE = '';
  var API_ORIGIN = '';
  try {
    var __yaarParams = new URLSearchParams(location.search);
    __yaarUrlToken = __yaarParams.get('__yaar_token') || '';
    // Back-fill the global for anything that reads it directly (app code, an
    // older compiled-in script). Never overwrite: an injected token is the
    // fresher of the two.
    if (__yaarUrlToken && !window.__YAAR_TOKEN__) window.__YAAR_TOKEN__ = __yaarUrlToken;
    var __yaarApi = __yaarParams.get('__yaar_api');
    if (__yaarApi && /^https?:\\/\\/[a-zA-Z0-9.:_-]+$/.test(__yaarApi)) {
      API_BASE = __yaarApi.replace(/\\/$/, '');
      try { API_ORIGIN = new URL(API_BASE).origin; } catch(e) {}
    }
  } catch(e) {}

  // Live, per call. The injected global wins; the URL param is the fallback for
  // a compiled app that boots before anything is injected.
  function yaarToken() {
    return window.__YAAR_TOKEN__ || __yaarUrlToken;
  }
`;

/**
 * Declares `tokenHeaders(extra)` — the optional `extra` bag is the base, so a
 * JSON caller passes its own `Content-Type` in. Requires {@link API_BOOTSTRAP}.
 */
export const TOKEN_HEADERS = `
  function tokenHeaders(extra) {
    var h = extra || {};
    var t = yaarToken();
    if (t) h['X-Iframe-Token'] = t;
    return h;
  }
`;

/**
 * Declares `responseFromProxyPayload(data)` — rebuilds a real `Response` from
 * the JSON envelope `/api/fetch` and `yaar://http` both answer with, decoding a
 * base64 body back to bytes.
 */
export const RESPONSE_FROM_PROXY = `
  function responseFromProxyPayload(data) {
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
  }
`;

/**
 * Declares `throwJsonError(res, fallback)` — reads the error envelope off a
 * failed REST response and rejects with its message, falling back to the status
 * text when the body is not JSON.
 */
export const JSON_ERROR_UNWRAP = `
  function throwJsonError(res, fallback) {
    return res.json().catch(function() {
      return { error: res.statusText };
    }).then(function(err) {
      throw new Error(err.error || fallback);
    });
  }
`;
