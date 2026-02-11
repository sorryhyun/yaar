# Hooks

Hooks are event-driven config entries that fire actions on specific triggers. They let you automate responses to desktop events — for example, showing a progress window when the AI uses app-dev tools.

## Storage

Hooks are stored in `config/hooks.json`. This file is git-ignored and managed either manually or through the MCP tools (`set_config`, `get_config`, `remove_config`).

## Event Types

| Event | Description | Filter Support |
|-------|-------------|----------------|
| `launch` | Fires when a new session starts | None |
| `tool_use` | Fires when the AI calls a tool | `toolName` filter |

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
    "toolName": "apps:clone"
  },
  "action": {
    "type": "os_action",
    "payload": { "type": "window.create", "..." : "..." }
  },
  "label": "Show progress on clone",
  "enabled": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Filter Syntax (tool_use only)

The `filter.toolName` field narrows which tool calls trigger the hook:

- **Single tool:** `"toolName": "apps:clone"`
- **Multiple tools:** `"toolName": ["apps:write_ts", "apps:apply_diff_ts"]`
- **Omitted:** Hook fires on every tool call

Tool names use the `namespace:name` format (e.g., `apps:compile`, `window:create`).

## Example: App-Dev Progress Tracking

An example config at `config/example_hook.json` demonstrates a 4-stage progress window that tracks app development:

| Stage | Trigger Tool | Progress | Status |
|-------|-------------|----------|--------|
| Clone | `apps:clone` | 10% | "Cloning..." |
| Write | `apps:write_ts`, `apps:apply_diff_ts` | 50% | "Writing code..." |
| Compile | `apps:compile` | 80% | "Compiling..." |
| Deploy | `apps:deploy` | 100% | "Deployed!" |

The first hook creates a small progress window (280x120, top-right corner). Subsequent hooks update its content as the dev flow progresses.

### Activating the Example

Copy the example config to the active hooks file:

```bash
cp config/example_hook.json config/hooks.json
```

Then start the server with `make dev`. When the AI uses app-dev tools, the progress window will appear and update automatically.

## Managing Hooks via MCP Tools

The AI can manage hooks through built-in MCP tools:

- **`set_config`** — Register a new hook (shows a permission dialog)
- **`get_config`** — Read all registered hooks
- **`remove_config`** — Delete a hook by ID (shows a confirmation dialog)

### Example: Adding a Hook via set_config

```json
{
  "event": "tool_use",
  "filter": { "toolName": "apps:compile" },
  "action": {
    "type": "os_action",
    "payload": {
      "type": "window.setContent",
      "windowId": "dev-progress",
      "content": {
        "renderer": "component",
        "data": {
          "components": [
            { "type": "progress", "value": 80, "label": "Compiling..." }
          ]
        }
      }
    }
  },
  "label": "Show compile progress"
}
```

## How It Works

1. When the AI calls a tool, the `StreamToEventMapper` sends a `TOOL_PROGRESS` event to the frontend
2. It then checks for matching `tool_use` hooks via `getToolUseHooks(toolName)`
3. For each matching hook with an `os_action` action, the OS Action(s) are emitted through `actionEmitter`
4. The frontend receives and processes these actions (creating/updating windows, showing notifications, etc.)

Hook actions inherit the current agent context (agentId, monitorId) from the action emitter, so they route correctly to the active session.
