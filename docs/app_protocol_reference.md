# App Protocol Reference

The App Protocol enables bidirectional communication between AI agents and iframe-based apps. Apps register a self-describing manifest of their capabilities (state keys and commands), and agents discover and interact with them at runtime.

**Source:** `packages/shared/src/app-protocol.ts`

---

## Overview

```
Agent calls MCP tool (app_query / app_command)
  → ActionEmitter → WebSocket → Frontend
  → postMessage → Iframe App
  → postMessage response → Frontend
  → WebSocket → ActionEmitter resolves
  → MCP tool returns result to agent
```

An app opts in by setting `"appProtocol": true` in its `app.json` and calling `window.yaar.app.register()` inside the iframe.

---

## MCP Tools

**Source:** `packages/server/src/mcp/window/app-protocol.ts`

### `app_query`

Read state from an iframe app or discover its capabilities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `windowId` | `string` | yes | Window containing the iframe app |
| `stateKey` | `string` | yes | State key to read. Use `"manifest"` to discover all keys and commands. |

**Behavior:**
1. Validates the window exists and uses the `iframe` renderer.
2. Waits up to 5 s for the app to send `yaar:app-ready` (skipped if already registered).
3. Sends the request through the protocol pipeline.
4. Returns the JSON response or an error string.

**Returns (manifest):** JSON-stringified `AppManifest` describing available state keys and commands.
**Returns (state key):** JSON-stringified value from the app's state handler.

### `app_command`

Execute a command on an iframe app.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `windowId` | `string` | yes | Window containing the iframe app |
| `command` | `string` | yes | Command name (e.g., `"setCells"`, `"addItem"`) |
| `params` | `Record<string, unknown>` | no | Parameters as described in the manifest |

**Behavior:**
1. Same validation and readiness check as `app_query`.
2. Sends the command through the protocol pipeline.
3. Records the command via `WindowStateRegistry.recordAppCommand()` for replay on reload.
4. Returns the JSON result or an error string.

---

## Manifest

An `AppManifest` describes what the app can do. The agent retrieves it by calling `app_query(windowId, "manifest")`.

```typescript
interface AppManifest {
  appId: string;
  name: string;
  state: Record<string, AppStateDescriptor>;
  commands: Record<string, AppCommandDescriptor>;
}

interface AppStateDescriptor {
  description: string;
  schema?: object;        // JSON Schema (optional)
}

interface AppCommandDescriptor {
  description: string;
  params?: object;        // JSON Schema for parameters (optional)
  returns?: object;       // JSON Schema for return value (optional)
}
```

The manifest is built automatically from the registration config by stripping handler functions and exposing only descriptions and schemas.

---

## PostMessage Protocol

These messages are exchanged between the frontend (parent window) and the iframe app via `postMessage()`.

### Manifest

**Request** (parent → iframe):
```json
{ "type": "yaar:app-manifest-request", "requestId": "req-..." }
```

**Response** (iframe → parent):
```json
{
  "type": "yaar:app-manifest-response",
  "requestId": "req-...",
  "manifest": { "appId": "...", "name": "...", "state": {}, "commands": {} },
  "error": null
}
```

### Query

**Request** (parent → iframe):
```json
{ "type": "yaar:app-query-request", "requestId": "req-...", "stateKey": "items" }
```

**Response** (iframe → parent):
```json
{ "type": "yaar:app-query-response", "requestId": "req-...", "data": [...], "error": null }
```

### Command

**Request** (parent → iframe):
```json
{
  "type": "yaar:app-command-request",
  "requestId": "req-...",
  "command": "addItem",
  "params": { "text": "Hello" }
}
```

**Response** (iframe → parent):
```json
{ "type": "yaar:app-command-response", "requestId": "req-...", "result": { "ok": true }, "error": null }
```

---

## WebSocket Events

### Server → Client: `APP_PROTOCOL_REQUEST`

```typescript
{
  type: 'APP_PROTOCOL_REQUEST';
  requestId: string;
  windowId: string;
  request:
    | { kind: 'manifest' }
    | { kind: 'query'; stateKey: string }
    | { kind: 'command'; command: string; params?: unknown };
  seq?: number;
}
```

### Client → Server: `APP_PROTOCOL_RESPONSE`

```typescript
{
  type: 'APP_PROTOCOL_RESPONSE';
  requestId: string;
  windowId: string;
  response:
    | { kind: 'manifest'; manifest: AppManifest | null; error?: string }
    | { kind: 'query'; data: unknown; error?: string }
    | { kind: 'command'; result: unknown; error?: string };
}
```

### Client → Server: `APP_PROTOCOL_READY`

Sent when an iframe app calls `window.yaar.app.register()`.

```typescript
{
  type: 'APP_PROTOCOL_READY';
  windowId: string;
}
```

---

## Iframe SDK

The SDK script (`IFRAME_APP_PROTOCOL_SCRIPT` in `packages/shared/src/app-protocol.ts`) is automatically injected into every iframe's `<head>` by the `IframeRenderer` component. It provides `window.yaar.app`.

### `window.yaar.app.register(config)`

Register the app with the protocol. Must be called once.

```javascript
window.yaar.app.register({
  appId: 'my-app',
  name: 'My App',

  state: {
    items: {
      description: 'Current list of items',
      schema: { type: 'array', items: { type: 'object' } },  // optional
      handler: async () => {
        return items;   // return current state
      },
    },
  },

  commands: {
    addItem: {
      description: 'Add a new item',
      params: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (params) => {
        items.push({ text: params.text });
        render();
        return { ok: true };
      },
    },
  },
});
```

On registration the SDK sends `{ type: 'yaar:app-ready', appId }` to the parent so the server knows the app supports the protocol.

### `window.yaar.app.sendInteraction(description)`

Send a free-form interaction message from the app to the AI agent. Useful for notifying the agent about user actions inside the iframe.

```javascript
window.yaar.app.sendInteraction('User clicked the save button');
```

This posts a `{ type: 'yaar:app-interaction', content: "..." }` message to the parent, which routes it to the window's agent.

---

## File Associations

Apps can declare file types they can open in `app.json`:

```json
{
  "appProtocol": true,
  "fileAssociations": [
    { "extensions": [".csv", ".xlsx"], "command": "openFile", "paramKey": "content" }
  ]
}
```

```typescript
interface FileAssociation {
  extensions: string[];   // File extensions (e.g. [".pdf", ".txt"])
  command: string;        // App protocol command to invoke
  paramKey: string;       // Parameter key for the file content
}
```

When a user opens a file with a matching extension, the agent sends an `app_command` with the specified `command` and the file content in the `paramKey` parameter.

---

## Server-Side Internals

### ActionEmitter

**Source:** `packages/server/src/mcp/action-emitter.ts`

| Method | Description |
|--------|-------------|
| `emitAppProtocolRequest(windowId, request, timeoutMs)` | Sends a request through the pipeline and returns a promise that resolves with the response (or `undefined` on timeout). Default timeout: 5000 ms. |
| `resolveAppProtocolResponse(requestId, response)` | Called when the frontend sends `APP_PROTOCOL_RESPONSE`. Resolves the corresponding pending promise. |
| `waitForAppReady(windowId, timeoutMs)` | Waits for `APP_PROTOCOL_READY` from the frontend. Returns `true` if the app registered, `false` on timeout. |
| `notifyAppReady(windowId)` | Marks a window as protocol-ready and resolves pending `waitForAppReady()` calls. |

### WindowStateRegistry

**Source:** `packages/server/src/mcp/window-state.ts`

Tracks per-window protocol state:

| Field | Description |
|-------|-------------|
| `appProtocol?: boolean` | Set to `true` once `APP_PROTOCOL_READY` is received. Cached to skip `waitForAppReady()` on subsequent calls. |
| `appCommands?: AppProtocolRequest[]` | All commands executed on the app. Replayed if the app reloads. |

### Command Replay

When an iframe app reloads (e.g., due to HMR or navigation), the server detects a new `APP_PROTOCOL_READY` for a window that was already marked as ready. It then replays all recorded `appCommands` so the app returns to its previous state.

---

## Example

A minimal spreadsheet app:

```javascript
// Inside the iframe
const cells = {};

window.yaar.app.register({
  appId: 'sheet',
  name: 'Sheet',
  state: {
    cells: {
      description: 'All cell values keyed by address',
      handler: () => ({ ...cells }),
    },
  },
  commands: {
    setCells: {
      description: 'Set one or more cell values',
      params: {
        type: 'object',
        properties: {
          cells: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['cells'],
      },
      handler: (params) => {
        Object.assign(cells, params.cells);
        render();
        return { ok: true, count: Object.keys(params.cells).length };
      },
    },
  },
});
```

Agent interaction:

```
app_query(windowId: "sheet", stateKey: "manifest")  → discover capabilities
app_query(windowId: "sheet", stateKey: "cells")      → read current state
app_command(windowId: "sheet", command: "setCells", params: { cells: { "A1": "100" } })
```
