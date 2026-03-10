# Config Tools Reference

## `config:set(section, content)`

Update configuration. The `content` object schema depends on the `section`.

### Section: `hooks`

Event-driven automation hooks.

```json
{
  "section": "hooks",
  "content": {
    "event": "launch" | "tool_use",
    "label": "Human-readable description",
    "action": {
      "type": "interaction" | "os_action",
      "payload": "string for interaction, object or array for os_action"
    },
    "filter": { "toolName": "tool_name" | ["tool1", "tool2"] }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `event` | yes | `"launch"` (session start) or `"tool_use"` (tool invocation) |
| `label` | yes | Description shown in the permission dialog |
| `action` | yes | `{ type, payload }` — what happens when hook fires |
| `filter` | no | For `tool_use` — which tool names trigger this hook |

### Section: `settings`

User preferences. All fields optional — only provided fields are updated.

```json
{
  "section": "settings",
  "content": {
    "language": "en",
    "onboardingCompleted": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `language` | string | Language code: en, ko, ja, zh, es, fr, de, pt, ru, ar, hi, it, nl, pl, tr, vi, th, id, sv, uk |
| `onboardingCompleted` | boolean | Mark onboarding as completed |

### Section: `shortcuts`

Desktop shortcuts. If `id` is provided, updates an existing shortcut; otherwise creates a new one.

```json
{
  "section": "shortcuts",
  "content": {
    "label": "My Shortcut",
    "icon": "🔗",
    "shortcutType": "url",
    "target": "https://example.com"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | no | Existing shortcut ID to update |
| `label` | create | Display name |
| `icon` | create | Emoji icon or storage image path |
| `iconType` | no | `"emoji"` (default) or `"image"` |
| `shortcutType` | create | `"file"`, `"url"`, `"action"`, `"app"`, or `"skill"` |
| `target` | create* | Storage path, URL, or action ID (*not needed for `"skill"` type) |
| `osActions` | no | OS Actions array to execute client-side on click |
| `skill` | skill type | Instructions sent to AI when clicked |

### Section: `mounts`

Host directory mounts exposed via `yaar://storage/mounts/{alias}/`.

```json
{
  "section": "mounts",
  "content": {
    "alias": "my-docs",
    "hostPath": "/home/user/Documents",
    "readOnly": true
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `alias` | yes | Short name (lowercase, alphanumeric + hyphens) |
| `hostPath` | yes | Absolute path on the host filesystem |
| `readOnly` | no | Block writes if true (default: false) |

### Section: `app`

Per-app configuration (credentials, preferences). Stored at `config/{appId}.json`.

```json
{
  "section": "app",
  "content": {
    "appId": "github-manager",
    "config": { "api_key": "ghp_xxx" }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `appId` | yes | App folder name |
| `config` | yes | Key-value pairs to merge into the app's config |

---

## `config:remove(section, id, key?)`

Remove a config entry by section and ID.

| Param | Required | Description |
|-------|----------|-------------|
| `section` | yes | `"hooks"`, `"shortcuts"`, `"mounts"`, or `"app"` |
| `id` | yes | Entry ID (e.g., `"hook-1"`, `"shortcut-xxx"`, `"my-docs"`, `"github-manager"`) |
| `key` | no | (app only) Remove a single key instead of the entire config |

---

## `config:get(section?, appId?)`

Read configuration. Returns all sections if `section` is omitted. For `"app"` section, provide `appId` to read a specific app's config.
