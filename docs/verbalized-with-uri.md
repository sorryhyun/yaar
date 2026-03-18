# URI-Based Resource Addressing

## Summary

`yaar://` is a unified URI scheme for addressing all internal resources: content (apps, storage), windows, configuration, browser instances, and session state (agents, notifications, prompts, monitors).

Every stable, inspectable entity gets a URI. Five generic verbs (`describe`, `read`, `list`, `invoke`, `delete`) operate on them.

---

## URI Space

All parsing flows through `packages/shared/src/yaar-uri.ts`. The `YaarAuthority` type covers seven namespaces. Server-side resolution is in `packages/server/src/handlers/uri-resolve.ts`.

### Content Resources

| Namespace | URI | Description |
|-----------|-----|-------------|
| `apps` | `yaar://apps/{appId}` | App content (resolved to iframe URL) |
| `storage` | `yaar://storage/{path}` | Persistent storage file |

Content URIs resolve to filesystem paths via `resolveResourceUri()` and to API paths via `resolveContentUri()`.

### Windows — `yaar://windows/{windowId}`

The primary way agents address windows. Monitor ID is injected automatically from the agent's context.

| URI | Description |
|-----|-------------|
| `yaar://windows/{windowId}` | Window (preferred shorthand, monitor auto-injected) |
| `yaar://windows/` | Window collection (list, create) |
| `yaar://monitors/{monitorId}/{windowId}` | Window with explicit monitor (internal addressing) |
| `yaar://monitors/{monitorId}/{windowId}/state/{key}` | Window state (app-protocol) |

### Config — `yaar://config/...`

| URI | Description |
|-----|-------------|
| `yaar://config/settings` | User settings |
| `yaar://config/hooks` | Event hooks |
| `yaar://config/hooks/{id}` | Specific hook entry |
| `yaar://config/shortcuts` | Keyboard shortcuts |
| `yaar://config/shortcuts/{id}` | Specific shortcut |
| `yaar://config/mounts` | Host directory mounts |
| `yaar://config/app/{appId}` | App credentials/config |

### Browser — `yaar://browser/{browserId}`

| URI | Description |
|-----|-------------|
| `yaar://browser/{browserId}` | Browser instance (URL, title, content, screenshot via `read`; navigate, click, type via `invoke` with `action`) |

### Sessions — `yaar://sessions/current/...`

All session-scoped resources live under this namespace. Agents, notifications, prompts, clipboard, and monitors are sub-resources of the current session.

| URI | Description |
|-----|-------------|
| `yaar://sessions/current` | Current session info (platform, uptime, stats) |
| `yaar://sessions/current/agents` | All active agents (list) |
| `yaar://sessions/current/agents/{agentId}` | Agent by instance ID (read info, invoke with `{ action: 'interrupt' }`) |
| `yaar://sessions/current/notifications` | Show notification (invoke with `{ id, title, body }`) |
| `yaar://sessions/current/notifications/{id}` | Dismiss notification (delete) |
| `yaar://sessions/current/prompts` | User prompts (invoke with `{ action: 'ask' \| 'request', ... }`) |
| `yaar://sessions/current/clipboard` | Clipboard contents |
| `yaar://sessions/current/monitors/{monitorId}` | Monitor status (monitor agent, window list, queue stats) |
| `yaar://sessions/current/logs` | Session logs |
| `yaar://sessions/current/context` | Context state |

---

## Verb Layer

Five verbs. The URI identifies the resource, the verb determines the operation.

| Verb | Semantics | Returns |
|------|-----------|---------
| `describe` | Schema + capabilities of a URI (which verbs it supports, payload shape) | `{ verbs, schema?, description }` |
| `read` | Get current state of a resource | Resource-specific data |
| `list` | Enumerate children of a collection URI | `{ items: { uri, name, ... }[] }` |
| `invoke` | Mutate, create, or trigger — the universal write/action verb | Resource-specific result |
| `delete` | Remove a resource | `{ deleted: true }` |

`invoke` covers both data mutation (idempotent merges like config updates) and side-effecting actions (browser navigate, agent interrupt). The URI identifies *what* is being acted on; the payload's `action` field (when needed) specifies *how*.

### Examples

```
read('yaar://config/settings')                          -> { theme: 'dark', ... }
invoke('yaar://config/settings', { theme: 'light' })    -> merge into settings
delete('yaar://config/app/github')                      -> remove app config

read('yaar://windows/win-1')                            -> window state
invoke('yaar://windows/', { action: 'create', title: 'Notes', renderer: 'markdown', content: '# Hello' })
invoke('yaar://windows/win-1', { action: 'update', operation: 'append', content: '...' })
invoke('yaar://windows/win-1', { action: 'subscribe', events: ['content', 'interaction'] })  -> { subscriptionId }
invoke('yaar://windows/win-1', { action: 'unsubscribe', subscriptionId: 'wsub-...' })
delete('yaar://windows/win-1')                          -> close window

read('yaar://browser/0')                                -> { url, title }
invoke('yaar://browser/0', { action: 'navigate', url: '...' })
invoke('yaar://browser/0', { action: 'click', selector: '#btn' })
invoke('yaar://browser/0', { action: 'screenshot' })

list('yaar://sessions/current/agents')                  -> active agents
invoke('yaar://sessions/current/agents/agent-1', { action: 'interrupt' })

read('yaar://sessions/current/clipboard')               -> clipboard contents
invoke('yaar://sessions/current/notifications', { id: 'n1', title: '...', body: '...' })
delete('yaar://sessions/current/notifications/n1')      -> dismiss notification
invoke('yaar://sessions/current/prompts', { action: 'ask', title: '...', message: '...', options: [...] })

read('yaar://sessions/current/monitors/0')              -> monitor status
read('yaar://sessions/current')                         -> session info

describe('yaar://config/settings')                      -> { verbs: ['read', 'invoke'], schema: { ... } }
describe('yaar://browser/0')                            -> { verbs: ['read', 'invoke'], actions: ['navigate', 'click', 'screenshot', ...] }
```

### MCP Surface

One MCP tool per verb:

| Tool Name | Parameters |
|-----------|------------|
| `describe` | `{ uri }` |
| `read` | `{ uri }` |
| `list` | `{ uri }` |
| `invoke` | `{ uri, payload? }` |
| `delete` | `{ uri }` |

### ResourceRegistry

Central registry in `packages/server/src/uri/registry.ts`. Maps URI patterns to handler objects.

```typescript
type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

interface ResourceHandler {
  /** Which verbs this handler supports. */
  verbs: Verb[];
  /** Human-readable description for `describe` responses. */
  description: string;
  /** JSON Schema for invoke payload (optional). */
  invokeSchema?: object;

  read?(parsed: ResolvedUri): Promise<unknown>;
  list?(parsed: ResolvedUri): Promise<{ items: { uri: string; name: string; [k: string]: unknown }[] }>;
  invoke?(parsed: ResolvedUri, payload: unknown): Promise<unknown>;
  delete?(parsed: ResolvedUri): Promise<{ deleted: boolean }>;
}

class ResourceRegistry {
  private handlers: Map<string, ResourceHandler> = new Map();

  /**
   * Register a handler for a URI pattern.
   * Pattern uses authority + optional path prefix:
   *   'yaar://config/settings'  -> matches exactly
   *   'yaar://config/'          -> matches yaar://config/ and anything under it
   *   'yaar://config/*'         -> wildcard match under yaar://config/
   */
  register(pattern: string, handler: ResourceHandler): void;

  /**
   * Resolve a URI to its handler. Returns the best-matching handler
   * by specificity (exact > prefix > wildcard).
   */
  findHandler(uri: string): ResourceHandler | null;

  /**
   * Execute a verb on a URI. Throws if verb not supported.
   */
  async execute(verb: Verb, uri: string, payload?: unknown): Promise<unknown>;
}
```

### Handler Registration

Each domain registers its handlers during server startup.

```typescript
// handlers/config.ts
export function registerConfigHandlers(registry: ResourceRegistry) {
  registry.register('yaar://config/settings', {
    verbs: ['read', 'invoke', 'describe'],
    description: 'User settings (theme, locale, etc.)',
    invokeSchema: { type: 'object', properties: { theme: { type: 'string' } } },
    async read() { return getConfig('settings'); },
    async invoke(_, payload) { return setConfig('settings', payload); },
  });

  registry.register('yaar://config/app/*', {
    verbs: ['read', 'invoke', 'delete', 'describe'],
    description: 'Per-app configuration and credentials',
    async read(parsed) { return getConfig('app', parsed.id); },
    async invoke(parsed, payload) { return setConfig('app', parsed.id, payload); },
    async delete(parsed) { return removeConfig(parsed.id); },
  });
}
```

For action-bearing resources (browser, agents), the handler dispatches on `payload.action`:

```typescript
// handlers/agents.ts — registered under yaar://sessions/current/agents
registry.register('yaar://sessions/current/agents/*', {
  verbs: ['read', 'invoke', 'describe'],
  description: 'Agent instance. Read for info, invoke to interrupt.',
  invokeSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['interrupt'] },
    },
  },
  async read(resolved) { /* ... */ },
  async invoke(resolved, payload) {
    if (payload.action === 'interrupt') { /* ... */ }
  },
});
```

---

## Where URIs Are Used

### Window Content

Window `content` fields use `yaar://` URIs. The server resolves them to API paths before sending to the frontend.

```
create({ uri: "excel-lite", title: "Excel Lite", renderer: "iframe", content: "yaar://apps/excel-lite" })
create({ uri: "report", title: "Q4 Report", renderer: "iframe", content: "yaar://storage/reports/q4.pdf" })
```

### Desktop Shortcuts

Shortcuts use `yaar://` URIs as their `target`. `extractAppId()` parses app identity from the target.

### App Discovery API

`GET /api/apps` returns `run` fields as `yaar://` URIs. Apps with custom `run` paths in `app.json` (e.g., `"run": "index.html"`) get `yaar://apps/{appId}/index.html`. Absolute paths are returned as-is.

---

## Resolution

### Content Resolution

Content URIs are resolved via `resolveContentUri()` in `@yaar/shared`:

```typescript
import { resolveContentUri } from '@yaar/shared';

resolveContentUri('yaar://apps/excel-lite')
// -> '/api/apps/excel-lite/index.html'

resolveContentUri('yaar://storage/docs/file.txt')
// -> '/api/storage/docs/file.txt'

```

Resolution points:
- **Server** (`mcp/window/create.ts`): resolves URIs in iframe content before emitting OS actions
- **Frontend** (`lib/api.ts`): `resolveAssetUrl()` resolves URIs and adds remote-mode auth

### File-Operation Parsing

File-operation URIs are parsed via `parseFileUri()` in `@yaar/shared`. This handles `yaar://` URIs (not API paths):

```typescript
import { parseFileUri, buildFileUri } from '@yaar/shared';

parseFileUri('yaar://storage/docs/file.txt')
// -> { authority: 'storage', path: 'docs/file.txt' }

buildFileUri('storage', 'docs/file.txt')
// -> 'yaar://storage/docs/file.txt'
```

The verb handlers use `parseFileUri()` for storage file operations.

### Content Helpers

```typescript
import { parseYaarUri, buildYaarUri, extractAppId, isYaarUri } from '@yaar/shared';

parseYaarUri('yaar://apps/storage')
// -> { authority: 'apps', path: 'storage' }

buildYaarUri('apps', 'excel-lite')
// -> 'yaar://apps/excel-lite'

extractAppId('yaar://apps/excel-lite')
// -> 'excel-lite'
```

---

## Key Files

| File | Role |
|------|------|
| `packages/shared/src/yaar-uri.ts` | URI parser, builder, resolver (content, file, window, config, browser, agents, user, sessions) |
| `packages/server/src/handlers/uri-resolve.ts` | Server-side typed resolution for all URI namespaces |
| `packages/server/src/handlers/uri-registry.ts` | ResourceRegistry — central handler registry |
| `packages/server/src/handlers/index.ts` | 5 verb MCP tool definitions (describe, read, list, invoke, delete) |
| `packages/server/src/http/routes/files.ts` | HTTP routes using `parseContentPath()` for apps, storage |
| `packages/frontend/src/lib/api.ts` | Frontend URI resolution + remote auth |

---

## Iframe Verb Access & Token Validation

Iframe apps can call verbs via HTTP (`POST /api/verb`), but access is gated by a per-window token and an allowlist declared in `app.json`.

### Token Lifecycle

```
Window created (server)
  → generateIframeToken(windowId, sessionId, appId, permissions)
  → Token included in window.create OS action payload
  → Frontend injects token into iframe (same-origin only):
     1. URL query param: ?__yaar_token=<token>
     2. Script injection: window.__YAAR_TOKEN__ = '<token>'
  → Cross-origin iframes cannot receive tokens (no verb access)
  → Iframe SDK reads token from either source
  → All /api/verb requests include X-Iframe-Token header
  → Token expires after 24 hours (auto-cleaned)
  → Token revoked when window closes
```

**Source:** `packages/server/src/http/iframe-tokens.ts`

### Permission Enforcement

Apps declare which URIs they can access in `app.json`:

```json
{
  "permissions": [
    "yaar://apps/self/storage/",
    "yaar://storage/"
  ]
}
```

The verb route (`POST /api/verb`) enforces this:

1. Extract `X-Iframe-Token` header
2. Validate token → get `TokenEntry` (windowId, sessionId, appId, permissions)
3. Check URI against permissions: exact match or prefix match (entries ending in `/`)
4. If no match → 403

Apps with no `permissions` field get zero verb access by default.

**Source:** `packages/server/src/http/routes/verb.ts`

### `yaar://apps/self/` Resolution

Apps can use `self` as a shorthand for their own appId:

```
yaar://apps/self/storage/data.json  →  yaar://apps/{actual-appId}/storage/data.json
```

Resolved server-side using the `appId` from the token entry. Fails with 403 if the token has no appId.

### Iframe SDK

The `IFRAME_VERB_SDK_SCRIPT` (exported from `packages/shared/src/capture-helper.ts`) provides a `window.yaar` API:

| Method | Endpoint |
|--------|----------|
| `window.yaar.invoke(uri, payload?)` | `POST /api/verb` |
| `window.yaar.read(uri)` | `POST /api/verb` |
| `window.yaar.list(uri)` | `POST /api/verb` |
| `window.yaar.describe(uri)` | `POST /api/verb` |
| `window.yaar.delete(uri)` | `POST /api/verb` |
| `window.yaar.subscribe(uri, cb)` | `POST /api/verb/subscribe` |

All requests automatically include the `X-Iframe-Token` header. Subscriptions deliver update notifications via `postMessage` with type `yaar:subscription-update` (contains the URI that changed — apps must call `read` to get the new value).
