# URI Expansion Proposal

## Summary

This proposal expands `yaar://` from a content/window addressing scheme into a broader internal resource model.

The core idea is:

- `yaar://` is the current session root
- `yaar://{monitorId}/` is the current status view of a monitor
- stable internal entities should be addressable by URI
- side-effecting operations should remain explicit actions, not be disguised as file reads

This keeps the mental model simple without collapsing the system into one giant unsafe tool.

---

## Motivation

YAAR already uses `yaar://` successfully for several resource classes:

- apps
- storage files
- sandbox files
- windows
- app-protocol state and commands

That direction is working because URIs give the agent a stable identity model:

- resources can be named consistently
- resources can be discovered and described
- different tools can operate over the same address
- frontend, server, and agent prompts can share one vocabulary

The gap is that several first-class runtime concepts still exist only as ad hoc tool arguments:

- session state
- monitor state
- browser state
- config state
- agent/process state
- user-facing prompt/notification state

This proposal makes those readable through URIs while keeping mutation and workflows explicit.

---

## Design Principles

### 1. URI means identity, not behavior

A URI should identify a thing with stable meaning.

Good examples:

- a monitor
- current browser page state
- settings config
- an app command endpoint
- a notification item

Bad examples:

- "click here"
- "ask the user a question"
- "approve this operation"

Those are actions, not resources.

### 2. Read and invoke are different

Use a small set of generic verbs across resource types:

- `describe(uri)` or equivalent manifest lookup
- `read(uri)`
- `list(uri)`
- `write(uri, value)` where resource semantics support direct mutation
- `delete(uri)` where appropriate
- `invoke(uri, params)` for side effects
- `watch(uri)` later, if streaming/subscription becomes important

This avoids pretending every subsystem is a file while still reusing one address space.

### 3. Logical resources, not raw backing files

URIs should expose validated logical resources, not bypass internal invariants.

For example:

- `yaar://config/settings` should map to the settings domain model
- not directly to `config/settings.json` as arbitrary file I/O

This matters for:

- migrations
- validation
- access control
- secret handling
- compatibility over time

### 4. Session-relative root

`yaar://` is already implicitly the current session root. This proposal makes that explicit and builds on it.

---

## Proposed URI Space

## Session Root

### `yaar://`

Represents the current session.

Suggested `read(yaar://)` result:

- session id
- active monitor
- monitor list
- open window count
- agent summary
- browser summary
- pending user prompts

Example:

```json
{
  "kind": "session",
  "sessionId": "ses-1707000000000-abc1234",
  "activeMonitorId": "monitor-0",
  "monitors": ["monitor-0", "monitor-1"],
  "windowCount": 7,
  "browser": { "open": true, "uri": "yaar://browser/current" }
}
```

Suggested children:

- `yaar://sessions/current`
- `yaar://monitors`
- `yaar://browser`
- `yaar://config`
- `yaar://agents`
- `yaar://user`

`yaar://` remains session-scoped. It does not identify a global host-wide singleton.

---

## Monitor Resources

### `yaar://{monitorId}/`

Represents a monitor as a first-class resource.

This is the main addition suggested here.

Examples:

- `yaar://monitor-0/`
- `yaar://monitor-1/`

Suggested `read()` result:

- monitor metadata
- whether it is active
- main agent status
- queue status
- windows on that monitor
- budget usage for background monitors

Example:

```json
{
  "kind": "monitor",
  "monitorId": "monitor-1",
  "label": "Desktop 2",
  "active": false,
  "mainAgent": {
    "uri": "yaar://agents/main/monitor-1",
    "running": true
  },
  "queue": {
    "pending": 2
  },
  "windows": [
    "yaar://monitor-1/win-browser",
    "yaar://monitor-1/win-report"
  ]
}
```

Suggested child resources:

- `yaar://monitor-0/windows`
- `yaar://monitor-0/agents/main`
- `yaar://monitor-0/queue`
- `yaar://monitor-0/budget`
- `yaar://monitor-0/history`

### Window compatibility

Window URIs remain:

- `yaar://monitor-0/win-settings`
- `yaar://monitor-0/win-excel/state/cells`
- `yaar://monitor-0/win-excel/commands/save`

Parsing rule:

- `yaar://monitor-X/` with no additional segment means monitor resource
- `yaar://monitor-X/{windowId}` means window resource

This keeps monitor and window addressing in the same hierarchy.

---

## Browser Resources

Browser state is a strong URI candidate because it already has stable session-scoped identity.

Suggested resources:

- `yaar://browser`
- `yaar://browser/current`
- `yaar://browser/current/page`
- `yaar://browser/current/content`
- `yaar://browser/current/screenshot`
- `yaar://browser/current/selection`

Suggested `read(yaar://browser/current)` result:

- current URL
- title
- whether navigation is in progress
- associated browser window URI

Important boundary:

- `open`, `navigate`, `click`, `type`, `press`, `scroll`, `close` remain actions
- those should be `invoke()` targets or dedicated tools, not overloaded into `read()`

Good pattern:

```ts
read("yaar://browser/current")
invoke("yaar://browser/current/navigate", { url: "https://example.com" })
invoke("yaar://browser/current/click", { text: "Sign in" })
```

If YAAR keeps dedicated browser tools, those tools can still accept or return browser URIs.

---

## Config Resources

Config should become URI-addressable, but only as logical config domains.

Suggested resources:

- `yaar://config`
- `yaar://config/settings`
- `yaar://config/hooks`
- `yaar://config/hooks/{id}`
- `yaar://config/shortcuts`
- `yaar://config/shortcuts/{id}`
- `yaar://config/mounts`
- `yaar://config/mounts/{alias}`
- `yaar://config/app/{appId}`

Good:

```ts
read("yaar://config/settings")
write("yaar://config/settings", { language: "ko" })
list("yaar://config/shortcuts")
delete("yaar://config/hooks/hook-123")
```

Not recommended:

- exposing arbitrary `config/*.json` file writes through generic file I/O

Reason:

- config already has validation, merging, migration, and protected files

---

## Agent Resources

Agents are process-like runtime entities, so URI support should be primarily introspective and operationally conservative.

Suggested resources:

- `yaar://agents`
- `yaar://agents/main`
- `yaar://agents/main/monitor-0`
- `yaar://agents/window/win-excel`
- `yaar://agents/tasks`
- `yaar://agents/{agentId}`

Suggested readable data:

- agent type
- canonical role
- monitor scope
- current status
- current task
- last output time
- attached windows

Recommended restriction:

- support `read`, `list`, maybe `describe`
- do not support arbitrary `write`
- use explicit actions for interrupt, dispose, relay, or spawn

Examples:

```ts
read("yaar://agents/main/monitor-0")
invoke("yaar://agents/main/monitor-0/interrupt", {})
```

This keeps agent lifecycle visible without turning internals into mutable blobs.

---

## User Resources

The user as a human should not be modeled as a generic writable document.
But user-adjacent system state can be.

Suggested resources:

- `yaar://user`
- `yaar://user/notifications`
- `yaar://user/notifications/{id}`
- `yaar://user/prompts`
- `yaar://user/prompts/{id}`
- `yaar://user/clipboard`
- `yaar://user/selection`

Boundary:

- `ask` and `request` remain explicit actions
- approval dialogs remain explicit actions

Examples:

```ts
list("yaar://user/prompts")
read("yaar://user/notifications")
invoke("yaar://user/ask", {
  title: "Database",
  message: "Which database should be used?"
})
```

If desired, `ask` and `request` can be exposed as `invoke()` targets while still remaining action-like.

---

## Session Resources

Although `yaar://` is the session root, explicit session URIs are still useful.

Suggested resources:

- `yaar://sessions`
- `yaar://sessions/current`
- `yaar://sessions/current/logs`
- `yaar://sessions/current/windows`
- `yaar://sessions/current/monitors`
- `yaar://sessions/current/context`

These are mostly introspection and debugging tools.

In the future, multi-session admin features could use:

- `yaar://sessions/{sessionId}`

But current agent-facing behavior should remain scoped to the current session by default.

---

## Cross-Monitor Semantics

Cross-monitor should be explicit.

Current YAAR behavior scopes most agent actions to the current monitor. That is good and should remain the default.

URI expansion can still make cross-monitor operations legible:

- `yaar://monitor-1/` identifies the target monitor
- `yaar://monitor-1/win-report` identifies a specific cross-monitor window

But cross-monitor mutation should require explicit action, for example:

```ts
invoke("yaar://monitor-1/focus", {})
invoke("yaar://monitor-1/windows/create", {
  windowId: "win-report",
  renderer: "markdown",
  content: "# Report"
})
invoke("yaar://monitor-1/windows/move-here", {
  from: "yaar://monitor-0/win-report"
})
```

This keeps monitor scope visible and avoids accidental leaks across workspaces.

---

## OpenAPI vs Manifest

A single huge OpenAPI-style document for all of YAAR is possible, but it is probably the wrong primary interface.

A better fit is a manifest-first model:

- `describe("yaar://")` returns the top-level resource map
- `describe("yaar://config/settings")` returns schema and allowed verbs
- `describe("yaar://monitor-0/")` returns child resources and monitor-specific actions
- `describe("yaar://browser/current")` returns supported subresources and invocations

This mirrors the existing App Protocol approach:

- resources are self-describing
- schemas are local and contextual
- discovery can be incremental

OpenAPI can still exist as an export format for tooling, but should not be the only source of truth.

---

## Why Not One Mighty Tool

A single mega-tool like `resource_op({ uri, action, params })` is tempting, but should not be the public default.

Problems:

- safety boundaries become blurry
- approvals become harder to reason about
- prompts become less specific
- audit logs lose meaning
- tool descriptions become too generic to guide the agent well

A better split is:

- a small number of generic resource verbs for addressable resources
- dedicated tools for clearly behavioral domains when needed

Possible compromise:

- internally use a central `ResourceRegistry`
- externally keep a modest verb surface such as `read`, `list`, `write`, `delete`, `describe`, `invoke`

---

## Proposed Resolution Rules

### Reserved top-level namespaces

Reserve these authorities/subtrees:

- `apps`
- `storage`
- `sandbox`
- `browser`
- `config`
- `agents`
- `user`
- `sessions`
- `monitors`

### Special monitor path

Monitor IDs use the pattern `monitor-{n}` and are interpreted specially:

- `yaar://monitor-0/` -> monitor resource
- `yaar://monitor-0/win-x` -> window resource

### Session root

- `yaar://` -> current session root

### Logical over physical

If a URI maps to a subsystem with domain logic, that subsystem owns the parser and validation.

Do not flatten everything into filesystem resolution.

---

## Suggested Generic Operations

Minimal common surface:

```ts
describe(uri)
read(uri)
list(uri)
write(uri, value)
delete(uri)
invoke(uri, params)
```

Examples:

```ts
read("yaar://")
read("yaar://monitor-0/")
list("yaar://monitor-0/windows")
read("yaar://config/settings")
write("yaar://config/settings", { language: "ko" })
read("yaar://browser/current")
invoke("yaar://browser/current/navigate", { url: "https://example.com" })
read("yaar://agents/main/monitor-0")
```

`watch(uri)` can be deferred until there is a real need for subscriptions outside existing WS/SSE channels.

---

## Migration Strategy

### Phase 1: Formalize current semantics

- document `yaar://` as session root
- document `yaar://{monitorId}/` as monitor root
- keep existing app/storage/sandbox/window URIs unchanged

### Phase 2: Add read-only resource resolvers

- session
- monitor
- browser
- config
- agents
- user notifications/prompts

Expose only `describe`, `read`, and `list` at first.

### Phase 3: Add controlled mutation

- `write` for logical config resources
- `invoke` for browser actions, agent control, cross-monitor operations, and user prompt creation

### Phase 4: Consolidate internal tooling

Build a `ResourceRegistry` that:

- matches URI patterns
- returns resource descriptors
- validates allowed verbs
- provides schema/manifests
- handles access control and monitor/session scoping

---

## Non-Goals

- replacing every existing MCP tool immediately
- pretending every action is a resource read
- exposing raw config files directly
- making cross-session or cross-monitor mutation implicit
- collapsing the platform into one universal unsafe tool

---

## Recommended Next Step

Implement a minimal resource layer with:

- `describe(uri)`
- `read(uri)`
- `list(uri)`
- `invoke(uri, params)`

and support these resources first:

- `yaar://`
- `yaar://monitor-{n}/`
- `yaar://browser/current`
- `yaar://config/settings`
- `yaar://agents/main/{monitorId}`

That is enough to prove the model without disturbing file I/O or existing window/app URI behavior.

---

## Final Position

Expanding URI access is worth doing.

The right goal is not "everything must be a URI".
The right goal is:

- everything stable and inspectable should have a URI
- everything behavioral should use explicit verbs
- `yaar://` should be the session root
- `yaar://{monitorId}/` should expose monitor status as a first-class resource

That gives YAAR a coherent internal address space without losing safety or clarity.
