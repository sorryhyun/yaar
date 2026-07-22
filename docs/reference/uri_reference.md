# URI & Verb Reference

Precise reference for the `yaar://` URI scheme and the five generic verbs. For the design rationale — why URIs, why five verbs — see [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

All parsing flows through `packages/shared/src/yaar-uri.ts`. Server-side handler registration lives in `packages/server/src/handlers/` (one file per namespace), registered into the `ResourceRegistry` in `handlers/uri-registry.ts`.

---

## URI Space

The `YaarAuthority` type covers nine namespaces:

| Namespace | URI | Description |
|-----------|-----|-------------|
| `apps` | `yaar://apps/{appId}` | App content (resolved to iframe URL), app storage, app DB |
| `storage` | `yaar://storage/{path}` | Persistent storage file |
| `windows` | `yaar://windows/{windowId}` | Windows (monitor inferred from agent context) |
| `config` | `yaar://config/...` | Settings, hooks, shortcuts, mounts, app credentials |
| `session` | `yaar://session/...` | Session info, agents, monitors, logs, context, browser |
| `user` | `yaar://user/...` | Notifications, prompts, clipboard |
| `history` | `yaar://history/` | Past session logs (list/read) |
| `skills` | `yaar://skills/{topic}` | Skill topic docs (read before using related tools) |
| `mcp` | `yaar://mcp/...` | External MCP server gateway (add/remove/refresh servers, call their tools) |

### Windows — `yaar://windows/{windowId}`

The canonical way agents address windows. The monitor is injected automatically from the agent's context.

| URI | Description |
|-----|-------------|
| `yaar://windows/` | Window collection (list, create) |
| `yaar://windows/{windowId}` | Window (read, update, subscribe, message, delete) |
| `yaar://windows/{windowId}/state/{key}` | Window state (app-protocol) |
| `yaar://windows/{windowId}/commands/{key}` | Window command (app-protocol) |

> `yaar://monitors/{monitorId}` survives only as an internal `ContextSource` tag
> (`agents/context.ts`) for tagging message history — it is **not** an addressable resource URI.
> Monitors are addressed as `yaar://session/monitors/{monitorId}`.

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
| `yaar://config/domains` | HTTP domain allowlist |

### Session — `yaar://session/...`

Session-scoped resources. The entire namespace is **session-principal** — only the session agent may access it (enforced centrally in `ResourceRegistry.execute()`; monitor/app agents get a 403).

| URI | Description |
|-----|-------------|
| `yaar://session` | Current session info (platform, uptime, stats) |
| `yaar://session/agents` | All active agents (list) |
| `yaar://session/agents/{agentId}` | Agent by instance ID (read info, invoke with `{ action: 'interrupt' }`) |
| `yaar://session/agents/session` | The session agent itself (invoke with `audit` / `coordinate` / `query`) |
| `yaar://session/monitors/{monitorId}` | Monitor status and control (see below) |
| `yaar://session/browser` | The user's real Chrome (the only door to it) |
| `yaar://session/logs` | Session logs |
| `yaar://session/context` | Context state |

**Monitor control** (`yaar://session/monitors/{id}`):

| Verb | Effect |
|------|--------|
| `read` | Monitor detail: agent status (busy/idle), suspended state, queue depth, windows |
| `invoke { action: "suspend" }` | Pause the monitor's queue — agent stays alive, tasks enqueue but don't process |
| `invoke { action: "resume" }` | Unpause and drain pending tasks |
| `invoke { action: "interrupt" }` | Interrupt the monitor's current task |
| `delete` | Dispose the monitor agent and clear its queue |

**Session agent actions** (`yaar://session/agents/session`):

| Action | Payload | Effect |
|--------|---------|--------|
| `audit` | — | Reviews all monitors, reports anomalies |
| `coordinate` | `{ plan: "..." }` | Orchestrates cross-monitor work |
| `query` | `{ question: "..." }` | Answers questions about session state |

### User — `yaar://user/...`

Callable by every agent tier:

| URI | Description |
|-----|-------------|
| `yaar://user/notifications` | Show notification (invoke with `{ id, title, body }`) |
| `yaar://user/notifications/{id}` | Dismiss notification (delete) |
| `yaar://user/prompts` | User prompts (invoke with `{ action: 'ask' \| 'request', ... }`) |
| `yaar://user/clipboard` | Clipboard contents |

---

## Verb Layer

Five verbs. The URI identifies the resource; the verb determines the operation.

| Verb | Semantics | Returns |
|------|-----------|---------|
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

list('yaar://session/agents')                  -> active agents
invoke('yaar://session/agents/agent-1', { action: 'interrupt' })

read('yaar://user/clipboard')                  -> clipboard contents
invoke('yaar://user/notifications', { id: 'n1', title: '...', body: '...' })
delete('yaar://user/notifications/n1')         -> dismiss notification
invoke('yaar://user/prompts', { action: 'ask', title: '...', message: '...', options: [...] })

read('yaar://session/monitors/0')              -> monitor status
read('yaar://session')                         -> session info

describe('yaar://config/settings')             -> { verbs: ['read', 'invoke'], schema: { ... } }
```

HTTP requests also flow through the verb layer: `invoke('yaar://http', { url, ... })`, with domain allowlisting at `invoke('yaar://config/domains', { domain })`.

### MCP Surface

One MCP tool per verb, served from the `verbs` namespace:

| Tool Name | Parameters |
|-----------|------------|
| `describe` | `{ uri }` |
| `read` | `{ uri }` |
| `list` | `{ uri }` |
| `invoke` | `{ uri, payload? }` |
| `delete` | `{ uri }` |

Active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`): `system`, `verbs`, `app`, `messaging`.

---

## ResourceRegistry

Central registry in `packages/server/src/handlers/uri-registry.ts`. Maps URI patterns to handler objects.

```typescript
type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

interface ResourceHandler {
  verbs: Verb[];                 // which verbs this handler supports
  description: string;           // human-readable, returned by `describe`
  invokeSchema?: object;         // JSON Schema for invoke payload (optional)

  read?(parsed: ResolvedUri): Promise<unknown>;
  list?(parsed: ResolvedUri): Promise<{ items: { uri: string; name: string }[] }>;
  invoke?(parsed: ResolvedUri, payload: unknown): Promise<unknown>;
  delete?(parsed: ResolvedUri): Promise<{ deleted: boolean }>;
}
```

Patterns use authority + optional path prefix, matched by specificity (exact > prefix > wildcard):

```
'yaar://config/settings'  -> matches exactly
'yaar://config/'          -> matches yaar://config/ and anything under it
'yaar://config/*'         -> wildcard match under yaar://config/
```

Each domain registers its handlers during server startup (`handlers/config.ts`, `handlers/window.ts`, etc.). For action-bearing resources (browser, agents), the handler dispatches on `payload.action`:

```typescript
// handlers/agents.ts — registered under yaar://session/agents
registry.register('yaar://session/agents/*', {
  verbs: ['read', 'invoke', 'describe'],
  description: 'Agent instance. Read for info, invoke to interrupt.',
  invokeSchema: {
    type: 'object',
    required: ['action'],
    properties: { action: { type: 'string', enum: ['interrupt'] } },
  },
  async read(resolved) { /* ... */ },
  async invoke(resolved, payload) { /* ... */ },
});
```

`ResourceRegistry.execute(verb, uri, payload)` is also the **access-control chokepoint**: it resolves the calling agent's principal role (`session` / `monitor` / `app`) and rejects out-of-tier access before the handler runs.

---

## Where URIs Are Used

**Window content** — `content` fields use `yaar://` URIs; the server resolves them to API paths before sending to the frontend:

```
create({ uri: "slides-lite", title: "Slides Lite", renderer: "iframe", content: "yaar://apps/slides-lite" })
create({ uri: "report", title: "Q4 Report", renderer: "iframe", content: "yaar://storage/reports/q4.pdf" })
```

**Desktop shortcuts** — shortcuts use `yaar://` URIs as their `target`; `extractAppId()` parses app identity from it.

**App discovery API** — `GET /api/apps` returns `run` fields as `yaar://` URIs (custom `run` paths in `app.json` become `yaar://apps/{appId}/{path}`).

## Resolution Helpers

All exported from `@yaar/shared`:

```typescript
resolveContentUri('yaar://apps/slides-lite')      // -> '/api/apps/slides-lite/dist/index.html'
resolveContentUri('yaar://storage/docs/file.txt') // -> '/api/storage/docs/file.txt'

parseFileUri('yaar://storage/docs/file.txt')      // -> { authority: 'storage', path: 'docs/file.txt' }
buildFileUri('storage', 'docs/file.txt')          // -> 'yaar://storage/docs/file.txt'

parseYaarUri('yaar://apps/storage')               // -> { authority: 'apps', path: 'storage' }
buildYaarUri('apps', 'slides-lite')               // -> 'yaar://apps/slides-lite'
extractAppId('yaar://apps/slides-lite')           // -> 'slides-lite'
```

Resolution points: the server resolves iframe content URIs in `features/window/create.ts`; the frontend resolves asset URLs (plus remote-mode auth) in `lib/api.ts`.

## Key Files

| File | Role |
|------|------|
| `packages/shared/src/yaar-uri.ts` | URI parser, builder, resolver for all namespaces |
| `packages/server/src/handlers/uri-registry.ts` | `ResourceRegistry` — central handler registry + principal enforcement |
| `packages/server/src/handlers/uri-resolve.ts` | Server-side typed resolution for all URI namespaces |
| `packages/server/src/handlers/index.ts` | The 5 verb MCP tool definitions |
| `packages/server/src/handlers/{config,window,agents,...}.ts` | Per-namespace handler registration |
| `packages/server/src/http/routes/verb.ts` | `POST /api/verb` — iframe verb access with token + permission checks |
| `packages/frontend/src/lib/api.ts` | Frontend URI resolution + remote auth |

---

## Iframe Verb Access & Token Validation

Iframe apps call verbs via HTTP (`POST /api/verb`), gated by a per-window token and the permission list declared in `app.json`.

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
  "permissions": ["yaar://apps/self/storage/", "yaar://storage/"]
}
```

The verb route (`POST /api/verb`) enforces this:

1. Extract `X-Iframe-Token` header
2. Validate token → get `TokenEntry` (windowId, sessionId, appId, permissions)
3. Check URI against permissions: exact match or prefix match (entries ending in `/`)
4. No match → 403

Apps with no `permissions` field get zero verb access by default.

### `yaar://apps/self/` Resolution

`self` is a shorthand for the app's own appId, resolved server-side from the token entry (403 if the token has no appId):

```
yaar://apps/self/storage/data.json  →  yaar://apps/{actual-appId}/storage/data.json
```

### Iframe SDK

Apps should use `@bundled/yaar` imports (the underlying globals are injected by `IFRAME_VERB_SDK_SCRIPT` from `packages/shared/src/capture-helper.ts`):

| `@bundled/yaar` import | Endpoint |
|-------------------------|----------|
| `invoke(uri, payload?)` | `POST /api/verb` |
| `read(uri)` | `POST /api/verb` |
| `list(uri)` | `POST /api/verb` |
| `describe(uri)` | `POST /api/verb` |
| `del(uri)` | `POST /api/verb` |
| `subscribe(uri, cb)` | `POST /api/verb/subscribe` |

All requests automatically include the `X-Iframe-Token` header. Subscription updates arrive via `postMessage` with type `yaar:subscription-update`, carrying the URI that changed — apps call `read` to fetch the new value.
