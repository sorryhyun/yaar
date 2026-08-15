# Hooks

> [한국어 버전](../ko/hooks.md)

Hooks are event-driven config entries that fire actions on specific triggers. They let you automate responses to desktop events — for example, showing a progress toast when the AI compiles an app.

## Storage

Hooks are stored in `config/hooks.json`, addressable as `yaar://config/hooks` (or `yaar://config/hooks/{id}` for individual hooks). This file is git-ignored and managed either manually or through verb tools (`invoke`, `read`, `delete` on `yaar://config/hooks`). See [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

## Event Types

| Event | Description | Filter Support |
|-------|-------------|----------------|
| `launch` | Fires when a new session starts | None |
| `tool_use` | Fires when the AI calls a tool | `verb`, `uri`, `action`, `toolName` filters |
| `schedule` | Fires on a clock — see [Scheduled Hooks](#scheduled-hooks) | None (uses `schedule` instead) |

## Action Types

| Action | Description | Supported Events |
|--------|-------------|------------------|
| `interaction` | Injects a user message into the session (payload is a string) | `launch`, `schedule` |
| `os_action` | Emits OS Actions directly to the frontend (payload is an action object or array) | `launch`, `tool_use`, `schedule` |

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

## Scheduled Hooks

A `schedule` hook fires on a clock instead of on an event. This is YAAR's cron: anything you
would put in a crontab, you write as a hook whose action is an `interaction` (an agent turn) or
an `os_action` (a toast, a window).

```json
{
  "event": "schedule",
  "schedule": { "every": "30m" },
  "action": { "type": "interaction", "payload": "Check the build, and toast me only if it broke." },
  "label": "Build watch"
}
```

### Schedule Syntax

Exactly one of `every` or `at`. There is no cron expression — these two cover what a desktop
actually needs, and both are readable by whoever inherits the config file.

| Field | Form | Meaning |
|-------|------|---------|
| `every` | `"90s"`, `"15m"`, `"2h"`, `"1d"` | Fixed interval from the last run. **Minimum `1m`.** |
| `at` | `"09:00"` | Daily at that 24-hour time, in the **server's** local timezone |

An optional `monitorId` picks which desktop the hook acts on; it defaults to the first monitor.

The floor on `every` is a cost limit, not a resolution limit: an `interaction` hook is a full
agent turn, so `"every": "1s"` would bill one every second. A schedule that fails validation is
refused at registration; one that is edited into `hooks.json` by hand and fails is skipped, and
the tick says so in the log.

### What Happens When Nobody Is Watching

A hook fires *into* a session, but a clock does not care whether one exists. Three rules follow,
and they are the part worth understanding before you rely on this:

- **A due occurrence with nowhere to go is dropped, not banked.** If no session is connected when
  a hook comes due, the occurrence is marked as run and skipped. Otherwise a laptop opened at 4pm
  would be met by every "good morning" turn it slept through.
- **A missed run catches up once, and only once.** A `09:00` hook whose machine was asleep until
  10:30 fires at 10:30 — once — not four times for four missed days.
- **A timer never boots a session, and never interrupts one.** A scheduled `interaction` is
  skipped while its monitor is mid-turn or has messages queued, so a 1m hook cannot build a
  backlog behind one slow turn. An `os_action` (a toast) is delivered regardless — it queues
  behind nothing.

Runs are recorded in the hook's `lastRunAt`, which is the scheduled slot rather than the moment
the tick noticed it. That is what keeps a `15m` hook on the quarter-hour instead of drifting
forward by the tick interval on every fire, and what stops a restart from replaying a schedule.

## Example: App-Dev Progress Tracking

An example config at `docs/guides/example_hooks.json` demonstrates toasts that track app development, plus one `launch` hook:

| Hook | Event | Filter | Effect |
|-------|--------|--------|--------|
| `hook-1` | `tool_use` | `verb: invoke, uri: yaar://apps/*, action: clone` | "Cloning..." toast |
| `hook-2` | `tool_use` | `verb: invoke, uri: yaar://apps/*, action: [write, edit]` | "Writing code..." toast |
| `hook-5` | `tool_use` | `verb: invoke, uri: yaar://windows/*, action: app_command` | "Sending command to app..." toast |
| `hook-8` | `launch` | — | Opens the Dock window at boot |

### Activating the Example

Copy the example config to the active hooks file:

```bash
cp docs/guides/example_hooks.json config/hooks.json
```

Then start the server with `make dev`. When the AI uses app-dev tools, toasts will appear automatically.

## Managing Hooks via MCP Tools

The AI can manage hooks through verb tools:

- **`invoke('yaar://config/hooks', { event, label, action, filter?, schedule?, monitorId? })`** — Register a new hook (shows a permission dialog, which names the cadence for a `schedule` hook)
- **`read('yaar://config/hooks/')`** — Read registered hooks (the resource registers `describe`/`read`/`invoke` only; `list` is refused as not-a-collection)
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

`launch` and `schedule` hooks run whole — both go through `LiveSession.runHookAction()`, so what a
hook means does not depend on what tripped it. The clock behind `schedule` is one process-wide
interval in `features/config/hook-scheduler.ts`, started at boot; the timing math it reads is
`features/config/hook-schedule.ts`.
