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
