/**
 * Inline JS backing an app's protocol surface in its iframe.
 *
 * Registration is internal: `defineApp()` is the only caller, through
 * `window.yaar.app.__registerApp()`. The SDK listens for postMessage requests
 * from the parent and dispatches to the registered handlers. On registration it
 * sends `yaar:app-ready` so the parent knows the app supports the protocol.
 *
 * `app.register()` used to be the public way in, and an app could call it from
 * anywhere — including a component body that remounts. That is gone: the double
 * underscore is the contract, and the public name survives only to throw a
 * message naming `defineApp` rather than a bare "not a function".
 */
export const IFRAME_APP_PROTOCOL_SCRIPT = `
(function() {
  if (window.__yaarAppProtocolInstalled) return;
  window.__yaarAppProtocolInstalled = true;

  window.yaar = window.yaar || {};

  var registration = null;
  var aliasMap = {};  // alias → canonical command name

  // Validate the registration shape up front and throw naming the exact missing field.
  // Without this, a missing appId/name/description silently becomes \`undefined\` in the
  // manifest, and a missing handler throws a bare "handler is not a function" only when
  // the state key or command is later invoked — an error that names neither the app nor
  // the field. The authoring types require these fields; this makes the runtime agree.
  //
  // \`defineApp\` builds this shape, so a failure here is a defect in the definition the
  // app handed it — the field names below are the registration's, and defineApp's
  // \`state\`/\`commands\` keys map onto them one-for-one.
  function validateRegistration(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('[yaar] defineApp(): registration must be an object { appId, name, state, commands }.');
    }
    var problems = [];
    if (typeof config.appId !== 'string' || !config.appId) {
      problems.push('missing required field "appId" (a stable string id for this app)');
    }
    if (typeof config.name !== 'string' || !config.name) {
      problems.push('missing required field "name" (the human-readable app name)');
    }
    function checkDescriptors(bag, kind, needsHandler) {
      if (bag == null) return;
      if (typeof bag !== 'object') {
        problems.push('"' + kind + '" must be an object mapping names to descriptors');
        return;
      }
      for (var key in bag) {
        if (!Object.prototype.hasOwnProperty.call(bag, key)) continue;
        var d = bag[key];
        var at = kind + '["' + key + '"]';
        if (!d || typeof d !== 'object') {
          problems.push(at + ' must be a descriptor object' + (needsHandler ? ' { description, handler }' : ' { description }'));
          continue;
        }
        if (typeof d.description !== 'string' || !d.description) {
          problems.push(at + ' is missing required field "description"');
        }
        if (needsHandler && typeof d.handler !== 'function') {
          problems.push(at + ' is missing required field "handler" (a function' + (kind === 'state' ? ' returning the state value)' : ' handling the command)'));
        }
      }
    }
    checkDescriptors(config.state, 'state', true);
    checkDescriptors(config.commands, 'commands', true);
    checkDescriptors(config.events, 'events', false);
    if (problems.length) {
      var who = (typeof config.appId === 'string' && config.appId) ? ' for app "' + config.appId + '"' : '';
      throw new Error('[yaar] defineApp()' + who + ' is invalid:\\n  - ' + problems.join('\\n  - '));
    }
  }

  window.yaar.app = {
    // The public name, kept only to explain itself. An app reaching for it is either
    // pre-defineApp source or a copied snippet; either way the useful answer names the
    // replacement, which a missing property cannot do.
    register: function() {
      throw new Error('[yaar] app.register() has been removed. Register with \`export default defineApp({ id, name, state, commands, view })\` from "@bundled/yaar" instead - it registers before it mounts and is the shape the build reads.');
    },
    // defineApp's private call path. It owns registration timing outright: exactly one
    // call, at module scope, before the view mounts. That is why a second registration is
    // an unconditional error here — it can no longer be a component-body remount re-running
    // register(), only two apps (or two defineApp calls) fighting over one iframe, and
    // picking a silent winner would leave protocol.json describing an app the iframe no
    // longer runs.
    __registerApp: function(config) {
      validateRegistration(config);
      if (registration) {
        throw new Error('[yaar] defineApp(): "' + registration.appId + '" is already registered in this window; "' + config.appId + '" cannot also register here. A window may host exactly one app, and defineApp() must be called exactly once at module scope.');
      }
      registration = config;
      // Build alias lookup map, and collect the commands this registration opts out of
      // replay for (see AppCommandDescriptor.replay). The list rides this handshake
      // instead of being read from dist/protocol.json on the server: this is the
      // registration actually running in the iframe right now, and a manifest on disk
      // (stale build, a devtools preview of edited-but-uncompiled source) can disagree
      // with it. Reading from disk would let the server replay a command this running
      // app never declared replayable, silently.
      aliasMap = {};
      var noReplay = [];
      if (config.commands) {
        for (var name in config.commands) {
          var cmd = config.commands[name];
          if (cmd.aliases) {
            for (var i = 0; i < cmd.aliases.length; i++) {
              aliasMap[cmd.aliases[i]] = name;
            }
          }
          // Every spelling, not just the canonical name. The server records a command
          // request under whatever name the agent called it by, and it has no alias table
          // to canonicalize with — the alias map never leaves this iframe. Sending only
          // the canonical name would let \`command("newMemo")\` replay an addMemo that
          // \`command("addMemo")\` correctly skips, which is the exact double-apply the
          // policy exists to prevent.
          if (cmd.replay === 'never') {
            noReplay.push(name);
            if (cmd.aliases) {
              for (var a = 0; a < cmd.aliases.length; a++) noReplay.push(cmd.aliases[a]);
            }
          }
        }
      }
      // Custom capture: the capture helper checks this provider before taking
      // its default window screenshot (see iframe-scripts/capture.ts).
      if (typeof config.onCapture === 'function') {
        window.__yaarCaptureProvider = config.onCapture;
      }
      // Notify parent that this app supports the protocol. noReplay is omitted rather
      // than sent empty so today's frames stay byte-identical for apps that opt nothing out.
      var readyMsg = { type: 'yaar:app-ready', appId: config.appId };
      if (noReplay.length) readyMsg.noReplay = noReplay;
      window.parent.postMessage(readyMsg, '*');
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

  // A command's \`params\` JSON Schema is what the agent is shown in the manifest, but
  // nothing checked a call against it: an undeclared key was dropped in silence and a
  // missing required one arrived as undefined. The handler then failed somewhere
  // downstream with a message about its own logic — copyFile called with
  // {source, destination} read from/to as undefined and reported "Source and
  // destination are the same path", which names neither the wrong key nor the right
  // one. Name the actual mistake here, where the schema is.
  function paramsError(cmdName, descriptor, params) {
    var schema = descriptor && descriptor.params;
    if (!schema || typeof schema !== 'object') return null;
    var props = schema.properties;
    if (!props || typeof props !== 'object') return null;
    var owns = function(bag, k) { return Object.prototype.hasOwnProperty.call(bag, k); };

    // A string or array would enumerate as indices below and report "unknown param: 0, 1, 2".
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return cmdName + ': params must be an object, received ' +
        (Array.isArray(params) ? 'an array' : typeof params) + '.';
    }

    var missing = [];
    var required = Array.isArray(schema.required) ? schema.required : [];
    for (var i = 0; i < required.length; i++) {
      if (params[required[i]] === undefined) missing.push(required[i]);
    }

    // additionalProperties: true is the explicit opt-out, for a command that forwards
    // a free-form bag on to another layer.
    var unknown = [];
    if (schema.additionalProperties !== true) {
      for (var k in params) {
        if (owns(params, k) && !owns(props, k)) unknown.push(k);
      }
    }

    if (!missing.length && !unknown.length) return null;

    var parts = [];
    if (missing.length) parts.push('missing required param: ' + missing.join(', '));
    if (unknown.length) parts.push('unknown param: ' + unknown.join(', '));
    var accepted = memberNames(props);
    return cmdName + ': ' + parts.join('; ') + '. Accepted params: ' +
      (accepted.length ? accepted.join(', ') : '(none)') +
      (required.length ? ' (required: ' + required.join(', ') + ')' : '') + '.';
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
          if (c.replay) manifest.commands[key].replay = c.replay;
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
      // requiring the app to register. Lets tooling (e.g. devtools) read a preview
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
      // A command whose params are all optional is normally called with none at all, and
      // postMessage then delivers no params at all. Handed straight to the handler, the
      // first property read threw "Cannot read properties of undefined" — an error naming
      // neither the command nor the app, so it reads like a bug in the app's own code.
      // No params is an empty bag of params.
      var cmdParams = msg.params || {};
      var badParams = paramsError(cmdName, registration.commands[cmdName], cmdParams);
      if (badParams) {
        window.parent.postMessage({
          type: 'yaar:app-command-response',
          requestId: requestId,
          result: null,
          error: badParams
        }, '*');
        return;
      }
      try {
        // The handler's second argument is context, not another param: a command replayed
        // at a remounted iframe is indistinguishable from a fresh call otherwise, and a
        // handler that wants replay-aware behavior instead of a blanket replay: 'never'
        // has no way to tell them apart.
        var result = registration.commands[cmdName].handler(cmdParams, { replayed: !!msg.replayed });
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
