# URI & Verb Reference

Precise reference for the `yaar://` URI scheme and the five generic verbs. For the design rationale — why URIs, why five verbs — see [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

All parsing flows through `packages/shared/src/yaar-uri.ts`. Server-side handler registration lives in `packages/server/src/handlers/` (one file per namespace), registered into the `ResourceRegistry` in `handlers/uri-registry.ts`.

---

## URI Space

The `YaarAuthority` type covers ten namespaces:

| Namespace | URI | Description |
|-----------|-----|-------------|
| `apps` | `yaar://apps/{appId}` | App content (resolved to iframe URL), app storage, app DB, an app's own sub-agents |
| `storage` | `yaar://storage/{path}` | Persistent storage file |
| `windows` | `yaar://windows/{windowId}` | Windows (monitor inferred from agent context) |
| `config` | `yaar://config/...` | Settings, hooks, shortcuts, mounts, app credentials |
| `session` | `yaar://session/...` | Session info, agents, monitors, logs, context, browser |
| `user` | `yaar://user/...` | Notifications, prompts |
| `history` | `yaar://history/` | Past session logs (list/read) |
| `skills` | `yaar://skills/{topic}` | Skill topic docs (read before using related tools) |
| `mcp` | `yaar://mcp/...` | External MCP server gateway (add/remove/refresh servers, call their tools) |
| `system` | `yaar://system/update` | The running installation — version check and self-update |

### App sub-agents — `yaar://apps/self/agents`

An app's own sub-agents ("personas") — AI instances whose system prompt the app supplies at
runtime, each a real provider session with its own conversation memory. **Callable only from the
app's own iframe** (`POST /api/verb`), never by an agent and never by another app: the appId in
the URI must equal the appId the calling context says the caller is. Requires
`"subagents": { "max": N }` in `app.json` — honored
as written for a bundled app, and for an installed one only as far as the user approved at install
(`config/app-grants.json`, which caps `max` rather than merely enabling it).
The `yaar://apps/self/storage/`, `yaar://apps/self/db/`, and `yaar://apps/self/agents/`
subtrees are auto-granted (`SELF_GRANTS` in `http/iframe-tokens.ts`) — no `permissions` entry
needed for those specifically. (Other `apps/self/...` resources, and the app resource itself,
are not auto-granted.)

For the invariants these obey see [The Agent Tree](../architecture/agent_tree.md); for the
how-to see the [App Development Guide](../guides/app-development.md#sub-agents-personas).
Handler: `packages/server/src/handlers/apps/agents-resource.ts`.

| Verb | URI | Effect |
|------|-----|--------|
| `list` | `yaar://apps/self/agents` | `{ max, personas: [...] }` — the roster |
| `read` | `yaar://apps/self/agents` | Same as `list` |
| `read` | `yaar://apps/self/agents/{personaId}` | One sub-agent's status + last answer |
| `invoke` | `yaar://apps/self/agents` | `{ action: 'spawn', ... }` (see below) |
| `invoke` | `yaar://apps/self/agents/{personaId}` | `{ action: 'message', content }` or `{ action: 'interrupt' }` |
| `delete` | `yaar://apps/self/agents/{personaId}` | Dispose one → `{ personaId, disposed: 1 }` |
| `delete` | `yaar://apps/self/agents` | Dispose all → `{ disposed: N }` |

**`spawn`** — idempotent: an existing `personaId` comes back with `reused: true` and its prompt
**unchanged** (the prompt is replayed every turn, so rewriting it under a live conversation would
rewrite who the persona has been all along; delete and respawn to recast).

| Field | Type | Notes |
|-------|------|-------|
| `personaId` | `string` | Required. `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `systemPrompt` | `string` | Required, used verbatim. Max 20 000 chars |
| `tools` | `ToolSpec[]` | Optional. Omit for a tool-less sub-agent |
| `model` | `string` | Optional model override |

A `ToolSpec` is `{ name, description, input?: { param: "string" \| "number" \| "boolean" \| "object" \| "array" } }`.
`name` and param names match `[A-Za-z][A-Za-z0-9_]{0,47}`. Limits: 12 tools,
6 000 chars across all names/descriptions/param descriptions (they are replayed every turn).
Calling a tool dispatches the app-protocol command `persona:{name}` to the app's own active
window on its own monitor, with `personaId` stamped into the params **last** so it wins over a
forged argument of the same name; whatever the handler returns becomes the tool result. No open
window is a tool *error*, not a dead turn — and never launches a window.

**Response shape** (same from `list`, `read`, and `spawn`):

| Field | Notes |
|-------|-------|
| `personaId` | The wire spelling of the pool's `subId` |
| `instanceId` | Agent instance id |
| `streamUri` | `yaar://agents/{instanceId}/stream` |
| `busy` | Whether a turn is in flight |
| `createdAt` | Timestamp |
| `model`, `tools`, `lastResponse` | Present only when set (`tools` is names only) |

**`message`** returns as soon as the turn is queued (`{ taskId, personaId, instanceId, streamUri }`),
so N sub-agents generate concurrently. It **rejects rather than queues** when the target is
mid-turn: the error carries `structuredContent: { busy: true, personaId }` so the caller can
branch without parsing the sentence. The answer arrives on `streamUri` — frame kinds `start`,
`text`, `thinking`, `tool`, `usage`, `done` (carries the turn's final text), `error` — which
requires `"streams": ["agents"]` in `app.json`. `read` is the reconnect fallback.

**Errors** are plain refusals, not retryable 503s: a malformed `personaId` or an over-long
prompt is answered before the pool is touched. `at-capacity` means the app's own `max` is
spent; `no-slot` means `MAX_AGENTS` is.

### Windows — `yaar://windows/{windowId}`

The canonical way agents address windows. The monitor is injected automatically from the agent's context.

| URI | Description |
|-----|-------------|
| `yaar://windows/` | Window collection (list, create) |
| `yaar://windows/{windowId}` | Window (read, update, subscribe, message, delete) |

> `yaar://windows/{windowId}/state/{key}` and `yaar://windows/{windowId}/commands/{key}` are
> **not** independently-dispatched resources. `buildWindowResourceUri`
> (`packages/server/src/lib/yaar-uri-server.ts`) attaches these shapes as a cosmetic `uri` label
> on each state/command entry in the app-protocol manifest returned by `app_query` — so an agent
> reading the manifest knows how to *refer to* a given piece of state or a command.
> `packages/server/src/handlers/uri-resolve.ts` does parse the sub-path into
> `ResolvedWindow.subPath`, but the registered `yaar://windows/*` handler
> (`packages/server/src/handlers/window.ts`) never reads it, so `read`/`invoke` on the sub-path
> resolves and executes identically to the base window URI. The real way to read state or run a
> command is `invoke('yaar://windows/{id}', { action: 'app_query', ... })` /
> `invoke('yaar://windows/{id}', { action: 'app_command', ... })`.

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

Session-scoped resources. Most of the namespace is **session-principal** — only the session agent may access it (enforced centrally in `ResourceRegistry.execute()`; monitor/app agents get a 403). `yaar://session/agents` and `yaar://session/agents/*` are the exception: they carry no principal gate, since `relay` is meant to be called by app/window agents (targeting `.../monitor`) and `interrupt`/`delete` are usable by any tier that can name an agent id.

| URI | Description |
|-----|-------------|
| `yaar://session` | Current session info (platform, uptime, stats) |
| `yaar://session/agents` | All active agents. `list` returns two views of the same roster: `agents` (flat) and `tree` (nested by ownership — session → monitor → app → sub-agent). A `tree` node with `id: null` is an owner slot nobody occupies, e.g. an app whose sub-agents exist but whose own agent was never needed. See [The Agent Tree](../architecture/agent_tree.md) |
| `yaar://session/agents/{agentId}` | Agent by instance ID — read for info; invoke with `{ action: 'interrupt' }` (any agent) or `{ action: 'relay', message }` (only on `.../monitor` — hands a message from an app/window agent back to its monitor agent); delete disposes the session agent (`id === 'session'`) or an app agent (by instanceId or appId) |
| `yaar://session/agents/session` | The session agent itself (invoke with `audit` / `coordinate` / `query`) |
| `yaar://session/monitors/{monitorId}` | Monitor status and control (see below) |
| `yaar://session/browser` | The user's real Chrome (the only door to it) |
| `yaar://session/context` | Context state |

Past session logs are **not** under `yaar://session/...` — they're the separate top-level
`history` namespace (see [URI Space](#uri-space) above): `list('yaar://history/')` for links,
`read('yaar://history/')` for summaries, and `read('yaar://history/{id}')` /
`read('yaar://history/{id}/transcript')` / `read('yaar://history/{id}/messages')` for detail.
Handler: `packages/server/src/handlers/history.ts`.

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
| `yaar://user/clipboard` | **Not yet implemented.** The `clipboard` sub-kind is recognized by URI parsing (`packages/server/src/lib/yaar-uri-server.ts`), but no handler is registered for it in `packages/server/src/handlers/user.ts` — invoking it resolves to "no handler found." |

### System — `yaar://system/...`

The running installation itself, rather than anything inside a session. Not session-principal:
an app that declares the permission can call it (the Configurations app does — this is what its
**Updates** tab renders), and so can every agent tier.

| URI | Verb | Description |
|-----|------|-------------|
| `yaar://system` | `list` | Enumerate system resources |
| `yaar://system/update` | `read` | Running version, build shape, last check result, live install progress. **Never touches the network** — safe to poll |
| `yaar://system/update` | `invoke` `{ action: 'check', force? }` | Ask GitHub for the latest release. Cached 5 minutes; `force` bypasses the cache |
| `yaar://system/update` | `invoke` `{ action: 'install' }` | Download the latest release, verify it against the release's `SHA256SUMS`, and swap it in. Returns once the work has *started* — poll `read` for the outcome |

`install` refuses synchronously (rather than failing later in the progress state) when there is
nothing to install, when GitHub was unreachable, or when this build cannot install updates at all
— only the standalone executable can replace itself, so a source checkout is told to use
`git pull` and a platform with no published binary is told to build from source. A checksum
mismatch, or a release with no `SHA256SUMS`, is a hard failure: nothing unverified is installed.
Installing never restarts YAAR; the user does that.

**Source:** `packages/server/src/features/update/`, `packages/server/src/handlers/system.ts`

---

## Verb Layer

Five verbs. The URI identifies the resource; the verb determines the operation.

| Verb | Semantics | Returns |
|------|-----------|---------|
| `describe` | Schema + capabilities of a URI (which verbs it supports, payload shape) | `{ uri, description, verbs, invokeSchema? }` |
| `read` | Get current state of a resource | Resource-specific data |
| `list` | Enumerate children of a collection URI | MCP `resource_link` content blocks, one per child (`{ uri, name, description?, mimeType?, kind?, version? }`) — not a JSON object with an `items` key |
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
invoke('yaar://session/agents/monitor', { action: 'relay', message: '...' })  -> app/window agent hands a message back to its monitor agent
delete('yaar://session/agents/session')        -> dispose the session agent
delete('yaar://session/agents/notes')          -> dispose the "notes" app's agent

invoke('yaar://user/notifications', { id: 'n1', title: '...', body: '...' })
delete('yaar://user/notifications/n1')         -> dismiss notification
invoke('yaar://user/prompts', { action: 'ask', title: '...', message: '...', options: [...] })

read('yaar://session/monitors/0')              -> monitor status
read('yaar://session')                         -> session info

describe('yaar://config/settings')             -> { verbs: ['describe', 'read', 'invoke'], invokeSchema: { ... } }
```

HTTP requests also flow through the verb layer: `invoke('yaar://http', { url, ... })`, with domain allowlisting at `invoke('yaar://config/domains', { domain })`. `delete('yaar://http')` clears the caller's stored cookie jar (use on app logout).

### MCP Surface

One MCP tool per verb, served from the `verbs` namespace:

| Tool Name | Parameters |
|-----------|------------|
| `describe` | `{ uri }` |
| `read` | `{ uri }` |
| `list` | `{ uri }` |
| `invoke` | `{ uri, payload? }` |
| `delete` | `{ uri }` |

Active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`): `system`, `verbs`, `app`, `messaging`, `subagent`.

---

## ResourceRegistry

Central registry in `packages/server/src/handlers/uri-registry.ts`. Maps URI patterns to handler objects.

```typescript
type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

interface ResourceHandler {
  description: string;           // human-readable, returned by `describe`
  verbs: Verb[];                 // which verbs this handler supports (describe is always auto-generated)
  invokeSchema?: Record<string, unknown>;  // JSON Schema for invoke payload (optional)
  access?: 'session-principal';  // when set, only the session agent may call any verb (403 for others)

  describe?(resolved: ResolvedUri): Promise<VerbResult>;  // custom describe; overrides auto-generation
  read?(resolved: ResolvedUri, options?: ReadOptions): Promise<VerbResult>;
  list?(resolved: ResolvedUri): Promise<VerbResult>;
  invoke?(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult>;
  delete?(resolved: ResolvedUri): Promise<VerbResult>;
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
invoke('yaar://windows/', { action: "create", title: "Slides Lite", renderer: "iframe", content: "yaar://apps/slides-lite" })
invoke('yaar://windows/', { action: "create", title: "Q4 Report", renderer: "iframe", content: "yaar://storage/reports/q4.pdf" })
```

(There is no `uri` field in the create payload — `handleCreate` derives the window id from
`appId`/`name`/`title` via `deriveWindowId`, and the `content` field carries the `yaar://` URI.)

**Desktop shortcuts** — shortcuts use `yaar://` URIs as their `target`; `extractAppId()` parses app identity from it.

**App discovery API** — `GET /api/apps` returns `run` fields as `yaar://` URIs (custom `run` paths in `app.json` become `yaar://apps/{appId}/{path}`).

## Resolution Helpers

All exported from `@yaar/shared`:

```typescript
resolveContentUri('yaar://apps/slides-lite')      // -> '/api/apps/slides-lite/dist/index.html'
resolveContentUri('yaar://storage/docs/file.txt') // -> '/api/storage/docs/file.txt'

parseFileUri('yaar://storage/docs/file.txt')      // -> { authority: 'storage', path: 'docs/file.txt' }

parseYaarUri('yaar://apps/storage')               // -> { authority: 'apps', path: 'storage' }
buildYaarUri('apps', 'slides-lite')               // -> 'yaar://apps/slides-lite'
buildYaarUri('storage', 'docs/file.txt')          // -> 'yaar://storage/docs/file.txt'
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
  "permissions": ["yaar://storage/"]
}
```

The verb route (`POST /api/verb`) enforces this:

1. Extract `X-Iframe-Token` header
2. Validate token → get `TokenEntry` (windowId, sessionId, appId, permissions)
3. Check URI against permissions: exact match or prefix match (entries ending in `/`)
4. No match → 403

Apps with no `permissions` field still get the auto-granted `yaar://apps/self/{storage,db,agents}/`
subtrees (`SELF_GRANTS`), and `describe` is always allowed on any URI regardless of permissions
(metadata-only). Everything else — `read`/`list`/`invoke`/`delete` on any other resource — needs
an explicit `permissions` entry.

### `yaar://apps/self/` Resolution

`self` is a shorthand for the app's own appId, resolved server-side from the token entry (403 if the token has no appId):

```
yaar://apps/self/storage/data.json  →  yaar://apps/{actual-appId}/storage/data.json
```

### Iframe SDK

Apps should use `@bundled/yaar` imports (the underlying globals are injected by `IFRAME_VERB_SDK_SCRIPT` from `packages/shared/src/iframe-scripts/verb-sdk.ts`, re-exported via `packages/shared/src/iframe-scripts/index.ts` and `packages/shared/src/index.ts`):

| `@bundled/yaar` import | Endpoint |
|-------------------------|----------|
| `invoke(uri, payload?)` | `POST /api/verb` |
| `read(uri)` | `POST /api/verb` |
| `list(uri)` | `POST /api/verb` |
| `describe(uri)` | `POST /api/verb` |
| `del(uri)` | `POST /api/verb` |
| `subscribe(uri, cb)` | `POST /api/verb/subscribe` |

All requests automatically include the `X-Iframe-Token` header. Subscription updates arrive via `postMessage` with type `yaar:subscription-update`, carrying the URI that changed — apps call `read` to fetch the new value.
