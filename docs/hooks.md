# Hooks

Hooks are event-driven config entries that fire actions on specific triggers. They let you automate responses to desktop events — for example, showing a progress toast when the AI compiles an app.

## Storage

Hooks are stored in `config/hooks.json`, addressable as `yaar://config/hooks` (or `yaar://config/hooks/{id}` for individual hooks). This file is git-ignored and managed either manually or through verb tools (`invoke`, `read`, `delete` on `yaar://config/hooks`). See [URI-Based Resource Addressing](./verbalized-with-uri.md).

## Event Types

| Event | Description | Filter Support |
|-------|-------------|----------------|
| `launch` | Fires when a new session starts | None |
| `tool_use` | Fires when the AI calls a tool | `verb`, `uri`, `action`, `toolName` filters |

## Action Types

| Action | Description |
|--------|-------------|
| `interaction` | Injects a user message into the session (payload is a string) |
| `os_action` | Emits OS Actions directly to the frontend (payload is an action object or array) |

## Hook Structure

```json
{
  "id": "hook-1",
  "event": "tool_use",
  "filter": {
    "verb": "invoke",
    "uri": "yaar://apps/*",
    "action": "compile"
  },
  "action": {
    "type": "os_action",
    "payload": { "type": "toast.show", "message": "Compiling..." }
  },
  "label": "Toast on compile",
  "enabled": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Filter Syntax (tool_use only)

Filters match against the verb tool context. All filter fields are optional — omit a field to match any value. All specified fields must match (AND logic).

| Field | Type | Description |
|-------|------|-------------|
| `verb` | `string \| string[]` | The verb used: `invoke`, `read`, `list`, `delete` |
| `uri` | `string \| string[]` | URI pattern. Supports trailing `/*` wildcard (e.g., `yaar://storage/*`) |
| `action` | `string \| string[]` | The `payload.action` value for invoke calls (e.g., `compile`, `deploy`) |
| `toolName` | `string \| string[]` | Legacy: matches non-verb tool names (e.g., `WebSearch`) |

**Examples:**

- Match any storage invoke: `{ "verb": "invoke", "uri": "yaar://storage/*" }`
- Match any storage read: `{ "verb": "read", "uri": "yaar://storage/*" }`
- Match any apps invoke: `{ "verb": "invoke", "uri": "yaar://apps/*" }`
- Match non-verb tool: `{ "toolName": "WebSearch" }`
- Match everything (no filter): omit the `filter` field entirely

## Example: App-Dev Progress Tracking

An example config at `docs/example_hooks.json` demonstrates toasts that track app development:

| Stage | Filter | Status |
|-------|--------|--------|
| Clone | `verb: invoke, uri: yaar://apps/*, action: clone` | "Cloning..." |
| Write | `verb: invoke, uri: yaar://apps/*, action: [write, edit]` | "Writing code..." |
| Compile | `verb: invoke, uri: yaar://apps/*, action: compile` | "Compiling..." |
| Deploy | `verb: invoke, uri: yaar://apps/*, action: deploy` | "Deployed!" |

### Activating the Example

Copy the example config to the active hooks file:

```bash
cp docs/example_hooks.json config/hooks.json
```

Then start the server with `make dev`. When the AI uses app-dev tools, toasts will appear automatically.

## Managing Hooks via MCP Tools

The AI can manage hooks through verb tools:

- **`invoke('yaar://config/hooks/{id}', { hook })`** — Register a new hook (shows a permission dialog) or update settings
- **`read('yaar://config/hooks/')`** or **`list('yaar://config/hooks/')`** — Read registered hooks
- **`delete('yaar://config/hooks/{id}')`** — Delete a hook by ID (shows a confirmation dialog)

### Example: Adding a Hook

```json
{
  "event": "tool_use",
  "filter": {
    "verb": "invoke",
    "uri": "yaar://apps/*",
    "action": "compile"
  },
  "action": {
    "type": "os_action",
    "payload": {
      "type": "toast.show",
      "id": "dev-compile",
      "message": "Compiling app...",
      "variant": "info"
    }
  },
  "label": "Show compile toast"
}
```

## How It Works

1. When the AI calls a verb tool (e.g., `invoke('yaar://apps/my-app', { action: 'set_badge', count: 3 })`), the `StreamToEventMapper` extracts the verb, URI, and action from the tool input
2. It checks for matching `tool_use` hooks via `getToolUseHooks({ toolName, verb, uri, action })`
3. For each matching hook with an `os_action` action, the OS Action(s) are emitted through `actionEmitter`
4. The frontend receives and processes these actions (showing toasts, creating windows, etc.)

Hook actions inherit the current agent context (agentId, monitorId) from the action emitter, so they route correctly to the active session.
