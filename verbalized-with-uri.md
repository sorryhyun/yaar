# URI-Based Resource Addressing

## Summary

`yaar://` is a unified URI scheme for addressing all internal resources: content (apps, storage, sandbox), windows, configuration, browser instances, agents, user state, and sessions.

Every stable, inspectable entity gets a URI. Five generic verbs (`describe`, `read`, `list`, `invoke`, `delete`) replace individual MCP tools.

---

## Design Principles

1. **URI = identity, not behavior.** A URI identifies a stable thing (a window, a config key, a browser page). Actions like "click" or "navigate" are not resources — they belong in the `invoke` payload, not the URI path.

2. **Logical resources, not raw files.** `yaar://config/settings` maps to the settings domain model with validation — not to `config/settings.json` as arbitrary file I/O.

3. **Session-relative root.** `yaar://` is scoped to the current session.

4. **Actions live in the payload.** If something can only be `invoke`d but never `read` or `list`ed, it's not a resource — it's an action on a resource. Pass it as `{ action: 'navigate', ... }` in the invoke payload.

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

### Agents — `yaar://agents/...`

| URI | Description |
|-----|-------------|
| `yaar://agents/` | All active agents |
| `yaar://agents/{agentId}` | Agent by instance ID (interrupt via `invoke` with `action`) |

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

### Verb Layer (Done — All Domains Except Browser)

- **ResourceRegistry** (`uri/registry.ts`) — central registry matching URI patterns to handlers (exact > prefix > wildcard priority)
- **5 verb MCP tools** (`mcp/verbs/`) — `describe`, `read`, `list`, `invoke`, `delete` registered as the `verbs` MCP server
- **Config domain handlers** (`mcp/config/handlers.ts`) — settings, hooks, shortcuts, mounts, app config
- **Basic domain handlers** (`mcp/basic/handlers.ts`) — storage and sandbox file I/O (read, write, edit, list, delete) via `yaar://storage/*` and `yaar://sandbox/*`
- **Window domain handlers** (`mcp/window/handlers.ts`) — create, update, manage, list, view, app_query, app_command via `yaar://monitors/*` with action-dispatched invoke
- **User domain handlers** (`mcp/user/handlers.ts`) — notifications (show/dismiss) and prompts (ask/request) via `yaar://user/notifications` and `yaar://user/prompts`
- **Apps domain handlers** (`mcp/apps/handlers.ts`) — list apps, load skill, set badge, marketplace install/uninstall via `yaar://apps/*`
- **Sessions domain handlers** (`mcp/system/handlers.ts`) — system info and memorize via `yaar://sessions/current`
- Both old tools and new verbs work simultaneously — no breaking changes

### Verb Mode Toggle (Done)

- **Settings toggle** — `verbMode: boolean` in `config/settings.json` (default `false`), exposed in Settings modal as "Verb Mode (Experimental)"
- **MCP server filtering** — when `verbMode` is on, provider connects to only `system` + `verbs` MCP servers (not all 9). `getActiveServers(verbMode)` and `getToolNames(verbMode)` control which tools are available.
- **Warm pool restart** — changing `verbMode` in settings triggers `cleanup()` + `initialize()` so new providers reflect the toggle immediately
- **Structured tool logging** — `logToolResult()` now accepts optional `meta: { isError, errorCategory, durationMs }`. `StreamToEventMapper` tracks tool_use start times, computes duration on tool_result, classifies errors (`uri_not_found`, `verb_not_supported`, `validation`, `handler_error`, `unknown`).
- **Session metadata** — `metadata.json` includes `verbMode` flag for post-hoc A/B comparison across sessions
- **Legacy tools must be maintained** — verb mode is experimental. All ~30 legacy MCP tools remain the production path and must not be removed or degraded until verb mode has been verified across all domains via A/B comparison data

### Not Yet Implemented

- **Browser domain handlers** — `browser/*` handler with action-dispatched invoke (navigate, click, type, screenshot, etc.). Conditional on Chrome availability.
- **Monitor-as-resource** — reading `yaar://monitors/{id}/` as a status object (queue, budget, agent info)
- **Session root** — reading `yaar://` for session overview
- **Agents domain handlers** — `agents/*` handler (list active agents, interrupt via invoke)

---

## Strengths

1. **Dramatic tool reduction.** ~30 individual MCP tools collapse into 5 generic verbs. The AI learns one interaction pattern instead of memorizing tool-specific schemas — less prompt surface, fewer mistakes.

2. **Self-describing API.** `describe(uri)` gives the AI runtime discovery of any resource's capabilities and payload schema. No need to hardcode tool documentation in the system prompt for every domain.

3. **Uniform addressing.** Every resource — config, windows, browser pages, agents, storage — uses the same `yaar://` scheme. The AI can reason about resources compositionally (e.g., "read this, then invoke that") without switching between unrelated tool APIs.

4. **Zero-disruption migration.** Old tools and new verbs coexist. Domain handlers wrap existing functions — no logic duplication, no rewrite. Each domain migrates independently at its own pace.

5. **Pattern-based extensibility.** Adding a new resource type means registering a handler with a URI pattern. No changes to the verb tools, MCP server setup, or system prompt. The registry's priority system (exact > prefix > wildcard) handles specificity automatically.

6. **Composable for agents.** A single verb vocabulary makes it trivial for agents to chain operations: `describe` to discover, `list` to enumerate, `read` to inspect, `invoke` to act, `delete` to clean up. This is particularly powerful for multi-step workflows where the agent navigates an unfamiliar resource tree.

7. **Testable in isolation.** The `ResourceRegistry` is a pure data structure with no MCP dependency — handlers can be unit-tested without spinning up an MCP server.

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
invoke('yaar://browser/0', { action: 'navigate', url: '...' })    -- not yaar://browser/0/navigate
invoke('yaar://agents/agent-1', { action: 'interrupt' })           -- not yaar://agents/agent-1/interrupt
```

Sub-resources that are genuinely addressable (like window state keys) stay in the URI:

```
read('yaar://monitors/0/win-1/state/theme')     -- this IS a readable resource
```

### Examples

```
read('yaar://config/settings')                          -> { theme: 'dark', ... }
invoke('yaar://config/settings', { theme: 'light' })    -> merge into settings
delete('yaar://config/app/github')                      -> remove app config

read('yaar://monitors/0/win-1')                         -> window state
invoke('yaar://monitors/0/win-1', { action: 'command', name: 'refresh' })

read('yaar://browser/0')                                -> { url, title }
invoke('yaar://browser/0', { action: 'navigate', url: '...' })
invoke('yaar://browser/0', { action: 'click', selector: '#btn' })
invoke('yaar://browser/0', { action: 'screenshot' })

list('yaar://agents/')                                  -> active agents
invoke('yaar://agents/agent-1', { action: 'interrupt' })

read('yaar://user/clipboard')                           -> clipboard contents
invoke('yaar://user/notifications', { title: '...', body: '...' })
delete('yaar://user/notifications/abc')                 -> dismiss notification

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

Each domain registers its handlers during server startup. Only the config domain is wired so far. Handlers live alongside existing tool code — no rewrite needed, just wiring.

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
// future: mcp/browser/handlers.ts
registry.register('yaar://browser/*', {
  verbs: ['read', 'invoke', 'describe'],
  description: 'Browser instance — read state, invoke actions (navigate, click, type, screenshot)',
  invokeSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['navigate', 'click', 'type', 'screenshot'] },
      url: { type: 'string' },
      selector: { type: 'string' },
      text: { type: 'string' },
    },
  },
  async read(parsed) { return getBrowserState(parsed.id); },
  async invoke(parsed, payload) {
    switch (payload.action) {
      case 'navigate': return browserNavigate(parsed.id, payload.url);
      case 'click': return browserClick(parsed.id, payload.selector);
      // ...
    }
  },
});
```

### Migration Path

Existing MCP tools stay functional — the verb layer is additive. Migration per domain:

1. **Write handlers** for the domain's resources alongside existing tool files
2. **Register handlers** in the domain's `register*Tools()` function
3. **Wire MCP verb tools** to `ResourceRegistry.execute()` in `mcp/server.ts`
4. Once all domains covered, individual tools can be deprecated (keep as aliases initially)

Domain priority (by tool count reduced):
1. `basic/` (read, write, list, edit, delete) -> `storage/*`, `sandbox/*` handlers  ✅
2. `window/` (create, update, manage, list, view, info) -> `monitors/*` handlers  ✅
3. `system/` (config CRUD, notifications) -> `config/*`, `user/*` handlers  ✅
4. `browser/` (navigate, click, screenshot, etc.) -> `browser/*` handler (single handler, action-dispatched)
5. `agents/` -> `agents/*` handler (single handler, action-dispatched)
6. `apps/` -> `apps/*` handlers  ✅
