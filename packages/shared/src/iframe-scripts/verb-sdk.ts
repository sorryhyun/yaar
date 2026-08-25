/**
 * Inline JS verb SDK for iframe apps.
 *
 * Provides window.yaar verb methods (invoke, read, list, describe, delete)
 * that dispatch to POST /api/verb with the iframe token header.
 * Uses the same yaar:// URI pattern the agent uses via MCP.
 */
import { APP_MSG } from '../app-protocol.js';
import {
  API_BOOTSTRAP,
  installGuard,
  RESPONSE_FROM_PROXY,
  TOKEN_HEADERS,
  YAAR_NAMESPACE,
} from './prelude.js';

export const IFRAME_VERB_SDK_SCRIPT = `
(function() {
  ${installGuard('__yaarVerbInstalled')}
  ${YAAR_NAMESPACE}
  ${API_BOOTSTRAP}
  ${TOKEN_HEADERS}
  ${RESPONSE_FROM_PROXY}

  function jsonHeaders() {
    return tokenHeaders({ 'Content-Type': 'application/json' });
  }

  // An app's iframe boots on its own clock: it can fire session-scoped verbs before
  // the desktop's WebSocket has registered the session (first load after a server
  // start), or after the session was evicted while the socket was down. The server
  // answers those with a retryable 503, and the session reappears under the same id
  // the moment the frontend (re)connects — so wait and try again instead of handing
  // the app an error it would render as "empty".
  //
  // Keep this short: the server already parks a session-scoped verb until the session
  // shows up, and only 503s once that wait times out. Each retry therefore pays that
  // full wait again, so a long ladder here multiplies into tens of seconds of hanging
  // whenever the session is gone for good (desktop socket closed, session evicted).
  // Two attempts cover a reconnect still in flight (the frontend retries every 3s).
  var RETRY_DELAYS_MS = [1000, 3000];

  function callVerb(verb, uri, payload, attempt) {
    var body = { verb: verb, uri: uri };
    if (payload !== undefined) body.payload = payload;
    attempt = attempt || 0;
    return fetch(API_BASE + '/api/verb', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body)
    }).then(function(res) {
      return res.json().then(function(envelope) {
        if (res.status === 503 && envelope.retryable && attempt < RETRY_DELAYS_MS.length) {
          return new Promise(function(resolve) {
            setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
          }).then(function() {
            return callVerb(verb, uri, payload, attempt + 1);
          });
        }
        if (!res.ok) throw new Error(envelope.error || 'Verb call failed');
        if (!envelope.ok) throw new Error(envelope.error || 'Verb error');
        if (envelope.images) return { data: envelope.data, images: envelope.images };
        return envelope.data;
      });
    });
  }

  window.yaar.invoke = function(uri, payload) { return callVerb('invoke', uri, payload); };
  // \`read\` takes options — the same 4th argument an MCP caller has always had
  // (\`lines\`, \`pattern\`, \`pdfText\`, …) plus \`missingOk\`, which answers an absent
  // file with null instead of an error. Dropping the argument here is what forced
  // \`appStorage.readJsonOr\` to declare "absence is fine" only to itself, above a
  // failure the session had already recorded.
  window.yaar.read = function(uri, options) { return callVerb('read', uri, options); };
  window.yaar.list = function(uri) { return callVerb('list', uri); };
  window.yaar.describe = function(uri) { return callVerb('describe', uri); };
  window.yaar.delete = function(uri) { return callVerb('delete', uri); };

  // ── Reactive subscriptions ──
  var __yaarSubs = {};

  window.addEventListener('message', function(e) {
    if (!e.data) return;
    // Change ping: callback gets the URI string, app re-reads the resource.
    if (e.data.type === '${APP_MSG.subscriptionUpdate}') {
      var id = e.data.subscriptionId;
      if (__yaarSubs[id]) {
        try { __yaarSubs[id](e.data.uri); } catch(err) {}
      }
      return;
    }
    // Stream frame: callback gets the whole frame ({ uri, seq, kind, data, ts }).
    if (e.data.type === '${APP_MSG.streamFrame}') {
      var sid = e.data.subscriptionId;
      if (__yaarSubs[sid]) {
        try { __yaarSubs[sid](e.data.frame); } catch(err) {}
      }
      return;
    }
  });

  // Register a subscription and route its server-assigned id to a callback.
  // \`body\` carries the mode ('change' for subscribe, 'stream' for stream).
  function openSubscription(uri, callback, body) {
    body.uri = uri;
    body.action = 'subscribe';
    return fetch(API_BASE + '/api/verb/subscribe', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body)
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) throw new Error(data.error);
      var serverId = data.subscriptionId;
      __yaarSubs[serverId] = callback;
      return function unsubscribe() {
        delete __yaarSubs[serverId];
        return fetch(API_BASE + '/api/verb/subscribe', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ action: 'unsubscribe', subscriptionId: serverId })
        }).then(function() {});
      };
    });
  }

  window.yaar.subscribe = function(uri, callback) {
    return openSubscription(uri, callback, { mode: 'change' });
  };

  // Stream a URI: same endpoint and unsubscriber shape as subscribe(), but the
  // server pushes typed frames with payloads instead of bare change pings.
  // opts.kinds narrows delivery to the listed frame kinds.
  window.yaar.stream = function(uri, onFrame, opts) {
    var body = { mode: 'stream' };
    if (opts && Array.isArray(opts.kinds)) body.kinds = opts.kinds;
    return openSubscription(uri, onFrame, body);
  };

  window.yaar.fetch = function(url, options) {
    var payload = { url: url };
    if (options) {
      if (options.method) payload.method = options.method;
      if (options.headers) payload.headers = options.headers;
      if (options.body) payload.body = options.body;
    }
    return window.yaar.invoke('yaar://http', payload).then(function(data) {
      if (typeof data === 'string') data = JSON.parse(data);
      return responseFromProxyPayload(data);
    });
  };
})();
`;
