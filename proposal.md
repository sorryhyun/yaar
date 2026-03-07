# URI Expansion Proposal

## Summary

Expand `yaar://` from a content/window addressing scheme into a unified internal resource model. Every stable, inspectable entity gets a URI. Side-effecting operations stay explicit.

**Decision:** All top-level segments are namespaces (no magic patterns). Monitor IDs are plain numeric strings (`'0'`, `'1'`). Window URIs use `yaar://monitors/{id}/...`.

**Status:** The `monitors` namespace migration is complete. The resource layer (new namespaces, generic verbs) is proposed but not yet implemented.

---

## Design Principles

1. **URI = identity, not behavior.** A URI identifies a stable thing (a monitor, a config key, a browser page). Actions like "click" or "ask the user" are not resources.

2. **Read and invoke are different.** Use generic verbs (`read`, `list`, `write`, `invoke`) across resource types. Don't pretend actions are reads.

3. **Logical resources, not raw files.** `yaar://config/settings` maps to the settings domain model with validation — not to `config/settings.json` as arbitrary file I/O.

4. **Session-relative root.** `yaar://` is the current session root, not a global singleton.

---

## Current URI Space (Implemented)

| Namespace | Example | Notes |
|-----------|---------|-------|
| `apps` | `yaar://apps/word-lite` | App content |
| `storage` | `yaar://storage/docs/file.txt` | User files |
| `sandbox` | `yaar://sandbox/123/src/main.ts` | Sandbox files |
| `monitors` | `yaar://monitors/0/win-settings` | Window URI |
| `monitors` | `yaar://monitors/0/win-excel/state/cells` | Window resource (app-protocol) |
| `monitors` | `yaar://monitors/0/win-excel/commands/save` | Window command (app-protocol) |

All parsing flows through `packages/shared/src/yaar-uri.ts`. The `YaarAuthority` type covers all four namespaces. `DEFAULT_MONITOR_ID = '0'` is exported from `@yaar/shared`.

---

## Proposed New Namespaces

### Session Root — `yaar://`

Read returns session overview: ID, active monitor, monitor list, window count, agent/browser summary.

```json
{
  "kind": "session",
  "sessionId": "ses-1707000000000-abc1234",
  "activeMonitorId": "0",
  "monitors": ["0", "1"],
  "windowCount": 7,
  "browser": { "open": true, "uri": "yaar://browser/current" }
}
```

### Monitors — `yaar://monitors/{id}/`

Read a monitor as a first-class resource (metadata, agent status, queue, windows, budget).

```json
{
  "kind": "monitor",
  "monitorId": "0",
  "label": "Desktop 1",
  "active": true,
  "mainAgent": { "uri": "yaar://agents/main/0", "running": true },
  "queue": { "pending": 2 },
  "windows": ["yaar://monitors/0/win-browser", "yaar://monitors/0/win-report"]
}
```

Child resources: `windows`, `agents/main`, `queue`, `budget`, `history`.

Parsing rule: `yaar://monitors/{id}/` with no further segment = monitor resource. With a `win-*` segment = window resource (existing behavior).

### Browser — `yaar://browser/...`

| URI | Verb | Description |
|-----|------|-------------|
| `yaar://browser/current` | `read` | Current URL, title, navigation state |
| `yaar://browser/current/content` | `read` | Page content |
| `yaar://browser/current/screenshot` | `read` | Screenshot |
| `yaar://browser/current/navigate` | `invoke` | Navigate to URL |
| `yaar://browser/current/click` | `invoke` | Click element |

Navigation, clicking, typing, scrolling, closing are `invoke` targets — never `read`.

### Config — `yaar://config/...`

| URI | Verbs | Description |
|-----|-------|-------------|
| `yaar://config/settings` | `read`, `write` | User settings |
| `yaar://config/hooks` | `read`, `list` | Event hooks |
| `yaar://config/hooks/{id}` | `read`, `write`, `delete` | Individual hook |
| `yaar://config/shortcuts` | `read`, `list` | Keyboard shortcuts |
| `yaar://config/shortcuts/{id}` | `read`, `write`, `delete` | Individual shortcut |
| `yaar://config/app/{appId}` | `read`, `write` | App credentials/config |

All mutations go through domain validation — no raw file writes.

### Agents — `yaar://agents/...`

| URI | Verbs | Description |
|-----|-------|-------------|
| `yaar://agents` | `list` | All active agents |
| `yaar://agents/main/{monitorId}` | `read` | Main agent for a monitor |
| `yaar://agents/window/{windowId}` | `read` | Window agent |
| `yaar://agents/{agentId}` | `read` | Any agent by ID |
| `yaar://agents/{agentId}/interrupt` | `invoke` | Interrupt agent |

Read-only introspection by default. Lifecycle control (`interrupt`, `dispose`, `spawn`) via `invoke` only.

### User — `yaar://user/...`

| URI | Verbs | Description |
|-----|-------|-------------|
| `yaar://user/notifications` | `read`, `list` | Notification list |
| `yaar://user/notifications/{id}` | `read`, `delete` | Individual notification |
| `yaar://user/prompts` | `list` | Pending prompts |
| `yaar://user/prompts/{id}` | `read` | Individual prompt |
| `yaar://user/clipboard` | `read` | Clipboard contents |
| `yaar://user/ask` | `invoke` | Ask user a question |

Asking and approval remain explicit `invoke` actions.

### Sessions — `yaar://sessions/...`

| URI | Verbs | Description |
|-----|-------|-------------|
| `yaar://sessions/current` | `read` | Current session detail |
| `yaar://sessions/current/logs` | `read` | Session logs |
| `yaar://sessions/current/context` | `read` | Context state |

Primarily for introspection and debugging. Multi-session admin (`yaar://sessions/{id}`) deferred.

---

## Generic Operations

Six verbs across all resource types:

```ts
describe(uri)          // Schema, allowed verbs, child resources
read(uri)              // Current state
list(uri)              // Child enumeration
write(uri, value)      // Mutation (where semantics allow)
delete(uri)            // Removal (where appropriate)
invoke(uri, params)    // Side effects
```

Resources are self-describing via `describe()` — no single monolithic OpenAPI doc needed. Discovery is incremental, matching the existing app-protocol pattern.

**Why not one mega-tool?** A single `resource_op({ uri, action, params })` blurs safety boundaries, makes approvals harder, and produces audit logs that lose meaning. Better: a small verb surface externally, backed by a central `ResourceRegistry` internally.

---

## Cross-Monitor Semantics

Default scope is the current monitor. Cross-monitor operations are legible via URIs but require explicit `invoke`:

```ts
invoke("yaar://monitors/1/focus", {})
invoke("yaar://monitors/1/windows/create", { windowId: "win-report", renderer: "markdown", content: "# Report" })
```

---

## Implementation Plan

### Phase 1: Read-only resource resolvers (next)

Add `describe`, `read`, and `list` support for:
- `yaar://` (session root)
- `yaar://monitors/{id}/` (monitor status)
- `yaar://browser/current`
- `yaar://config/settings`
- `yaar://agents/main/{monitorId}`

This proves the model without disturbing existing tools.

### Phase 2: Controlled mutation

Add `write` for config resources. Add `invoke` for browser actions, agent control, cross-monitor operations, user prompts.

### Phase 3: ResourceRegistry

Central registry that matches URI patterns, returns descriptors, validates verbs, provides schemas, and handles access control.

---

## Non-Goals

- Replacing every MCP tool immediately
- Pretending every action is a resource read
- Exposing raw config files directly
- Implicit cross-session or cross-monitor mutation
- Collapsing the platform into one universal unsafe tool
