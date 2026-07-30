# App Protocol Reference

The App Protocol enables bidirectional communication between AI agents and iframe-based apps. Apps register a self-describing manifest of their capabilities (state keys and commands), and agents discover and interact with them at runtime.

**Source:** `packages/shared/src/app-protocol.ts`

---

## Overview

```
Agent calls invoke(window, { action: 'app_query' | 'app_command' }) or a scoped app-agent tool
  → ActionEmitter → WebSocket → Frontend
  → postMessage → Iframe App
  → postMessage response → Frontend
  → WebSocket → ActionEmitter resolves
  → tool returns result to agent
```

An app opts in simply by registering with `export default defineApp({...})` (imported from
`@bundled/yaar`) inside the iframe — that's the whole signal the compiler and runtime look for.
(An `"appProtocol": true` field in `app.json` is not read anywhere; the compiler's `deploy.ts`
strips it as legacy.)

---

## Invocation

The core logic (`handleAppQuery` / `handleAppCommand`) is shared by two entry points that differ by _which_ agent is calling and _what surface_ it sees:

- **Monitor/session agent** — an app is just another window. It reaches apps through the same generic `invoke` verb it uses for every window, targeting the window URI explicitly. No app is privileged; it can query/command any open app window.
- **Persistent app agent** (one per `appId`) — gets a narrow, dedicated tool surface scoped to _its own_ app by default. Reaching another app requires the *calling* app's own `app.json` `controls` list to name that target (cross-app control) — `controls` is read from the caller (`getAppMeta(ownAppId)`), not the target.

Both paths converge on the same executor below, so app-side behavior (readiness wait, command replay, storage interception) is identical regardless of caller.

**Source:** `packages/server/src/features/window/app-protocol.ts`

### Generic verb (monitor/session agents)

Reached via the generic `invoke` tool on a window resource (`handlers/window.ts`), alongside the window's other actions (`create`, `update`, `close`, `lock`, `unlock`, `move`, `resize`, `message`, `subscribe`, `unsubscribe`, `app_subscribe`, `app_unsubscribe`, `app_eval`):

| Call | Description |
|------|-------------|
| `invoke('yaar://windows/{windowId}', { action: 'app_query', stateKey? })` | Read a state key, or the manifest if `stateKey` is omitted (defaults to `'manifest'`). The reserved key `'__console'` pulls the app's console-capture buffer (`window.__YAAR_CONSOLE`) directly from the injected app-protocol script — it works even when the app never registered and bypasses the app-ready wait (used by devtools to read a preview app's console logs). |
| `invoke('yaar://windows/{windowId}', { action: 'app_command', command, params?, timeoutMs? })` | Execute a command. Optional `timeoutMs` overrides how long the server waits for the app to respond (default 30s, clamped to a max of 180s) — raise it for slow commands like a compile or a deploy. |
| `invoke('yaar://windows/{windowId}', { action: 'app_eval', expression, timeoutMs? })` | Evaluate a JS expression inside the iframe and return its JSON-serialized result (capped at 16KB). A promise is awaited, so `timeoutMs` overrides the wait (default 5s — the app-query deadline — clamped to a max of 180s); raise it for an expression that sleeps or waits on a render. Refused everywhere except devtools preview windows (`devtools-preview-{projectId}`) — a disposable sandbox devtools just built from source, where eval grants nothing beyond what editing-and-recompiling already would. |

### Scoped tools (app agents)

Each persistent app agent (one per `appId`) instead gets dedicated `query` / `command` / `describe` MCP tools (`mcp/app-agent/index.ts`, namespace `app` — full names `mcp__app__query` etc.), which call the same `handleAppQuery` / `handleAppCommand` functions. These tools:
- Default to the agent's own window; pass `appId` to target another app, permitted only when the *calling* app's own `app.json` `controls` list names that target (see root `CLAUDE.md` "Cross-app control").
- Intercept `stateKey`/`command` values prefixed `storage/` / `storage:` to read/write app-scoped storage directly, bypassing the app protocol entirely (own app only — storage is not cross-app controllable).
- `command` accepts an optional `timeoutMs` to override the default wait (30s, max 180s) for slow commands like a compile or a deploy.

`query`/`command`/`describe` are the app agent's app-protocol tools. Its remaining tools — `relay` (hand a request to the monitor agent) and `direct_message` (message another app's agent, when `app.json` sets `"messaging": "all"`) — are _not_ app-protocol calls and don't touch the executor below; see `agents/profiles/app-agent.ts`.

**Behavior (both entry points):**
1. Validates the window exists and uses the `iframe` renderer.
2. Waits up to 5 s for the app to send `yaar:app-ready` (skipped if already registered — cached on `WindowState.appProtocol`). Also skipped for the reserved `__console` state key (see below), so unregistered preview apps can still answer it.
3. Sends the request through the protocol pipeline (`ActionEmitter.emitAppProtocolRequest`).
4. For `app_command`, records the command via `WindowStateRegistry.recordAppCommand()` for replay on reload.
5. Returns the JSON response (manifest responses are enriched with resource `uri` hints per state/command key) or an error string. Large text/resource results are truncated to ~400KB.

### Event subscriptions: `app_subscribe` / `app_unsubscribe`

An agent subscribes to an app's declared `app.emit()` channels rather than polling state:

```
invoke('yaar://windows/{windowId}', { action: 'app_subscribe', channels?, mode? })
invoke('yaar://windows/{windowId}', { action: 'app_unsubscribe', subscriptionId })
```

| Field | Description |
|-------|-------------|
| `channels?: string[]` | Channel names to subscribe to. Omit (or pass `["*"]`) to subscribe to all channels the app has declared. Discover channel names via `app_query` manifest (`events`). |
| `mode?: 'wake' \| 'buffer'` | Delivery mode. `'wake'` (default) delivers a task to the subscribing agent as soon as the event fires. `'buffer'` folds the event into the agent's next turn instead of waking it. |

`app_subscribe` returns `{ subscriptionId, targetWindowId, channels, mode }`. `app_unsubscribe` takes the returned `subscriptionId` (same shape as the generic `unsubscribe` action). Currently monitor agents only. **Source:** `packages/server/src/features/window/subscribe.ts`.

---

## Manifest

An `AppManifest` describes what the app can do. The agent retrieves it via `app_query` (omit `stateKey`, or pass `"manifest"`) on a bare window URI (e.g., `yaar://windows/win-sheet`).

```typescript
interface AppManifest {
  appId: string;
  name: string;
  state: Record<string, AppStateDescriptor>;
  commands: Record<string, AppCommandDescriptor>;
  events?: Record<string, AppEventDescriptor>;  // declared app.emit() channels (optional)
}

interface AppStateDescriptor {
  description: string;
  schema?: object;        // JSON Schema (optional)
}

interface AppCommandDescriptor {
  description: string;
  aliases?: string[];     // alternate names the agent may call this command by (optional)
  params?: object;        // JSON Schema for parameters (optional)
  returns?: object;       // JSON Schema for return value (optional)
}

interface AppEventDescriptor {
  description: string;
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

If `command` matches a declared `aliases` entry, the SDK resolves it to the canonical command name before dispatching.

**Response** (iframe → parent):
```json
{ "type": "yaar:app-command-response", "requestId": "req-...", "result": { "ok": true }, "error": null }
```

### Eval

Arbitrary expression evaluation, dispatched only to devtools preview windows — the server-side `handleAppEval` guard rejects it for any other window before the request ever reaches the iframe (the iframe itself cannot verify that; the gate lives on the side that knows).

**Request** (parent → iframe):
```json
{ "type": "yaar:app-eval-request", "requestId": "req-...", "expression": "document.querySelectorAll('.row').length" }
```

**Response** (iframe → parent):
```json
{ "type": "yaar:app-eval-response", "requestId": "req-...", "value": "3", "error": null }
```

`expression` is run via indirect `eval` (global scope, so it sees the app's globals). `value` is the JSON-serialized result (or `String(...)` for values `JSON.stringify` can't handle), truncated with an explicit marker if oversized.

### Close

Fire-and-forget, sent right before the window is destroyed (no response expected). The SDK invokes the app's `onClose()` handler (from `defineApp()`), if any.

**Notification** (parent → iframe):
```json
{ "type": "yaar:app-close" }
```

### Event

Fire-and-forget, pushed from the app to the agent side via `app.emit(channel, payload)`. Delivered only to agents subscribed to the channel (`app_subscribe`); undeclared/unsubscribed channels are dropped server-side.

**Notification** (iframe → parent):
```json
{ "type": "yaar:app-event", "channel": "cell-changed", "payload": { "address": "A1" } }
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
    | { kind: 'command'; command: string; params?: unknown }
    | { kind: 'eval'; expression: string };
  timeoutMs?: number;  // how long the server is prepared to wait; the frontend runs its own
                        // round-trip timer against this instead of a fixed 5s
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
    | { kind: 'command'; result: unknown; error?: string }
    | { kind: 'eval'; value?: string; error?: string };
}
```

### Client → Server: `APP_PROTOCOL_READY`

Sent when an iframe app registers via `defineApp()` (from `@bundled/yaar`).

```typescript
{
  type: 'APP_PROTOCOL_READY';
  windowId: string;
  reannounce?: boolean;  // true when the desktop is repeating a registration it already
                          // witnessed (e.g. reattach after a server restart), not reporting a
                          // fresh one from the iframe — the server must not replay recorded
                          // commands in this case, since the iframe never forgot its state
}
```

### Client → Server: `APP_EVENT`

Sent when an app emits on a declared channel via `app.emit(channel, payload)`. The server matches subscribers (`app_subscribe`) and either wakes the subscribing agent or buffers the event into its next turn.

```typescript
{
  type: 'APP_EVENT';
  windowId: string;
  channel: string;
  payload: unknown;
  messageId: string;
}
```

---

## Iframe SDK

The SDK is available via `@bundled/yaar`. Import `defineApp` to register, and `app` for `app.sendInteraction()` / `app.emit()`. Under the hood, the protocol script (`IFRAME_APP_PROTOCOL_SCRIPT` in `packages/shared/src/iframe-scripts/app-protocol.ts`) is automatically injected into every iframe's `<head>` by the `IframeRenderer` component.

### The registration shape

`export default defineApp({ id, name, state, commands, view })` is the one authoring
entrypoint; it registers once at module scope, before mounting the view. See
[`docs/guides/app-development.md`](../guides/app-development.md#registering-in-your-app--defineapp).
The former low-level `app.register()` is removed — its registration entry is now private to
`defineApp`, and calling the public name throws.

Below is the registration `defineApp` produces, which is also the wire contract. Authoring
differs in three places: `id` rather than `appId`, `get` rather than a state `handler`, `run`
rather than a command `handler` — and `params`/`schema` may be a Zod schema as well as a JSON
Schema literal.

```typescript
// The wire shape. In your app you write `defineApp({ id, ... get, ... run })`.
{
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
      aliases: ['add-item'],  // optional alternate names the agent may call this by
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

  events: {
    'item-added': { description: 'Fires when an item is added' },  // optional, declares an app.emit() channel
  },

  onClose: () => {
    // optional — called when the window is about to be destroyed
  },

  onCapture: () => {
    // optional — return a data-URL image when the OS captures this window
    // (e.g. an agent reads it). Return null to fall back to the default
    // full-window screenshot. May be async.
    return myCanvas.toDataURL('image/png');
  },
}
```

On registration the SDK sends `{ type: 'yaar:app-ready', appId }` to the parent so the server knows the app supports the protocol.

**Window capture:** when an agent reads an iframe window, the injected capture script returns a screenshot. By default this is a full-window composite — the DOM rendered via foreignObject SVG with every live `<canvas>`'s pixels composited in place. An app that can produce a better image (e.g. a WebGL scene that snapshots blank, or a viewport larger than the visible area) overrides it with `onCapture`.

### `app.sendInteraction(description)`

Send a free-form interaction message from the app to the AI agent. Useful for notifying the agent about user actions inside the iframe. Accepts a string, or an object with `instructions` and `toMonitor` plus arbitrary payload fields (JSON-stringified into `content`).

```typescript
import { app } from '@bundled/yaar';

app.sendInteraction('User clicked the save button');
app.sendInteraction({ instructions: 'Summarize this', toMonitor: true, selection: 'some text' });
```

This posts a `{ type: 'yaar:app-interaction', content, instructions?, toMonitor }` message to the parent, which routes it to the window's agent (or the monitor agent if `toMonitor` is set).

When the window's app agent is idle, `sendInteraction()` invokes it immediately. When that
agent already has an active turn, the interaction is delivered to the normal steering path
instead of being accumulated as deferred context.

Use `sendInteraction()` when the interaction itself needs an agent response. Ordinary app
state changes do not need to emit an interaction merely to keep the next invocation informed:
YAAR compares all declared App Protocol state at app-agent handoff boundaries and prepends
`<app_state_since_handoff changed="true|false" />` to the next invocation. This is an
aggregate net-change signal; the agent queries authoritative state when it needs details.

### `app.emit(channel, payload)`

Fire-and-forget event on a declared channel (see `events` in `defineApp()`). Delivered only to agents that subscribed via `app_subscribe`; undeclared/unsubscribed channels are dropped server-side.

```typescript
import { app } from '@bundled/yaar';

app.emit('item-added', { text: 'Buy milk' });
```

---

## File Associations

Apps can declare file types they can open in `app.json`:

```json
{
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

When a user opens a file with a matching extension, the agent invokes `app_command` with the specified `command` and the file content in the `paramKey` parameter.

---

## Server-Side Internals

### ActionEmitter

**Source:** `packages/server/src/session/action-emitter.ts`

| Method | Description |
|--------|-------------|
| `emitAppProtocolRequest(windowId, request, timeoutMs)` | Sends a request through the pipeline and returns a `Promise<PendingOutcome<AppProtocolResponse>>` — `{ ok: true, value }` on response, or `{ ok: false, reason: 'timeout' \| 'cancelled' }` (never a bare `undefined`). Default timeout: 5000 ms. |
| `resolveAppProtocolResponse(requestId, response)` | Called when the frontend sends `APP_PROTOCOL_RESPONSE`. Resolves the corresponding pending promise. |
| `waitForAppReady(sessionId, windowId, timeoutMs?)` | Waits for `APP_PROTOCOL_READY` from the frontend, scoped to the caller's session. Returns `true` if the app registered, `false` on timeout. |
| `notifyAppReady(sessionId, windowId)` | Marks a window as protocol-ready in that session and resolves pending `waitForAppReady()` calls. |

### WindowStateRegistry

**Source:** `packages/server/src/session/window-state.ts`

Tracks per-window protocol state:

| Field | Description |
|-------|-------------|
| `WindowState.appProtocol?: boolean` | Set to `true` once `APP_PROTOCOL_READY` is received (`setAppProtocol()`). Cached to skip `waitForAppReady()` on subsequent calls. |
| internal `appCommands: Map<windowId, AppProtocolRequest[]>` | All commands executed on the app (via `recordAppCommand()` / `getAppCommands()`). Replayed if the app reloads. |

### Command Replay

When an iframe app reloads (e.g., due to HMR or navigation), the server detects a new `APP_PROTOCOL_READY` for a window that was already marked as ready, and replays its recorded `appCommands` so the app returns to its previous state (`AppWindowCoordinator.replayCommands()`). Three refinements on top of that:

- A command whose *currently running* registration declared `replay: 'never'` for it is skipped rather than resent — those are commands that append, notify, or otherwise have a one-shot effect, so resending would duplicate it rather than restore state. The replay policy is read from the registration that just came back up, not the one that was there before the reload.
- Every command that *is* resent is stamped `replayed: true` on the request, so a handler can read `ctx.replayed` (the second argument to a command handler) to reconcile against state it already restored from its own persistence instead of opting out of replay wholesale.
- No replay happens at all when the ready event is a `reannounce` (`AppProtocolReadyEvent.reannounce`) — that's the desktop repeating a registration it already witnessed, with the iframe never having remounted, so there's nothing to restore.

---

## Example

A minimal spreadsheet app:

```typescript
import { defineApp } from '@bundled/yaar';

const cells = {};

export default defineApp({
  id: 'sheet',
  name: 'Sheet',
  state: {
    cells: {
      description: 'All cell values keyed by address',
      get: () => ({ ...cells }),
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
      run: (params) => {
        Object.assign(cells, params.cells);
        return { ok: true, count: Object.keys(params.cells).length };
      },
    },
  },
});
```

Agent interaction:

```
invoke('yaar://windows/sheet', { action: 'app_query' })                                    → discover capabilities (manifest)
invoke('yaar://windows/sheet', { action: 'app_query', stateKey: 'cells' })                  → read current state
invoke('yaar://windows/sheet', { action: 'app_command', command: 'setCells', params: { cells: { "A1": "100" } } })
```
