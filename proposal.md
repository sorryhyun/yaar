# URI-Based Resource Addressing

## Summary

`yaar://` is a unified URI scheme for addressing all internal resources: content (apps, storage, sandbox), windows, configuration, browser instances, agents, user state, and sessions.

Every stable, inspectable entity gets a URI. Side-effecting operations (navigation, interrupts, prompts) stay explicit.

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
| `yaar://browser/{browserId}` | Browser instance state (URL, title) |
| `yaar://browser/{browserId}/content` | Page content |
| `yaar://browser/{browserId}/screenshot` | Page screenshot |
| `yaar://browser/{browserId}/navigate` | Navigate to URL |
| `yaar://browser/{browserId}/click` | Click element |

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

- **Generic verb layer** (`describe`, `read`, `list`, `write`, `delete`, `invoke`) — URIs exist as addresses but operations are still done through individual MCP tools
- **ResourceRegistry** — central registry matching URI patterns to handlers with schema validation
- **Monitor-as-resource** — reading `yaar://monitors/{id}/` as a status object (queue, budget, agent info)
- **Session root** — reading `yaar://` for session overview
