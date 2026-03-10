# URI-Based Resource Addressing

## Summary

`yaar://` is a unified URI scheme for addressing all internal resources: content (apps, storage, sandbox), windows, configuration, browser instances, and session state (agents, notifications, prompts, monitors).

Every stable, inspectable entity gets a URI. Five generic verbs (`describe`, `read`, `list`, `invoke`, `delete`) replace individual MCP tools.

---

## Design Principles

1. **URI = identity, not behavior.** A URI identifies a stable thing (a window, a config key, a browser page). Actions like "click" or "navigate" are not resources — they belong in the `invoke` payload, not the URI path.

2. **Logical resources, not raw files.** `yaar://config/settings` maps to the settings domain model with validation — not to `config/settings.json` as arbitrary file I/O.

3. **Session-relative root.** `yaar://` is scoped to the current session.

4. **Actions live in the payload.** If something can only be `invoke`d but never `read` or `list`ed, it's not a resource — it's an action on a resource. Pass it as `{ action: 'navigate', ... }` in the invoke payload.

5. **Session-scoped resources live under `yaar://sessions/`.** Agents, notifications, prompts, clipboard, and monitors are facets of the current session — not independent top-level namespaces.

---

## URI Space

All parsing flows through `packages/shared/src/yaar-uri.ts`. The `YaarAuthority` type covers seven namespaces. Server-side resolution is in `packages/server/src/uri/resolve.ts`.

### Content Resources

| Namespace | URI | Description |
|-----------|-----|-------------|
| `apps` | `yaar://apps/{appId}` | App content (resolved to iframe URL) |
| `storage` | `yaar://storage/{path}` | Persistent storage file |
| `sandbox` | `yaar://sandbox/{sandboxId}/{path}` | Sandbox file |
| `sandbox` | `yaar://sandbox/new/{path}` | New sandbox (write/edit only) |

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
| `yaar://sessions/current/monitors/{monitorId}` | Monitor status (main agent, window list, queue stats) |
| `yaar://sessions/current/logs` | Session logs |
| `yaar://sessions/current/context` | Context state |

---

## Implementation Status

### Done

- **URI parsing and building** for all seven authorities (`apps`, `storage`, `sandbox`, `windows`, `monitors`, `config`, `browser`, `sessions`) in `@yaar/shared`
- **Session sub-resource parsing** — `parseSessionUri()` handles deep paths (`yaar://sessions/current/agents/{id}/interrupt`) via `SessionSubKind` discriminant
- **Server-side resolution** (`resolveUri`, `resolveResourceUri`) mapping URIs to filesystem paths, window addresses, and typed metadata
- **Content resolution** — `resolveContentUri()` maps content URIs to API paths, used by window creation and file-serving
- **Window URIs** — `buildWindowUri` used in window list/lifecycle tools; window resource URIs for app-protocol state/commands
- **File-operation URIs** — `parseFileUri`/`buildFileUri` used by basic MCP tools (read, write, edit, list, delete)
- **Legacy compat** — `storage://` and `sandbox://` legacy schemes still accepted by `parseFileUri`

### Verb Layer (Done — All Domains)

- **ResourceRegistry** (`uri/registry.ts`) — central registry matching URI patterns to handlers (exact > prefix > wildcard priority)
- **5 verb MCP tools** (`mcp/verbs/`) — `describe`, `read`, `list`, `invoke`, `delete` registered as the `verbs` MCP server
- **Config domain handlers** (`mcp/config/handlers.ts`) — settings, hooks, shortcuts, mounts, app config
- **Basic domain handlers** (`mcp/basic/handlers.ts`) — storage and sandbox file I/O (read, write, edit, list, delete) via `yaar://storage/*` and `yaar://sandbox/*`
- **Window domain handlers** (`mcp/window/handlers.ts`) — create, update, manage, list, view, app_query, app_command via `yaar://windows/*` with action-dispatched invoke
- **Session domain handlers** — agents (`mcp/agents/handlers.ts`), notifications/prompts (`mcp/user/handlers.ts`), system info/memorize (`mcp/system/handlers.ts`) via `yaar://sessions/current/*`
- **Apps domain handlers** (`mcp/apps/handlers.ts`) — list apps, load skill, set badge, marketplace install/uninstall via `yaar://apps/*`
- **Browser domain handlers** (`mcp/browser/handlers.ts`) — `yaar://browser/*` handler with action-dispatched invoke (open, navigate, click, type, press, scroll, hover, wait_for, screenshot, extract)
- Legacy tools have been removed — verb mode is now the only mode

---

## Strengths

1. **Dramatic tool reduction.** ~30 individual MCP tools collapse into 5 generic verbs. The AI learns one interaction pattern instead of memorizing tool-specific schemas — less prompt surface, fewer mistakes.

2. **Self-describing API.** `describe(uri)` gives the AI runtime discovery of any resource's capabilities and payload schema. No need to hardcode tool documentation in the system prompt for every domain.

3. **Uniform addressing.** Every resource — config, windows, browser pages, agents, storage — uses the same `yaar://` scheme. The AI can reason about resources compositionally (e.g., "read this, then invoke that") without switching between unrelated tool APIs.

4. **Clean migration.** Domain handlers wrap existing business logic functions — no logic duplication, no rewrite. Each domain migrated independently.

5. **Pattern-based extensibility.** Adding a new resource type means registering a handler with a URI pattern. No changes to the verb tools, MCP server setup, or system prompt. The registry's priority system (exact > prefix > wildcard) handles specificity automatically.

6. **Composable for agents.** A single verb vocabulary makes it trivial for agents to chain operations: `describe` to discover, `list` to enumerate, `read` to inspect, `invoke` to act, `delete` to clean up. This is particularly powerful for multi-step workflows where the agent navigates an unfamiliar resource tree.

7. **Testable in isolation.** The `ResourceRegistry` is a pure data structure with no MCP dependency — handlers can be unit-tested without spinning up an MCP server.

8. **Session-scoped coherence.** Agents, notifications, prompts, clipboard, and monitors are all sub-resources of `yaar://sessions/current/` — reflecting the reality that they're facets of a single session, not independent systems. This reduces the top-level namespace count (9 → 7) and makes the URI tree self-documenting.

---

## Verb Layer

Five verbs. The URI identifies the resource, the verb determines the operation, and the payload carries action-specific data.

| Verb | Semantics | Returns |
|------|-----------|---------
| `describe` | Schema + capabilities of a URI (which verbs it supports, payload shape) | `{ verbs, schema?, description }` |
| `read` | Get current state of a resource | Resource-specific data |
| `list` | Enumerate children of a collection URI | `{ items: { uri, name, ... }[] }` |
| `invoke` | Mutate, create, or trigger — the universal write/action verb | Resource-specific result |
| `delete` | Remove a resource | `{ deleted: true }` |

`invoke` covers both data mutation (idempotent merges like config updates) and side-effecting actions (browser navigate, agent interrupt). The URI identifies *what* is being acted on; the payload's `action` field (when needed) specifies *how*.

### The Action Rule

**If you can meaningfully `read` it, it belongs in the URI path. If you can only `invoke` it, it's a payload action.**

Resources like `yaar://config/settings` or `yaar://browser/0` are things you can read, describe, and invoke. But "navigate" or "click" are actions *on* the browser resource — not resources themselves. They go in the invoke payload:

```
invoke('yaar://browser/0', { action: 'navigate', url: '...' })
invoke('yaar://sessions/current/agents/agent-1', { action: 'interrupt' })
```

Sub-resources that are genuinely addressable (like window state keys) stay in the URI:

```
read('yaar://windows/win-1/state/theme')     -- this IS a readable resource
```

### Examples

```
read('yaar://config/settings')                          -> { theme: 'dark', ... }
invoke('yaar://config/settings', { theme: 'light' })    -> merge into settings
delete('yaar://config/app/github')                      -> remove app config

read('yaar://windows/win-1')                            -> window state
invoke('yaar://windows/', { action: 'create', title: 'Notes', renderer: 'markdown', content: '# Hello' })
invoke('yaar://windows/win-1', { action: 'update', operation: 'append', content: '...' })
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

One MCP tool per verb, replacing the ~30 individual tools:

| Tool Name | Parameters |
|-----------|------------|
| `describe` | `{ uri }` |
| `read` | `{ uri }` |
| `list` | `{ uri }` |
| `invoke` | `{ uri, payload? }` |
| `delete` | `{ uri }` |

The AI prompt includes the URI space reference (same table as above), so the model knows which URIs exist. `describe` serves as runtime discovery — the AI can call `describe('yaar://browser/0')` to see available actions and their schemas.

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

Each domain registers its handlers during server startup. Handlers live alongside existing tool code — no rewrite needed, just wiring.

```typescript
// mcp/config/handlers.ts
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
// mcp/agents/handlers.ts — registered under yaar://sessions/current/agents
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

### Migration Path

Existing MCP tools stay functional — the verb layer is additive. Migration per domain:

1. **Write handlers** for the domain's resources alongside existing tool files
2. **Register handlers** in `initRegistry()` (`mcp/verbs/index.ts`)
3. Both old tools and new verbs coexist — `verbMode` toggle controls which set the AI sees
4. Once verb mode is validated via A/B comparison, individual tools can be deprecated (keep as aliases initially)

All domains now have verb handlers:

| # | Domain | Legacy Tools | Verb Handlers | Status |
|---|--------|-------------|---------------|--------|
| 1 | `basic/` | read, write, list, edit, delete | `storage/*`, `sandbox/*` | Done |
| 2 | `window/` | create, update, manage, list, view, info | `windows/*` | Done |
| 3 | `config/` | set, get, remove | `config/*` (settings, hooks, shortcuts, mounts, app) | Done |
| 4 | `user/` | ask, request | `sessions/current/notifications`, `sessions/current/prompts` | Done |
| 5 | `apps/` | list, load_skill, set_badge, market ops | `apps/*` | Done |
| 6 | `system/` | get_info, memorize | `sessions/current`, `yaar://` root | Done |
| 7 | `browser/` | open, click, type, press, scroll, navigate, hover, wait_for, screenshot, extract, list, close | `browser/*` (action-dispatched invoke) | Done |
| 8 | `agents/` | _(no legacy tools)_ | `sessions/current/agents/*` (list, read, interrupt) | Done |

#### Remaining migration work

- **A/B validation** — collect structured tool logs (`logToolResult` with `meta`) across verb-mode and legacy sessions, compare error rates and task completion
- **Legacy tool deprecation** — verb mode is now the primary interface; legacy tools are deprecated and kept as aliases behind `verbMode: false`
- **Dev tools** (`dev/compile`, `dev/typecheck`, `dev/deploy`, `dev/clone`) — verb-ified via `yaar://sandbox/{id}` invoke with `action` param (in `verbs/handlers/basic.ts`). Done.
- **System tools** — split into two categories:
  - **Verb-ified (removed from VERB_TOOLS — verb equivalents are primary):** `run_js` → `invoke('yaar://sandbox/eval')`, `relay_to_main` → `invoke('yaar://sessions/current/agents/main', { action: 'relay' })`, `show_notification` → `invoke('yaar://sessions/current/notifications')`, `skill` → `read('yaar://skills/{topic}')`, `INFO_TOOLS` (get_info, memorize) → `read('yaar://sessions/current')` / `invoke('yaar://sessions/current', { action: 'memorize' })`
  - **Staying as named system tools (not being verb-ified):** `http_get`, `http_post`, `request_allowing_domain`, `reload_cached`, `list_reload_options` — these remain as always-active system namespace tools in both modes
- **Storage tools** (`mount`, `unmount`, `list_mounts`) — already covered via `config/mounts` handlers. Done.
