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

### Sub-path URIs (monitor/session agents)

The same protocol has a direct spelling in which the **URI** names the state key or the command, rather than a field of the payload. `enrichManifestWithUris` has been stamping these URIs onto every entry of every live manifest since before any handler implemented them — a read of one used to return the whole window — and they are now dispatched:

| Call | Description |
|------|-------------|
| `describe('yaar://windows/{windowId}')` | *This instance's* manual. The live manifest when the iframe has registered (`source: 'live'`), the app's on-disk `protocol.json` when it has not (`source: 'manifest'`). The two diverge after a deploy without a reload, so a manual that doesn't say which it read makes that divergence invisible. A non-app window has no protocol at all and answers with its applicable action set instead. |
| `list('yaar://windows/{windowId}')` | This window's state keys and commands, as `yaar://windows/{w}/state/{key}` / `.../commands/{key}` resource links — **the index**: each row carries its rendered signature and the *first sentence* of its description, which is enough to pick a command and call it. The full prose is one `describe` away at the row's own URI. (It used to ignore the window id and return every window on the monitor — that is what `list('yaar://windows')` is for.) |
| `read('yaar://windows/{windowId}/state/{key}')` | One state value — the same executor as `app_query` with that `stateKey`. Reading a `commands/{key}` URI is an error: commands are invoked. |
| `invoke('yaar://windows/{windowId}/commands/{key}', { ...params })` | Run one command. The payload **is** the params — an `action` or a nested `params` in it is refused rather than guessed at, since two spellings of one call with unclear precedence is how such lists drift, and `timeoutMs` is consumed as the transport deadline. **Unless the command declares one of those three names as a param of its own**, in which case it is that param: the reservation is checked against the command's schema, not against the key name (see below). An **array** payload runs the command once per element, in order. Invoking a `state/{key}` URI is an error. |
| `describe('yaar://windows/{windowId}/{state,commands}/{key}')` | That one key's documentation — see [Describe](#describe) below. |

Both spellings reach the same `handleAppQuery` / `handleAppCommand`, so readiness wait, replay recording, and truncation are identical.

Note the contrast with `yaar://apps/{appId}`, the **installed** app: `state/` and `commands/` are not addressable there on any verb and the handler refuses them by name. Protocol state has no value and a command has nothing to act on until a window is open, and the same app open on two monitors is two states — an `apps/` spelling would name one arbitrarily or name none. `storage/`, `db/`, `agents/`, and `protocol` stay addressable under `apps/`.

`yaar://apps/{appId}/protocol/commands/{key}` is the other side of that same line rather than an exception to it: it serves the *documentation* of a command, which is a property of the installed app and identical on every monitor, and it cannot run anything. Read it when you want a command's schema without opening a window; use the `windows/` spelling to call it, and to get the manual of the instance actually running (a devtools preview's live protocol routinely differs from what is on disk). Full table in [`uri_reference.md`](./uri_reference.md#the-protocol--yaarappsappidprotocol).

### Scoped tools (app agents)

Each persistent app agent (one per `appId`) instead gets dedicated `query` / `command` / `describe` MCP tools (`mcp/app-agent/index.ts`, namespace `app` — full names `mcp__app__query` etc.), which call the same `handleAppQuery` / `handleAppCommand` functions. `describe` is the app's manual and is built by the same `describeApp` behind `describe('yaar://apps/{appId}')` — one question, one shape, whichever door asks it. It answers with SKILL.md plus an **index** of the protocol (every command's signature and opening sentence), and takes an optional `command` to return that one command in full instead, schema included.

The two doors differ in exactly one respect, and for a stated reason: the verbs door emits command *names* and the URIs that serve the rest, while the tool emits the whole index inline. Its caller holds four scoped tools and no `read` verb, so a URI it cannot open is the same dead end this split exists to remove — and `describe({ command })` is that caller's spelling of `read('yaar://apps/{id}/protocol/commands/{name}')`. These tools:
- Default to the agent's own window; pass `appId` to target another app, permitted only when the *calling* app's own `app.json` `controls` list names that target (see root `CLAUDE.md` "Cross-app control"). The target need not already be open — resolution is the target's most recently active window on the caller's monitor, else any window of it on that monitor, else a fresh one opened for the call (`features/window/resolve-app-window.ts`, shared with `direct_message`); the result says when one was opened.
- Intercept `stateKey`/`command` values prefixed `storage/` / `storage:` to read/write app-scoped storage directly, bypassing the app protocol entirely (own app only — storage is not cross-app controllable) — **but only for an app that declares storage.** See "The storage door is declared" below.
- Reach the **shared** storage tree when the path is spelled as a URI — `query({ stateKey: 'yaar://storage/x' })`, or a `yaar://storage/...` `path` param on the `storage:` commands. Two trees, two spellings. The URI form reaches the commons — `yaar://storage/shared/…`, granted to every app, nothing to declare — and anything *beyond* it needs a covering entry in the caller's `app.json` `permissions` (`read` to read, `list` to list, `invoke` to write, `delete` to delete — the verbs the verbs door charges for the same work), checked with the same `permissionsAllow` the iframe door uses. Without it, a declared `yaar://storage/` was enforced for an app's iframe code and unreachable from its agent, whose four tools are its whole surface. See `mcp/app-agent/shared-storage.ts`.
- `command` accepts an optional `timeoutMs` to override the default wait (30s, max 180s) for slow commands like a compile or a deploy.

#### The storage door is declared

An app agent holds `storage:write` / `storage:delete` / `storage:list`, and the relative `storage/{path}` spelling on `query`, **iff** its `app.json` declares at least one entry under `yaar://storage/` (the `yaar://storage/apps/` subtree excluded). An app that declares none is refused all of them by name — including against its *own* tree, which is the aggressive half of the rule and is deliberate: a capability the author never declared is not one the agent should hold. Its agent is also never told the door exists; the system prompt's two storage sections are rendered under the same condition, so the prompt and the tool agree by construction (`declaresSharedStorage` in `mcp/app-agent/shared-storage.ts` is the one predicate, and `agents/profiles/app-agent.ts` is the only place a conditional is applied — the `query`/`command` tool *descriptions* mention storage nowhere).

Exposure is not authorization. A declaration opens the door; `permissionsAllow` still decides each call, so `{ uri: "yaar://storage/reports/", verbs: ["read","list"] }` exposes the built-ins and still refuses `storage:write`.

An undeclared app reaches storage the way the design intends: its **iframe** uses `@bundled/yaar` (`appStorage`, `invoke`) inside a command declared in `protocol.json`, and the agent calls that command by name. `apps/session-logs` (`saveReport`) and `apps/devtools` (`protocol/shared-tree.ts`) are the worked examples. The iframe side is untouched — `SELF_GRANTS`, the commons, and every `POST /api/verb` path work exactly as before. The asymmetry is the point: an iframe is app-authored code, an agent is a model.

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
  $defs?: Record<string, object>;               // subschemas shared by more than one descriptor
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

The manifest is built automatically from the registration config by stripping handler functions and exposing only descriptions and schemas. A per-key `describe()` is stripped along with the handlers — it is answered on demand (see [Describe](#describe)) and never rides in the manifest.

**`$defs` — a shape stated once.** A schema an app repeats (one texture-slot object used
by five material maps; `{x, y, z}` on every command that takes a position) is hoisted by the
compiler into `$defs` and replaced at each use with `{"$ref": "#/$defs/<name>"}`. Names are
derived from the shape (`x_y_z`, `uri_repeat_offset_etc`), not generated, because the reader
is a model. **The manifest is the schema document**: a pointer resolves against
`manifest.$defs` and nothing else. Two consequences worth knowing:

- A **descriptor's top-level** `params`/`returns`/`schema` is never replaced by a pointer, so
  `properties` and `required` are always readable straight off it — the iframe bridge rejects
  a bad call by reading exactly those two.
- A door that hands **one** descriptor's schema on by itself carries the defs that schema
  reaches, as a `$defs` on the returned schema. `describe('yaar://windows/{id}/commands/{key}')`
  does this; the slice is self-contained and its pointers resolve against itself.

Apps that share nothing carry no `$defs` at all. The pass is content-neutral — resolving every
pointer reproduces the pre-fold manifest exactly — and lives in
`packages/compiler/src/protocol/dedupe-schemas.ts`.

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

### Describe

Documents one state key or one command, on demand — `describe('yaar://windows/{windowId}/{state,commands}/{key}')`. An app may attach an optional `describe()` to any `state` or `commands` entry in `defineApp()` and compute the answer from what it currently holds ("412 rows; a row is `{ id, title, done }`"). It is never folded into the manifest: a doc computed from live data on every manifest read would make the cheapest call the most expensive.

**Request** (parent → iframe):
```json
{ "type": "yaar:app-describe-request", "requestId": "req-...", "target": "state", "key": "items" }
```

**Response** (iframe → parent):
```json
{ "type": "yaar:app-describe-response", "requestId": "req-...", "doc": "412 rows; a row is { id, title, done }", "error": null }
```

`command` aliases resolve to the canonical name first, as they do for a command call. Three outcomes, and the middle one is why this is not simply "error unless the app defined a `describe()`":

| Case | Result |
|------|--------|
| The key is not in the registration | `error` — the one genuine "no such resource" |
| The key exists, no `describe()` on it | `doc: null`, and the server answers with the manifest's static `description` (plus the command's `params` schema), tagged `source: 'manifest'` |
| The key exists with a `describe()` | The app's computed doc |

`protocol.json` already carries a one-line `description` per key, so erroring on a key that *is* documented would report it as missing — the same false signal the registry's `exists` hook exists to remove.

**A command's answer also says how to call it** — `signature` (`setGeometryParams(id: string, params?: object, points?: array)`), a rendered `invoke` example carrying the literal param names, and its `schema`. Both spellings of the doc (computed and manifest) carry them, which is why a command's describe reads the manifest either way. The prose these replace — "the payload *is* `params`" — reads as a prohibition on a payload containing a key called `params`, and no rewording fixes a sentence that has to be applied to a name it collides with; a rendered example cannot be read that way. The same signature prefixes each command's `description` in `list('yaar://windows/{windowId}')`, so the list is enough to call from without a second round trip — there the description is summarized to its first sentence, since a list is for *finding* the command and carrying every word of every description made that door 79.9 KB for a 52-command app, past the size at which the CLI stops delivering a result inline at all.

**Reserved keys are checked against the schema, not the name.** `action`, `params` and `timeoutMs` mean something to the sub-path spelling — the first two are refused, the third is consumed as the transport deadline. That was applied to the key name alone, which made every command whose own schema declares one of them unreachable through this spelling (`studio-3d.setGeometryParams(id, params, points)`, `devtools.previewCommand(command, params, timeoutMs)`) and made one of them *silently* wrong: `devtools.previewEval(expression, timeoutMs, …)` declares how long the preview may take to settle, and the server ate it as its own deadline and told the app nothing. A command that declares one of the three now receives it as the param it is — and a declared `timeoutMs` is *both*, steering the transport deadline as well, so the server does not cut off a wait it just authorized. The schema is consulted only when one of the three names is present in the payload, so an ordinary call pays for no lookup; when the manifest cannot account for the command (an app that never registered and ships no `protocol.json`) the old refusals stand, since sending an undeclared key gets the whole command rejected by the bridge.

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
    | { kind: 'command'; command: string; params?: unknown; replayed?: boolean }
    | { kind: 'eval'; expression: string }
    | { kind: 'describe'; target: 'state' | 'commands'; key: string };
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
    | { kind: 'eval'; value?: string; error?: string }
    | { kind: 'describe'; doc: string | null; error?: string };
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
      describe: () => `${items.length} items; an item is { text }`,  // optional, on demand only
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

The same three, spelled as URIs:

```
describe('yaar://windows/sheet')                                → this instance's manual
list('yaar://windows/sheet')                                    → its state keys and commands
read('yaar://windows/sheet/state/cells')                        → read current state
invoke('yaar://windows/sheet/commands/setCells', { cells: { "A1": "100" } })
```
