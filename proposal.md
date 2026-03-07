# URI-Based Resource Addressing

## Summary

`yaar://` is a unified URI scheme for addressing all internal resources: content (apps, storage, sandbox), windows, configuration, browser instances, agents, user state, and sessions.

Every stable, inspectable entity gets a URI. Five generic verbs (`describe`, `read`, `list`, `invoke`, `delete`) replace individual MCP tools.

---

## Design Principles

1. **URI = identity, not behavior.** A URI identifies a stable thing (a window, a config key, a browser page). Actions like "click" or "ask the user" are not resources.

2. **Logical resources, not raw files.** `yaar://config/settings` maps to the settings domain model with validation — not to `config/settings.json` as arbitrary file I/O.

3. **Session-relative root.** `yaar://` is scoped to the current session.

---

## URI Space

All parsing flows through `packages/shared/src/yaar-uri.ts`. The `YaarAuthority` type covers all nine namespaces. Server-side resolution is in `packages/server/src/uri/resolve.ts`.

### Content Resources

| Namespace | URI | Description |
|-----------|-----|-------------|
| `apps` | `yaar://apps/{appId}` | App content (resolved to iframe URL) |
| `storage` | `yaar://storage/{path}` | Persistent storage file |
| `sandbox` | `yaar://sandbox/{sandboxId}/{path}` | Sandbox file |
| `sandbox` | `yaar://sandbox/new/{path}` | New sandbox (write/edit only) |

Content URIs resolve to filesystem paths via `resolveResourceUri()` and to API paths via `resolveContentUri()`.

### Windows — `yaar://monitors/{monitorId}/...`

| URI | Description |
|-----|-------------|
| `yaar://monitors/{monitorId}/{windowId}` | Window on a monitor |
| `yaar://monitors/{monitorId}/{windowId}/state/{key}` | Window state (app-protocol) |
| `yaar://monitors/{monitorId}/{windowId}/commands/{key}` | Window command (app-protocol) |

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

### Browser — `yaar://browser/{browserId}/...`

| URI | Description |
|-----|-------------|
| `yaar://browser/{browserId}` | Browser instance state (URL, title) — `read` |
| `yaar://browser/{browserId}/content` | Page content — `read` |
| `yaar://browser/{browserId}/screenshot` | Page screenshot — `read` |
| `yaar://browser/{browserId}/navigate` | Navigate to URL — `invoke` only |
| `yaar://browser/{browserId}/click` | Click element — `invoke` only |

### Agents — `yaar://agents/...`

| URI | Description |
|-----|-------------|
| `yaar://agents/` | All active agents |
| `yaar://agents/{agentId}` | Agent by instance ID |
| `yaar://agents/{agentId}/interrupt` | Interrupt agent |

Agents are addressed by instance ID only — no category prefixes.

### User — `yaar://user/...`

| URI | Description |
|-----|-------------|
| `yaar://user/notifications` | Notification list |
| `yaar://user/notifications/{id}` | Individual notification |
| `yaar://user/prompts` | Pending prompts |
| `yaar://user/prompts/{id}` | Individual prompt |
| `yaar://user/clipboard` | Clipboard contents |

### Sessions — `yaar://sessions/...`

| URI | Description |
|-----|-------------|
| `yaar://sessions/current` | Current session |
| `yaar://sessions/current/logs` | Session logs |
| `yaar://sessions/current/context` | Context state |

---

## Implementation Status

### Done

- **URI parsing and building** for all nine authorities (`apps`, `storage`, `sandbox`, `monitors`, `config`, `browser`, `agents`, `user`, `sessions`) in `@yaar/shared`
- **Server-side resolution** (`resolveUri`, `resolveResourceUri`) mapping URIs to filesystem paths, window addresses, and typed metadata
- **Content resolution** — `resolveContentUri()` maps content URIs to API paths, used by window creation and file-serving
- **Window URIs** — `buildWindowUri` used in window list/lifecycle tools; window resource URIs for app-protocol state/commands
- **File-operation URIs** — `parseFileUri`/`buildFileUri` used by basic MCP tools (read, write, edit, list, delete)
- **Legacy compat** — `storage://` and `sandbox://` legacy schemes still accepted by `parseFileUri`

### Not Yet Implemented

- **Generic verb layer** (`describe`, `read`, `list`, `invoke`, `delete`) — URIs exist as addresses but operations are still done through individual MCP tools
- **ResourceRegistry** — central registry matching URI patterns to handlers with schema validation
- **Monitor-as-resource** — reading `yaar://monitors/{id}/` as a status object (queue, budget, agent info)
- **Session root** — reading `yaar://` for session overview

---

## Verb Layer

Five verbs. The URI determines behavior, the verb determines the operation shape.

| Verb | Semantics | Returns |
|------|-----------|---------|
| `describe` | Schema + capabilities of a URI (which verbs it supports, payload shape) | `{ verbs, schema?, description }` |
| `read` | Get current state of a resource | Resource-specific data |
| `list` | Enumerate children of a collection URI | `{ items: { uri, name, ... }[] }` |
| `invoke` | Mutate, create, or trigger — the universal write/action verb | Resource-specific result |
| `delete` | Remove a resource | `{ deleted: true }` |

`invoke` covers both data mutation (idempotent merges like config updates) and side-effecting actions (browser navigate, agent interrupt). The URI's resource handler decides the semantics.

### Examples

```
read('yaar://config/settings')                          → { theme: 'dark', ... }
invoke('yaar://config/settings', { theme: 'light' })    → merge into settings
delete('yaar://config/app/github')                      → remove app config

read('yaar://monitors/0/win-1')                         → window state
invoke('yaar://monitors/0/win-1/commands/refresh', {})  → app-protocol command

read('yaar://browser/0')                                → { url, title }
invoke('yaar://browser/0/navigate', { url: '...' })     → navigate

list('yaar://agents/')                                  → active agents
invoke('yaar://agents/agent-1/interrupt')               → interrupt agent

read('yaar://user/clipboard')                           → clipboard contents
invoke('yaar://user/notifications', { title, body })    → show notification
delete('yaar://user/notifications/abc')                 → dismiss notification

describe('yaar://config/settings')                      → { verbs: ['read', 'invoke'], schema: { ... } }
```

### MCP Surface

One MCP tool per verb, replacing the ~30 individual tools:

| Tool Name | Parameters |
|-----------|------------|
| `describe` | `{ uri }` |
| `read` | `{ uri }` |
| `list` | `{ uri }` |
| `invoke` | `{ uri, payload? }` |
| `delete` | `{ uri }` |

The AI prompt includes the URI space reference (same table as above), so the model knows which URIs exist. `describe` serves as runtime discovery — the AI can call `describe('yaar://config/')` to see available sub-resources and their schemas.

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
   *   'config/settings'  → matches yaar://config/settings
   *   'config/app/*'     → matches yaar://config/app/{appId}
   *   'browser/*/navigate' → matches yaar://browser/{id}/navigate
   *   'agents'           → matches yaar://agents/ and yaar://agents/{id}
   */
  register(pattern: string, handler: ResourceHandler): void;

  /**
   * Resolve a URI to its handler. Returns the best-matching handler
   * by specificity (exact > prefix > wildcard).
   */
  resolve(uri: string): { handler: ResourceHandler; parsed: ResolvedUri } | null;

  /**
   * Execute a verb on a URI. Throws if verb not supported.
   */
  async execute(verb: Verb, uri: string, payload?: unknown): Promise<unknown>;
}
```

### Handler Registration

Each MCP domain folder registers its handlers during server startup. Handlers live alongside existing tool code — no rewrite needed, just wiring.

```typescript
// mcp/system/config-handlers.ts
export function registerConfigHandlers(registry: ResourceRegistry) {
  registry.register('config/settings', {
    verbs: ['read', 'invoke', 'describe'],
    description: 'User settings (theme, locale, etc.)',
    invokeSchema: { type: 'object', properties: { theme: { type: 'string' } } },
    async read() { return getConfig('settings'); },
    async invoke(_, payload) { return setConfig('settings', payload); },
  });

  registry.register('config/app/*', {
    verbs: ['read', 'invoke', 'delete', 'describe'],
    description: 'Per-app configuration and credentials',
    async read(parsed) {
      const { id } = parsed as ResolvedConfig;
      return getConfig('app', id);
    },
    async invoke(parsed, payload) {
      const { id } = parsed as ResolvedConfig;
      return setConfig('app', id, payload);
    },
    async delete(parsed) {
      const { id } = parsed as ResolvedConfig;
      return removeConfig(id);
    },
  });
}
```

### Migration Path

Existing MCP tools stay functional — the verb layer is additive. Migration per domain:

1. **Write handlers** for the domain's resources alongside existing tool files
2. **Register handlers** in the domain's `register*Tools()` function
3. **Wire MCP verb tools** to `ResourceRegistry.execute()` in `mcp/server.ts`
4. Once all domains covered, individual tools can be deprecated (keep as aliases initially)

Domain priority (by tool count reduced):
1. `basic/` (read, write, list, edit, delete) → `storage/*`, `sandbox/*` handlers
2. `window/` (create, update, manage, list, view, info) → `monitors/*` handlers
3. `system/` (config CRUD, notifications) → `config/*`, `user/*` handlers
4. `browser/` (navigate, click, screenshot, etc.) → `browser/*` handlers
5. `agents/` → `agents/*` handlers
6. `apps/` → `apps/*` handlers
