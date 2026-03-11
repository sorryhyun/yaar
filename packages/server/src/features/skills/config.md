# Config Reference

All configuration is accessed via `yaar://config/` URIs using the 5 generic verbs.

## Overview

| URI | Verbs | Description |
|-----|-------|-------------|
| `yaar://config/` | read, list | Read all config or list sections |
| `yaar://config/settings` | read, invoke | User preferences |
| `yaar://config/hooks` | read, invoke | Event-driven hooks |
| `yaar://config/hooks/{id}` | read, delete | A specific hook |
| `yaar://config/shortcuts` | read, invoke | Desktop shortcuts |
| `yaar://config/shortcuts/{id}` | delete | A specific shortcut |
| `yaar://config/mounts` | read, invoke | Host directory mounts |
| `yaar://config/mounts/{alias}` | delete | A specific mount |
| `yaar://config/app` | read, invoke | Per-app config (credentials, preferences) |
| `yaar://config/app/{appId}` | read, invoke, delete | A specific app's config |
| `yaar://config/domains` | read | HTTP domain allowlist |

## Settings

```
read('yaar://config/settings')
invoke('yaar://config/settings', { language: "en", onboardingCompleted: true })
```

| Field | Type | Description |
|-------|------|-------------|
| `language` | string | Language code: en, ko, ja, zh, es, fr, de, pt, ru, ar, hi, it, nl, pl, tr, vi, th, id, sv, uk |
| `onboardingCompleted` | boolean | Mark onboarding as completed |

## Hooks

```
read('yaar://config/hooks')
invoke('yaar://config/hooks', { event, label, action, filter? })
delete('yaar://config/hooks/{id}')
```

| Field | Required | Description |
|-------|----------|-------------|
| `event` | yes | `"launch"` (session start) or `"tool_use"` (tool invocation) |
| `label` | yes | Description shown in the permission dialog |
| `action` | yes | `{ type, payload }` — what happens when hook fires |
| `filter` | no | For `tool_use` — which tool names trigger this hook |

## Shortcuts

```
read('yaar://config/shortcuts')
invoke('yaar://config/shortcuts', { label, icon, shortcutType, target, ... })
invoke('yaar://config/shortcuts', { id: "existing-id", label: "Updated" })
delete('yaar://config/shortcuts/{id}')
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | no | Existing shortcut ID to update (omit to create) |
| `label` | create | Display name |
| `icon` | create | Emoji icon or storage image path |
| `iconType` | no | `"emoji"` (default) or `"image"` |
| `shortcutType` | create | `"file"`, `"url"`, `"action"`, `"app"`, or `"skill"` |
| `target` | create* | Storage path, URL, or action ID (*not needed for `"skill"` type) |
| `osActions` | no | OS Actions array to execute client-side on click |
| `skill` | skill type | Instructions sent to AI when clicked |

## Mounts

Host directory mounts exposed via `yaar://storage/mounts/{alias}/`.

```
read('yaar://config/mounts')
invoke('yaar://config/mounts', { alias: "my-docs", hostPath: "/home/user/Documents", readOnly: true })
delete('yaar://config/mounts/{alias}')
```

| Field | Required | Description |
|-------|----------|-------------|
| `alias` | yes | Short name (lowercase, alphanumeric + hyphens) |
| `hostPath` | yes | Absolute path on the host filesystem |
| `readOnly` | no | Block writes if true (default: false) |

## App Config

Per-app configuration (credentials, preferences). Stored at `config/{appId}.json`.

```
read('yaar://config/app/{appId}')
invoke('yaar://config/app/{appId}', { api_key: "ghp_xxx" })
delete('yaar://config/app/{appId}')
```

The payload is merged directly into the app's config — no wrapper object needed when using the app-specific URI.
