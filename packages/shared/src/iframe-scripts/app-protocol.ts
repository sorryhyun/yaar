/**
 * Inline JS that provides `window.yaar.app.register()`.
 *
 * Apps call register() with state handlers and command handlers.
 * The SDK listens for postMessage requests from the parent and dispatches
 * to registered handlers. On registration it sends `yaar:app-ready` so
 * the parent knows the app supports the protocol.
 */
export const IFRAME_APP_PROTOCOL_SCRIPT = `
(function() {
  if (window.__yaarAppProtocolInstalled) return;
  window.__yaarAppProtocolInstalled = true;

  window.yaar = window.yaar || {};

  var registration = null;
  var aliasMap = {};  // alias → canonical command name

  window.yaar.app = {
    register: function(config) {
      registration = config;
      // Build alias lookup map
      aliasMap = {};
      if (config.commands) {
        for (var name in config.commands) {
          var cmd = config.commands[name];
          if (cmd.aliases) {
            for (var i = 0; i < cmd.aliases.length; i++) {
              aliasMap[cmd.aliases[i]] = name;
            }
          }
        }
      }
      // Custom capture: the capture helper checks this provider before taking
      // its default window screenshot (see iframe-scripts/capture.ts).
      if (typeof config.onCapture === 'function') {
        window.__yaarCaptureProvider = config.onCapture;
      }
      // Notify parent that this app supports the protocol
      window.parent.postMessage({ type: 'yaar:app-ready', appId: config.appId }, '*');
    },
    sendInteraction: function(description) {
      var content, instructions, toMonitor;
      if (typeof description === 'string') {
        content = description;
      } else {
        instructions = description.instructions;
        toMonitor = description.toMonitor;
        var payload = {};
        for (var k in description) {
          if (k !== 'instructions' && k !== 'toMonitor') payload[k] = description[k];
        }
        content = JSON.stringify(payload);
      }
      window.parent.postMessage({
        type: 'yaar:app-interaction',
        content: content,
        instructions: instructions,
        toMonitor: !!toMonitor
      }, '*');
    },
    emit: function(channel, payload) {
      // Fire-and-forget event on a declared channel. Delivered only to agents
      // that subscribed to this channel; undeclared channels are dropped server-side.
      if (typeof channel !== 'string' || !channel) return;
      window.parent.postMessage({
        type: 'yaar:app-event',
        channel: channel,
        payload: payload
      }, '*');
    }
  };

  // State and commands are separate lookups, so a name used against the wrong one
  // fails with a bare "Unknown command: consoleLogs" that says nothing about where
  // the name actually lives. An agent reading that concludes the app is broken, or
  // guesses another name. Point at the right verb instead, and otherwise list what
  // this app does register so the next call can be right.
  function memberNames(bag) {
    var out = [];
    if (bag) { for (var k in bag) out.push(k); }
    return out.sort();
  }

  var MAX_LISTED_NAMES = 40;

  function memberError(kind, name) {
    var isCmd = kind === 'command';
    var label = isCmd ? 'Unknown command: ' + name : 'Unknown state key: ' + name;
    if (!registration) return label + '. No app is registered in this window.';
    var otherBag = isCmd ? registration.state : registration.commands;
    var otherName = name;
    if (!isCmd && aliasMap[name]) otherName = aliasMap[name];
    if (otherBag && otherBag[otherName]) {
      return isCmd
        ? label + '. "' + name + '" is a state key, not a command - read it with query("' + name + '").'
        : label + '. "' + name + '" is a command, not a state key - run it with command("' + name + '").';
    }
    var own = memberNames(isCmd ? registration.commands : registration.state);
    var noun = isCmd ? 'commands' : 'state keys';
    if (!own.length) return label + '. This app registers no ' + noun + '.';
    var shown = own.slice(0, MAX_LISTED_NAMES).join(', ');
    if (own.length > MAX_LISTED_NAMES) shown += ', ... (' + own.length + ' total)';
    return label + '. Available ' + noun + ': ' + shown;
  }

  // Max serialized eval result, in characters. A result bigger than this is almost
  // always an accident (returning \`document\` or a whole store), and shipping it
  // through the agent's context costs far more than it explains.
  var MAX_EVAL_CHARS = 16384;

  /**
   * Serialize an eval result to a string the agent can read.
   *
   * Structured-clone cannot carry DOM nodes or functions, so serialize here rather
   * than postMessage-ing the raw value — a returned element would otherwise fail the
   * clone and surface as an opaque bridge error instead of an answer.
   */
  function serializeEvalValue(value) {
    var text;
    try {
      if (value === undefined) text = 'undefined';
      else if (typeof value === 'function') text = String(value);
      else if (typeof Node !== 'undefined' && value instanceof Node) text = String(value.outerHTML || value.nodeName);
      else text = JSON.stringify(value, null, 2);
      // JSON.stringify returns undefined for symbols and the like.
      if (text === undefined) text = String(value);
    } catch (err) {
      // Circular structures and getters that throw land here.
      try { text = String(value); } catch (_) { text = '[unserializable value]'; }
    }
    if (text.length > MAX_EVAL_CHARS) {
      text = text.slice(0, MAX_EVAL_CHARS) +
        '\\n... [truncated: ' + text.length + ' chars total, ' + MAX_EVAL_CHARS + ' shown]';
    }
    return text;
  }

  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    var msg = e.data;
    var requestId = msg.requestId;

    // Arbitrary expression evaluation. Reaching this handler at all means the server
    // already checked the window is a devtools preview (handleAppEval) — the iframe
    // cannot verify that itself, so the gate lives on the side that knows.
    if (msg.type === 'yaar:app-eval-request') {
      var reply = function(payload) {
        payload.type = 'yaar:app-eval-response';
        payload.requestId = requestId;
        window.parent.postMessage(payload, '*');
      };
      try {
        // Indirect eval: runs in global scope, so the expression sees the app's
        // globals rather than this function's locals.
        var out = (0, eval)(msg.expression);
        if (out && typeof out.then === 'function') {
          out.then(function(v) { reply({ value: serializeEvalValue(v) }); })
             .catch(function(err) { reply({ error: String(err && err.message || err) }); });
        } else {
          reply({ value: serializeEvalValue(out) });
        }
      } catch (err) {
        reply({ error: String(err && err.message || err) });
      }
      return;
    }

    if (msg.type === 'yaar:app-close') {
      if (registration && typeof registration.onClose === 'function') {
        try { registration.onClose(); } catch (_) {}
      }
      return;
    }

    if (msg.type === 'yaar:app-manifest-request') {
      if (!registration) {
        window.parent.postMessage({
          type: 'yaar:app-manifest-response',
          requestId: requestId,
          manifest: null,
          error: 'No app registered'
        }, '*');
        return;
      }
      // Build manifest: strip handlers, expose only descriptions + schemas
      var manifest = {
        appId: registration.appId,
        name: registration.name,
        state: {},
        commands: {}
      };
      if (registration.events) {
        manifest.events = {};
        for (var evKey in registration.events) {
          manifest.events[evKey] = { description: registration.events[evKey].description };
        }
      }
      if (registration.state) {
        for (var key in registration.state) {
          var s = registration.state[key];
          manifest.state[key] = { description: s.description };
          if (s.schema) manifest.state[key].schema = s.schema;
        }
      }
      if (registration.commands) {
        for (var key in registration.commands) {
          var c = registration.commands[key];
          manifest.commands[key] = { description: c.description };
          if (c.aliases) manifest.commands[key].aliases = c.aliases;
          if (c.params) manifest.commands[key].params = c.params;
          if (c.returns) manifest.commands[key].returns = c.returns;
        }
      }
      window.parent.postMessage({
        type: 'yaar:app-manifest-response',
        requestId: requestId,
        manifest: manifest
      }, '*');
      return;
    }

    if (msg.type === 'yaar:app-query-request') {
      // Reserved built-in state key: expose the console-capture buffer without
      // requiring app.register(). Lets tooling (e.g. devtools) read a preview
      // app's console output over the app protocol.
      if (msg.stateKey === '__console') {
        window.parent.postMessage({
          type: 'yaar:app-query-response',
          requestId: requestId,
          data: window.__YAAR_CONSOLE || []
        }, '*');
        return;
      }
      if (!registration || !registration.state || !registration.state[msg.stateKey]) {
        window.parent.postMessage({
          type: 'yaar:app-query-response',
          requestId: requestId,
          data: null,
          error: memberError('state', msg.stateKey)
        }, '*');
        return;
      }
      try {
        var result = registration.state[msg.stateKey].handler();
        // Handle async handlers
        if (result && typeof result.then === 'function') {
          result.then(function(data) {
            window.parent.postMessage({
              type: 'yaar:app-query-response',
              requestId: requestId,
              data: data
            }, '*');
          }).catch(function(err) {
            window.parent.postMessage({
              type: 'yaar:app-query-response',
              requestId: requestId,
              data: null,
              error: String(err)
            }, '*');
          });
        } else {
          window.parent.postMessage({
            type: 'yaar:app-query-response',
            requestId: requestId,
            data: result
          }, '*');
        }
      } catch (err) {
        window.parent.postMessage({
          type: 'yaar:app-query-response',
          requestId: requestId,
          data: null,
          error: String(err)
        }, '*');
      }
      return;
    }

    if (msg.type === 'yaar:app-command-request') {
      var cmdName = msg.command;
      // Resolve alias to canonical command name
      if (aliasMap[cmdName]) cmdName = aliasMap[cmdName];
      if (!registration || !registration.commands || !registration.commands[cmdName]) {
        window.parent.postMessage({
          type: 'yaar:app-command-response',
          requestId: requestId,
          result: null,
          error: memberError('command', msg.command)
        }, '*');
        return;
      }
      try {
        // A command whose params are all optional is normally called with none at all, and
        // postMessage then delivers no params at all. Handed straight to the handler, the
        // first property read threw "Cannot read properties of undefined" — an error naming
        // neither the command nor the app, so it reads like a bug in the app's own code.
        // No params is an empty bag of params.
        var result = registration.commands[cmdName].handler(msg.params || {});
        // A command that acts but returns nothing is normal (play, stop, ...). Send
        // null rather than undefined: postMessage drops undefined-valued keys, and the
        // parent bridge reads a response carrying neither result nor error as malformed.
        var asResult = function(data) { return data === undefined ? null : data; };
        // Handle async handlers
        if (result && typeof result.then === 'function') {
          result.then(function(data) {
            window.parent.postMessage({
              type: 'yaar:app-command-response',
              requestId: requestId,
              result: asResult(data)
            }, '*');
          }).catch(function(err) {
            window.parent.postMessage({
              type: 'yaar:app-command-response',
              requestId: requestId,
              result: null,
              error: String(err)
            }, '*');
          });
        } else {
          window.parent.postMessage({
            type: 'yaar:app-command-response',
            requestId: requestId,
            result: asResult(result)
          }, '*');
        }
      } catch (err) {
        window.parent.postMessage({
          type: 'yaar:app-command-response',
          requestId: requestId,
          result: null,
          error: String(err)
        }, '*');
      }
      return;
    }
  });
})();
`;
