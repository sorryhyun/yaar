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
      // Notify parent that this app supports the protocol
      window.parent.postMessage({ type: 'yaar:app-ready', appId: config.appId }, '*');
    },
    sendInteraction: function(description) {
      var content, instructions;
      if (typeof description === 'string') {
        content = description;
      } else {
        instructions = description.instructions;
        var payload = {};
        for (var k in description) {
          if (k !== 'instructions') payload[k] = description[k];
        }
        content = JSON.stringify(payload);
      }
      window.parent.postMessage({
        type: 'yaar:app-interaction',
        content: content,
        instructions: instructions
      }, '*');
    }
  };

  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    var msg = e.data;
    var requestId = msg.requestId;

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
      if (!registration || !registration.state || !registration.state[msg.stateKey]) {
        window.parent.postMessage({
          type: 'yaar:app-query-response',
          requestId: requestId,
          data: null,
          error: 'Unknown state key: ' + msg.stateKey
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
          error: 'Unknown command: ' + msg.command
        }, '*');
        return;
      }
      try {
        var result = registration.commands[cmdName].handler(msg.params);
        // Handle async handlers
        if (result && typeof result.then === 'function') {
          result.then(function(data) {
            window.parent.postMessage({
              type: 'yaar:app-command-response',
              requestId: requestId,
              result: data
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
            result: result
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
