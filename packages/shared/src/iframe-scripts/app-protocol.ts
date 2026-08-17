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
import { APP_MSG } from '../app-protocol.js';
import { installGuard, YAAR_NAMESPACE } from './prelude.js';

export const IFRAME_APP_PROTOCOL_SCRIPT = `
(function() {
  ${installGuard('__yaarAppProtocolInstalled')}
  ${YAAR_NAMESPACE}

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
      // Published on \`window\` because the link guard (iframe-scripts/windows-sdk.ts)
      // needs to know an app is running here — that is what separates an app from a
      // plain HTML document previewed in a window, which must keep browsing in place.
      // A cross-script boolean rather than a shared \`registration\`: the two scripts
      // are separate IIFEs with no module system between them.
      window.__yaarAppRegistered = true;
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
      var readyMsg = { type: '${APP_MSG.ready}', appId: config.appId };
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
        type: '${APP_MSG.interaction}',
        content: content,
        instructions: instructions,
        toMonitor: !!toMonitor
      }, '*');
    },
    emit: function(channel, payload, opts) {
      // Fire-and-forget event on a declared channel. Delivered only to agents
      // that subscribed to this channel; undeclared channels are dropped server-side.
      // \`wakeAgent\` additionally wakes this app's OWN agent — but only one that is
      // already running, so an event never conjures an agent nobody asked for.
      if (typeof channel !== 'string' || !channel) return;
      window.parent.postMessage({
        type: '${APP_MSG.event}',
        channel: channel,
        payload: payload,
        wakeAgent: !!(opts && opts.wakeAgent)
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

  /**
   * Values structured clone carries natively that a generic property copy would
   * wreck — a Date would come out \`{}\`, a typed array a bag of numeric keys. The
   * copy below hands these through untouched.
   */
  function isCloneBuiltin(v) {
    return (typeof Date !== 'undefined' && v instanceof Date) ||
      (typeof RegExp !== 'undefined' && v instanceof RegExp) ||
      (typeof ArrayBuffer !== 'undefined' && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) ||
      (typeof Blob !== 'undefined' && v instanceof Blob) ||
      (typeof File !== 'undefined' && v instanceof File) ||
      (typeof ImageData !== 'undefined' && v instanceof ImageData) ||
      (typeof Error !== 'undefined' && v instanceof Error);
  }

  var MAX_PLAIN_DEPTH = 64;

  /**
   * A structured-clone-safe deep copy of a reply payload.
   *
   * Reads every value through its own accessors, which is exactly what unwraps a
   * solid-js store: a value read off a store is a **Proxy**, and clone runs over
   * internal slots rather than proxy traps, so it refuses one no matter how plain
   * the data underneath is. Cycles and shared references survive via the seen
   * lists. Functions, symbols and DOM nodes cannot cross at all and are recorded
   * in \`dropped\` so the caller can say what went missing.
   */
  function plainifyPayload(payload) {
    var srcs = [], outs = [], dropped = [];
    function at(path, k) { return path ? path + '.' + k : String(k); }
    function walk(v, path, depth) {
      if (v === null) return null;
      var t = typeof v;
      if (t === 'function' || t === 'symbol') { dropped.push(path + ' (' + t + ')'); return undefined; }
      if (t !== 'object') return v;
      if (typeof Node !== 'undefined' && v instanceof Node) {
        dropped.push(path + ' (DOM ' + (v.nodeName || 'node') + ')');
        return undefined;
      }
      if (isCloneBuiltin(v)) return v;
      if (depth > MAX_PLAIN_DEPTH) {
        dropped.push(path + ' (nested deeper than ' + MAX_PLAIN_DEPTH + ' levels)');
        return undefined;
      }
      var seenAt = srcs.indexOf(v);
      if (seenAt !== -1) return outs[seenAt];
      var copy;
      if (Array.isArray(v)) {
        copy = [];
        srcs.push(v); outs.push(copy);
        for (var i = 0; i < v.length; i++) copy.push(walk(v[i], path + '[' + i + ']', depth + 1));
      } else if (typeof Map !== 'undefined' && v instanceof Map) {
        copy = new Map();
        srcs.push(v); outs.push(copy);
        v.forEach(function(val, key) {
          copy.set(walk(key, at(path, '<key>'), depth + 1), walk(val, at(path, String(key)), depth + 1));
        });
      } else if (typeof Set !== 'undefined' && v instanceof Set) {
        copy = new Set();
        srcs.push(v); outs.push(copy);
        v.forEach(function(val) { copy.add(walk(val, at(path, '<value>'), depth + 1)); });
      } else {
        copy = {};
        srcs.push(v); outs.push(copy);
        // Object.keys, not for..in: own enumerable keys are exactly what structured
        // clone copies, and a hostile proxy's ownKeys trap can throw — which has to
        // cost this one value, not the whole reply.
        var keys = null;
        try { keys = Object.keys(v); } catch (err) { dropped.push((path || '(reply)') + ' (keys unreadable)'); }
        for (var ki = 0; keys && ki < keys.length; ki++) {
          var k = keys[ki], got;
          try { got = v[k]; } catch (err) { dropped.push(at(path, k) + ' (getter threw)'); continue; }
          copy[k] = walk(got, at(path, k), depth + 1);
        }
      }
      return copy;
    }
    return { value: walk(payload, '', 0), dropped: dropped };
  }

  var MAX_REPORTED_PATHS = 5;

  /**
   * Narrow a clone failure to the exact fields that caused it.
   *
   * \`DataCloneError\` names nothing — "[object Object] could not be cloned" is the
   * whole message, with no field, key or path, and a Proxy, a Date-like class, a
   * function and a DOM node all fail identically. This probes with structuredClone
   * from the root down and prunes every subtree that clones cleanly, so the walk
   * costs about what the damage costs rather than what the payload costs, and it
   * only ever runs after postMessage has already thrown.
   */
  function uncloneablePaths(payload) {
    if (typeof structuredClone !== 'function') return [];
    var found = [], seen = [];
    function classify(v) {
      var t = typeof v;
      if (t === 'function' || t === 'symbol') return t;
      if (v && typeof Node !== 'undefined' && v instanceof Node) return 'DOM ' + (v.nodeName || 'node');
      if (v && t === 'object') {
        // Every part clones but the whole does not: the signature of a Proxy, which
        // is what reading a solid-js store gives you.
        return 'Proxy - a solid-js store value reads as one; unwrap() it or return a plain copy';
      }
      return t;
    }
    function probe(v, path, depth) {
      if (found.length >= MAX_REPORTED_PATHS) return;
      try { structuredClone(v); return; } catch (err) {}
      var before = found.length;
      var isNode = typeof Node !== 'undefined' && v instanceof Node;
      if (v && typeof v === 'object' && !isNode && depth < MAX_PLAIN_DEPTH && seen.indexOf(v) === -1) {
        seen.push(v);
        if (Array.isArray(v)) {
          for (var i = 0; i < v.length && found.length < MAX_REPORTED_PATHS; i++) {
            probe(v[i], path + '[' + i + ']', depth + 1);
          }
        } else {
          var keys = null;
          try { keys = Object.keys(v); } catch (err) {}
          for (var ki = 0; keys && ki < keys.length; ki++) {
            if (found.length >= MAX_REPORTED_PATHS) break;
            var k = keys[ki];
            var where = path ? path + '.' + k : k;
            var child;
            try { child = v[k]; } catch (err) { found.push(where + ' (getter threw)'); continue; }
            probe(child, where, depth + 1);
          }
        }
      }
      // Nothing inside it explained the failure, so the value itself is the answer.
      if (found.length === before) found.push((path || '(the whole reply)') + ' (' + classify(v) + ')');
    }
    probe(payload, '', 0);
    return found;
  }

  /**
   * Post one frame to the parent, recovering from a structured-clone refusal.
   *
   * Returning store state from a state getter or a command handler is the obvious
   * thing to write against the stack YAAR recommends, and it is always wrong — so
   * three bundled apps grew their own hand-maintained plain-copy helper for it.
   * That belongs here instead. The plainify is on the throw path rather than on
   * every reply: it costs nothing when the payload was already cloneable, and it
   * cannot downgrade the Dates, Maps and typed arrays that cross fine today.
   *
   * Returns null when the frame crossed, or a message naming what stopped it.
   */
  function postToParent(payload) {
    try {
      window.parent.postMessage(payload, '*');
      return null;
    } catch (err) {
      var plain;
      try {
        plain = plainifyPayload(payload);
        window.parent.postMessage(plain.value, '*');
      } catch (again) {
        var paths = uncloneablePaths(payload);
        return String(err) + (paths.length ? ' Offending value(s): ' + paths.join(', ') + '.' : '');
      }
      if (plain.dropped.length) {
        // The reply did cross, but lighter than the app wrote it. Silence here would
        // read as a handler bug in whatever consumes the missing field.
        try {
          console.warn('[yaar] app protocol reply carried values structured clone cannot transfer, ' +
            'so they were dropped: ' + plain.dropped.join(', '));
        } catch (_) {}
      }
      return null;
    }
  }

  // Every answer this SDK sends is the same frame — a type, the requestId it is
  // answering, and one payload — so it is written once here rather than at each
  // of the dozen return points below. Returns null on success, or the reason the
  // frame could not be sent.
  function reply(type, requestId, payload) {
    payload.type = type;
    payload.requestId = requestId;
    return postToParent(payload);
  }

  /**
   * Run \`produce\` and answer with whatever it does: return a value, return a
   * thenable, or throw. \`key\` is the field the value lands in ('data' for a
   * query, 'result' for a command); a failure sends that key as null plus an
   * \`error\` string, which is the shape the parent bridge reads.
   *
   * The try wraps the reply as well as the call, not just the call: a handler
   * returning something structured-clone cannot carry makes postMessage itself
   * throw, and that has to come back as an error rather than as silence the
   * parent can only wait out. \`postToParent\` recovers most of those by plainifying
   * (a solid-js store proxy is the common case); \`fail\` below answers the rest
   * with a message that names the field, which \`String(err)\` alone never did.
   */
  function settle(type, requestId, key, produce, mapValue) {
    function succeed(value) {
      var p = {};
      p[key] = mapValue ? mapValue(value) : value;
      var unsent = reply(type, requestId, p);
      if (unsent) fail(unsent);
    }
    function fail(err) {
      var p = {};
      p[key] = null;
      p.error = String(err);
      reply(type, requestId, p);
    }
    try {
      var out = produce();
      if (out && typeof out.then === 'function') out.then(succeed).catch(fail);
      else succeed(out);
    } catch (err) {
      fail(err);
    }
  }

  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    var msg = e.data;
    var requestId = msg.requestId;

    // Arbitrary expression evaluation. Reaching this handler at all means the server
    // already checked the window is a devtools preview (handleAppEval) — the iframe
    // cannot verify that itself, so the gate lives on the side that knows.
    if (msg.type === '${APP_MSG.evalRequest}') {
      // Not settle(): an eval failure sends \`error\` alone, with no null-valued
      // companion key, and its message is unwrapped from the Error rather than
      // stringified whole.
      var answerEval = function(payload) { reply('${APP_MSG.evalResponse}', requestId, payload); };
      var evalFailed = function(err) {
        answerEval({ error: String(err && err.message || err) });
      };
      try {
        // Indirect eval: runs in global scope, so the expression sees the app's
        // globals rather than this function's locals.
        var out = (0, eval)(msg.expression);
        if (out && typeof out.then === 'function') {
          out.then(function(v) { answerEval({ value: serializeEvalValue(v) }); }).catch(evalFailed);
        } else {
          answerEval({ value: serializeEvalValue(out) });
        }
      } catch (err) {
        evalFailed(err);
      }
      return;
    }

    if (msg.type === '${APP_MSG.close}') {
      if (registration && typeof registration.onClose === 'function') {
        try { registration.onClose(); } catch (_) {}
      }
      return;
    }

    if (msg.type === '${APP_MSG.manifestRequest}') {
      if (!registration) {
        reply('${APP_MSG.manifestResponse}', requestId, { manifest: null, error: 'No app registered' });
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
      if (registration.keybindings) manifest.keybindings = registration.keybindings;
      // The table every \`{"$ref": "#/$defs/x"}\` in the schemas below resolves against.
      // This builder copies field by field, so a manifest served without it would hand
      // agents schemas full of pointers into nothing.
      if (registration.$defs) manifest.$defs = registration.$defs;
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
      reply('${APP_MSG.manifestResponse}', requestId, { manifest: manifest });
      return;
    }

    if (msg.type === '${APP_MSG.queryRequest}') {
      // Reserved built-in state key: expose the console-capture buffer without
      // requiring the app to register. Lets tooling (e.g. devtools) read a preview
      // app's console output over the app protocol.
      if (msg.stateKey === '__console') {
        reply('${APP_MSG.queryResponse}', requestId, { data: window.__YAAR_CONSOLE || [] });
        return;
      }
      if (!registration || !registration.state || !registration.state[msg.stateKey]) {
        reply('${APP_MSG.queryResponse}', requestId, {
          data: null,
          error: memberError('state', msg.stateKey)
        });
        return;
      }
      settle('${APP_MSG.queryResponse}', requestId, 'data', function() {
        return registration.state[msg.stateKey].handler();
      });
      return;
    }

    if (msg.type === '${APP_MSG.commandRequest}') {
      var cmdName = msg.command;
      // Resolve alias to canonical command name
      if (aliasMap[cmdName]) cmdName = aliasMap[cmdName];
      if (!registration || !registration.commands || !registration.commands[cmdName]) {
        reply('${APP_MSG.commandResponse}', requestId, {
          result: null,
          error: memberError('command', msg.command)
        });
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
        reply('${APP_MSG.commandResponse}', requestId, { result: null, error: badParams });
        return;
      }
      // A command that acts but returns nothing is normal (play, stop, ...). Send
      // null rather than undefined: postMessage drops undefined-valued keys, and the
      // parent bridge reads a response carrying neither result nor error as malformed.
      var asResult = function(data) { return data === undefined ? null : data; };
      settle('${APP_MSG.commandResponse}', requestId, 'result', function() {
        // The handler's second argument is context, not another param: a command replayed
        // at a remounted iframe is indistinguishable from a fresh call otherwise, and a
        // handler that wants replay-aware behavior instead of a blanket replay: 'never'
        // has no way to tell them apart.
        return registration.commands[cmdName].handler(cmdParams, { replayed: !!msg.replayed });
      }, asResult);
      return;
    }

    // Per-key describe. Answers with the app's computed doc for one state key or
    // command, or \`null\` when the app defines no describe() for it — the server then
    // falls back to the manifest's static description, which is a real answer rather
    // than a missing one. Only a key that does not exist is an error.
    if (msg.type === '${APP_MSG.describeRequest}') {
      var table = registration && (msg.target === 'state' ? registration.state : registration.commands);
      var describeKey = msg.key;
      if (msg.target === 'commands' && aliasMap[describeKey]) describeKey = aliasMap[describeKey];
      if (!table || !table[describeKey]) {
        reply('${APP_MSG.describeResponse}', requestId, {
          doc: null,
          error: memberError(msg.target === 'state' ? 'state' : 'command', msg.key)
        });
        return;
      }
      var entry = table[describeKey];
      if (typeof entry.describe !== 'function') {
        reply('${APP_MSG.describeResponse}', requestId, { doc: null });
        return;
      }
      settle('${APP_MSG.describeResponse}', requestId, 'doc', function() {
        return entry.describe();
      }, function(v) { return v == null ? null : String(v); });
      return;
    }
  });

})();
`;
