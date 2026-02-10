/**
 * App Protocol — self-describing JSON contract for agent ↔ iframe app communication.
 *
 * Apps register a manifest describing their capabilities (state keys, commands).
 * The agent discovers capabilities at runtime, then queries state or sends commands.
 *
 * Flow:
 *   Agent → MCP tool → ActionEmitter → WebSocket → Frontend → postMessage → Iframe App
 *   Iframe App → postMessage → Frontend → WebSocket → ActionEmitter resolves → MCP tool returns
 */

// ── File association types ──────────────────────────────────────────

/** Declares which file types an app can open and how to send content to it. */
export interface FileAssociation {
  extensions: string[];
  command: string;
  paramKey: string;
}

// ── Manifest types ──────────────────────────────────────────────────

export interface AppStateDescriptor {
  description: string;
  schema?: object;
}

export interface AppCommandDescriptor {
  description: string;
  params?: object;
  returns?: object;
}

export interface AppManifest {
  appId: string;
  name: string;
  state: Record<string, AppStateDescriptor>;
  commands: Record<string, AppCommandDescriptor>;
}

// ── PostMessage types (parent ↔ iframe) ─────────────────────────────

export interface AppManifestRequest {
  type: 'yaar:app-manifest-request';
  requestId: string;
}

export interface AppManifestResponse {
  type: 'yaar:app-manifest-response';
  requestId: string;
  manifest: AppManifest | null;
  error?: string;
}

export interface AppQueryRequest {
  type: 'yaar:app-query-request';
  requestId: string;
  stateKey: string;
}

export interface AppQueryResponse {
  type: 'yaar:app-query-response';
  requestId: string;
  data: unknown;
  error?: string;
}

export interface AppCommandRequest {
  type: 'yaar:app-command-request';
  requestId: string;
  command: string;
  params?: unknown;
}

export interface AppCommandResponse {
  type: 'yaar:app-command-response';
  requestId: string;
  result: unknown;
  error?: string;
}

export type AppProtocolPostMessage =
  | AppManifestRequest
  | AppManifestResponse
  | AppQueryRequest
  | AppQueryResponse
  | AppCommandRequest
  | AppCommandResponse;

// ── WebSocket event types (server ↔ client) ─────────────────────────

/** Server → Client: ask the iframe a question */
export type AppProtocolRequest =
  | { kind: 'manifest' }
  | { kind: 'query'; stateKey: string }
  | { kind: 'command'; command: string; params?: unknown };

/** Client → Server: iframe's answer */
export type AppProtocolResponse =
  | { kind: 'manifest'; manifest: AppManifest | null; error?: string }
  | { kind: 'query'; data: unknown; error?: string }
  | { kind: 'command'; result: unknown; error?: string };

// ── SDK script injected into iframes ────────────────────────────────

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

  window.yaar.app = {
    register: function(config) {
      registration = config;
      // Notify parent that this app supports the protocol
      window.parent.postMessage({ type: 'yaar:app-ready', appId: config.appId }, '*');
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
      if (!registration || !registration.commands || !registration.commands[msg.command]) {
        window.parent.postMessage({
          type: 'yaar:app-command-response',
          requestId: requestId,
          result: null,
          error: 'Unknown command: ' + msg.command
        }, '*');
        return;
      }
      try {
        var result = registration.commands[msg.command].handler(msg.params);
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
