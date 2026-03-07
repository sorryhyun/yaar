# URI-Based Resource Addressing

YAAR uses a unified `yaar://` URI scheme to address all internal resources — apps, storage files, sandboxes, windows, agents, user state, and sessions. The scheme is implicitly scoped to the current session — `yaar://` *is* the session root.

```
yaar://                                  → session (implicit root)
yaar://apps/{appId}                      → app
yaar://storage/{path}                    → storage file
yaar://sandbox/{id}/{path}               → sandbox file
yaar://monitors/{monitorId}/{windowId}    → window
yaar://config/{section}                  → configuration
yaar://browser/{browserId}               → browser instance
yaar://agents/{agentId}                  → agent
yaar://user/{resource}                   → user state (notifications, prompts, clipboard)
yaar://sessions/current                  → current session
```

---

## URI Format

```
yaar://{authority}/{path}
```

### Content Resources

| Authority | Example | Resolves to |
|-----------|---------|-------------|
| `apps` | `yaar://apps/excel-lite` | `/api/apps/excel-lite/index.html` |
| `apps` | `yaar://apps/excel-lite/index.html` | `/api/apps/excel-lite/index.html` |
| `storage` | `yaar://storage/documents/report.pdf` | `/api/storage/documents/report.pdf` |
| `sandbox` | `yaar://sandbox/17123456/src/main.ts` | `/api/sandbox/17123456/src/main.ts` |

For `yaar://apps/{appId}` (no subpath), the default entry point `index.html` is appended automatically.

### File-Operation URIs

The `basic/` MCP tools (`read`, `write`, `list`, `delete`, `edit`) use `parseFileUri()` from `@yaar/shared` to parse file-operation URIs:

| URI | Meaning |
|-----|---------|
| `yaar://storage/docs/file.txt` | Persistent storage file |
| `yaar://sandbox/123/src/main.ts` | Existing sandbox file |
| `yaar://sandbox/new/src/main.ts` | New sandbox (write/edit only) |

Legacy `storage://` and `sandbox://` schemes are also accepted by `parseFileUri()` for backward compatibility with existing AI context.

### Window Addressing

Windows are internally keyed as `{monitorId}/{windowId}` (e.g., `0/win-storage`), and addressed via the `monitor` authority:

```
yaar://monitors/{monitorId}/{windowId}
```

| Example | Meaning |
|---------|---------|
| `yaar://monitors/0/win-storage` | The storage window on the default monitor |
| `yaar://monitors/1/win-excel` | The excel window on monitor 1 |

This is the same format used by `scopedKey()` (server) and `toWindowKey()` (frontend) for window state lookups. The `yaar://monitors/` prefix formalizes it as a URI.

**Agent-facing simplification:** Agents are always scoped to a single monitor and cannot create windows on other monitors. The system prompt instructs agents to use bare window IDs (e.g. `win-storage`) — the server's `resolveWindowId()` strips any monitor prefix the agent might include, and `WindowStateRegistry` adds the correct monitor scope automatically via `actionEmitter.currentMonitorId`.

#### Window Resource URIs

Window URIs extend with sub-paths to address app state and commands:

```
yaar://monitors/{monitorId}/{windowId}/state/{key}      → read app state
yaar://monitors/{monitorId}/{windowId}/commands/{name}   → execute app command
```

| Example | Meaning |
|---------|---------|
| `yaar://monitors/0/win-excel/state/cells` | Read the "cells" state from excel app |
| `yaar://monitors/0/win-excel/commands/save` | Execute the "save" command on excel app |

These URIs are used by the `app_query` and `app_command` MCP tools via their `uri` parameter. Agents can use either full URIs or bare window IDs — the server resolves the monitor automatically:

```typescript
// Full URI (works but unnecessary — agent is already scoped)
app_query({ uri: "yaar://monitors/0/win-excel/state/cells" })

// Bare window ID (preferred — agent doesn't need to know its monitor)
app_query({ uri: "win-excel", key: "cells" })
```

### Config Addressing

Configuration is addressed via the `config` authority with section-based paths:

```
yaar://config/{section}         → config section (settings, hooks, shortcuts, mounts, app)
yaar://config/{section}/{id}    → specific entry within a section
```

| Example | Meaning |
|---------|---------|
| `yaar://config/settings` | User settings (language, preferences) |
| `yaar://config/hooks` | All event hooks |
| `yaar://config/hooks/hook-1` | Specific hook by ID |
| `yaar://config/shortcuts` | All desktop shortcuts |
| `yaar://config/shortcuts/shortcut-123` | Specific shortcut by ID |
| `yaar://config/app/github-manager` | GitHub Manager app config |

### Browser Addressing

Browser instances are addressed via the `browser` authority:

```
yaar://browser/{browserId}            → browser state (URL, title, navigation)
yaar://browser/{browserId}/content    → page content (read)
yaar://browser/{browserId}/screenshot → page screenshot (read)
yaar://browser/{browserId}/navigate   → navigate to URL (invoke)
yaar://browser/{browserId}/click      → click element (invoke)
```

Navigation, clicking, and other side effects are `invoke` targets — never `read`.

### Agents Addressing

Agents are addressed via the `agents` authority by instance ID:

```
yaar://agents/                           → list all agents
yaar://agents/{agentId}                  → agent by instance ID
yaar://agents/{agentId}/interrupt        → interrupt an agent
```

| Example | Meaning |
|---------|---------|
| `yaar://agents/` | List all active agents |
| `yaar://agents/agent-123` | Agent by instance ID |
| `yaar://agents/agent-123/interrupt` | Interrupt agent-123 |

Read-only introspection by default. Lifecycle control (`interrupt`) via `invoke` only.

### User Addressing

User-facing state is addressed via the `user` authority:

```
yaar://user/notifications                → notification list
yaar://user/notifications/{id}           → specific notification
yaar://user/prompts                      → pending prompts
yaar://user/prompts/{id}                 → specific prompt
yaar://user/clipboard                    → clipboard contents
```

| Example | Meaning |
|---------|---------|
| `yaar://user/notifications` | All notifications |
| `yaar://user/notifications/notif-1` | Specific notification |
| `yaar://user/prompts` | Pending user prompts |
| `yaar://user/prompts/prompt-42` | Specific prompt |
| `yaar://user/clipboard` | Current clipboard contents |

### Sessions Addressing

Session introspection is addressed via the `sessions` authority:

```
yaar://sessions/current                  → current session
yaar://sessions/current/logs             → session logs
yaar://sessions/current/context          → context state
```

| Example | Meaning |
|---------|---------|
| `yaar://sessions/current` | Current session detail |
| `yaar://sessions/current/logs` | Session conversation logs |
| `yaar://sessions/current/context` | Context/memory state |

Primarily for introspection and debugging.

---

## Where URIs Are Used

### Window Content

The AI uses bare window IDs in the `create` tool's `uri` parameter, and `yaar://` URIs for content:

```
create({
  uri: "excel-lite",
  title: "Excel Lite",
  renderer: "iframe",
  content: "yaar://apps/excel-lite"
})
```

The server resolves the content URI to an API path before sending the action to the frontend, and scopes the window to the agent's monitor automatically. Storage files work the same way:

```
create({
  uri: "report",
  title: "Q4 Report",
  renderer: "iframe",
  content: "yaar://storage/reports/q4.pdf"
})
```

### Desktop Shortcuts

Shortcuts use yaar:// URIs as their `target`:

```json
{
  "id": "app-excel-lite",
  "label": "Excel Lite",
  "icon": "📊",
  "target": "yaar://apps/excel-lite",
  "createdAt": 1709600000000
}
```

The URI itself communicates what the shortcut points to — `extractAppId()` parses app identity from the target.

### App Discovery API

The `/api/apps` endpoint returns `run` fields as yaar:// URIs:

```json
{
  "id": "excel-lite",
  "name": "Excel Lite",
  "run": "yaar://apps/excel-lite",
  ...
}
```

Apps with custom `run` paths in `app.json` (e.g., `"run": "index.html"`) get `yaar://apps/{appId}/index.html`. Absolute paths (starting with `/`) are returned as-is.

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

resolveContentUri('yaar://sandbox/123/src/main.ts')
// -> '/api/sandbox/123/src/main.ts'
```

Resolution points:
- **Server** (`mcp/window/create.ts`): resolves URIs in iframe content before emitting OS actions
- **Frontend** (`lib/api.ts`): `resolveAssetUrl()` resolves URIs and adds remote-mode auth

### Reverse Resolution (API path → parsed)

`parseContentPath()` parses API pathnames back into structured objects. Used by HTTP route handlers to unify routing for all content types:

```typescript
import { parseContentPath } from '@yaar/shared';

parseContentPath('/api/storage/docs/file.txt')
// -> { authority: 'storage', path: 'docs/file.txt' }

parseContentPath('/api/sandbox/123/src/main.ts')
// -> { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }

parseContentPath('/api/apps/dock/index.html')
// -> { authority: 'apps', appId: 'dock', path: 'index.html' }
```

Returns `ParsedContentPath` — a union of `storage`, `sandbox`, and `apps` variants. App IDs are validated as kebab-case (`/^[a-z][a-z0-9-]*$/`).

### File-Operation Parsing

File-operation URIs are parsed via `parseFileUri()` in `@yaar/shared`. This is separate from `parseContentPath()` — it handles `yaar://` URIs (not API paths) and includes sandbox creation (`sandboxId: null`):

```typescript
import { parseFileUri, buildFileUri } from '@yaar/shared';

parseFileUri('yaar://storage/docs/file.txt')
// -> { authority: 'storage', path: 'docs/file.txt' }

parseFileUri('yaar://sandbox/123/src/main.ts')
// -> { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }

parseFileUri('yaar://sandbox/new/src/main.ts')
// -> { authority: 'sandbox', sandboxId: null, path: 'src/main.ts' }

buildFileUri('storage', 'docs/file.txt')
// -> 'yaar://storage/docs/file.txt'

buildFileUri('sandbox', '123', 'src/main.ts')
// -> 'yaar://sandbox/123/src/main.ts'

buildFileUri('sandbox', null, 'src/main.ts')
// -> 'yaar://sandbox/new/src/main.ts'
```

The `basic/` MCP tools use `parseFileUri()` via a thin adapter in `mcp/basic/uri.ts`.

### Content Helpers

```typescript
import { parseYaarUri, buildYaarUri, extractAppId, isYaarUri } from '@yaar/shared';

parseYaarUri('yaar://apps/storage')
// -> { authority: 'apps', path: 'storage' }

buildYaarUri('apps', 'excel-lite')
// -> 'yaar://apps/excel-lite'

extractAppId('yaar://apps/excel-lite')
// -> 'excel-lite'

isYaarUri('yaar://apps/excel-lite')
// -> true
```

### Window Helpers

```typescript
import {
  buildWindowUri,
  parseWindowUri,
  buildWindowResourceUri,
  parseWindowResourceUri,
} from '@yaar/shared';

buildWindowUri('0', 'win-storage')
// -> 'yaar://monitors/0/win-storage'

parseWindowUri('yaar://monitors/0/win-storage')
// -> { monitorId: '0', windowId: 'win-storage' }

parseWindowUri('yaar://monitors/0/win-excel/state/cells')
// -> { monitorId: '0', windowId: 'win-excel', subPath: 'state/cells' }

buildWindowResourceUri('0', 'win-excel', 'state', 'cells')
// -> 'yaar://monitors/0/win-excel/state/cells'

parseWindowResourceUri('yaar://monitors/0/win-excel/state/cells')
// -> { monitorId: '0', windowId: 'win-excel', resourceType: 'state', key: 'cells' }
```

### Config Helpers

```typescript
import { parseConfigUri, buildConfigUri } from '@yaar/shared';

parseConfigUri('yaar://config/settings')
// -> { section: 'settings' }

parseConfigUri('yaar://config/hooks/hook-1')
// -> { section: 'hooks', id: 'hook-1' }

buildConfigUri('settings')
// -> 'yaar://config/settings'

buildConfigUri('app', 'github')
// -> 'yaar://config/app/github'
```

### Browser Helpers

```typescript
import { parseBrowserUri, buildBrowserUri } from '@yaar/shared';

parseBrowserUri('yaar://browser/0')
// -> { resource: '0' }

parseBrowserUri('yaar://browser/1/screenshot')
// -> { resource: '1', subResource: 'screenshot' }

buildBrowserUri('0')
// -> 'yaar://browser/0'

buildBrowserUri('1', 'navigate')
// -> 'yaar://browser/1/navigate'
```

### Agent Helpers

```typescript
import { parseAgentUri, buildAgentUri } from '@yaar/shared';

parseAgentUri('yaar://agents/agent-123')
// -> { id: 'agent-123' }

parseAgentUri('yaar://agents/agent-123/interrupt')
// -> { id: 'agent-123', action: 'interrupt' }

buildAgentUri('agent-123')
// -> 'yaar://agents/agent-123'

buildAgentUri('agent-123', 'interrupt')
// -> 'yaar://agents/agent-123/interrupt'
```

### User Helpers

```typescript
import { parseUserUri, buildUserUri } from '@yaar/shared';

parseUserUri('yaar://user/notifications')
// -> { resource: 'notifications' }

parseUserUri('yaar://user/notifications/abc')
// -> { resource: 'notifications', id: 'abc' }

buildUserUri('notifications')
// -> 'yaar://user/notifications'

buildUserUri('prompts', 'prompt-42')
// -> 'yaar://user/prompts/prompt-42'
```

### Session Helpers

```typescript
import { parseSessionUri, buildSessionUri } from '@yaar/shared';

parseSessionUri('yaar://sessions/current')
// -> { resource: 'current' }

parseSessionUri('yaar://sessions/current/logs')
// -> { resource: 'current', subResource: 'logs' }

buildSessionUri('current')
// -> 'yaar://sessions/current'

buildSessionUri('current', 'logs')
// -> 'yaar://sessions/current/logs'
```

---

## Key Files

| File | Role |
|------|------|
| `packages/shared/src/yaar-uri.ts` | URI parser, builder, resolver (content, file, window, config, browser, agents, user, sessions), `ParsedContentPath` |
| `packages/server/src/uri/resolve.ts` | Server-side typed resolution for all URI namespaces |
| `packages/server/src/http/routes/files.ts` | HTTP routes using `parseContentPath()` for apps, storage, sandbox |
| `packages/server/src/mcp/basic/uri.ts` | Thin adapter over `parseFileUri()` for basic MCP tools |
| `packages/server/src/mcp/window/create.ts` | Server-side URI resolution for iframe content |
| `packages/server/src/mcp/apps/discovery.ts` | `run` field and icon path generation as yaar:// URIs |
| `packages/server/src/storage/shortcuts.ts` | Shortcut creation with yaar:// targets |
| `packages/frontend/src/lib/api.ts` | Frontend URI resolution + remote auth |
| `packages/frontend/src/components/desktop/DesktopIcons.tsx` | Shortcut click handling via `extractAppId()` |
