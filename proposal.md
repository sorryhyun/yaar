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

## Current URI Landscape

Before proposing changes, here is what exists in the codebase today.

### Central parser: `packages/shared/src/yaar-uri.ts`

All URI handling flows through this single module. It exports ~15 functions used by both server and frontend.

### Existing URI families

| Pattern | Authority | Example | Parser |
|---------|-----------|---------|--------|
| Content | `apps` | `yaar://apps/word-lite` | `parseYaarUri()` — regex: `/^yaar:\/\/(apps\|storage\|sandbox)\/(.*)$/` |
| Content | `storage` | `yaar://storage/docs/file.txt` | same |
| Content | `sandbox` | `yaar://sandbox/123/src/main.ts` | same |
| Window | `monitor-{n}` | `yaar://monitors/0/win-settings` | `parseWindowUri()` — regex: `/^yaar:\/\/(monitor-[^/]+)\/([^/]+)(?:\/(.+))?$/` |
| Window resource | `monitor-{n}` | `yaar://monitors/0/win-excel/state/cells` | `parseWindowResourceUri()` |
| Window resource | `monitor-{n}` | `yaar://monitors/0/win-excel/commands/save` | same |

### How parsing works today

Two independent regex branches, tried in sequence:

1. **Content URIs** — authority must be `apps`, `storage`, or `sandbox`
2. **Window URIs** — authority must match `monitor-{something}`

There is no overlap today because `monitor-*` never matches `apps|storage|sandbox`. But the two branches occupy the **same structural position** in the URI (the authority slot after `yaar://`).

### Key type definitions

```typescript
type YaarAuthority = 'apps' | 'storage' | 'sandbox';  // content only

interface ParsedWindowUri {
  monitorId: string;   // e.g. "0"
  windowId: string;    // e.g. "win-settings"
  subPath?: string;    // e.g. "state/cells"
}
```

### The collision problem

The proposal wants to add new top-level namespaces: `browser`, `config`, `agents`, `user`, `sessions`, `monitors`. These would occupy the same authority slot as both content URIs and monitor IDs:

```
yaar://storage/file.txt       ← content namespace
yaar://monitors/0/win-settings ← monitor instance ID
yaar://browser/current        ← proposed new namespace
yaar://config/settings        ← proposed new namespace
```

All four use `yaar://{something}/...` but `{something}` means three different things:
- a content type (`storage`)
- a monitor instance (`monitor-0`)
- a system namespace (`browser`)

Today this works by accident — `monitor-\d+` is structurally distinct from `apps|storage|sandbox`. But adding more namespaces makes the authority slot crowded and the resolution logic fragile.

---

## Options for a Clean URI Structure

### Option A: Formalize the status quo

Keep `monitor-{n}` as a magic prefix. All other top-level names are namespaces.

```
yaar://apps/word-lite                    (unchanged)
yaar://storage/docs/file.txt             (unchanged)
yaar://sandbox/123/src/main.ts           (unchanged)
yaar://monitors/0/                        (monitor resource — new)
yaar://monitors/0/win-settings            (unchanged)
yaar://monitors/0/win-excel/state/cells   (unchanged)
yaar://browser/current                   (new)
yaar://config/settings                   (new)
yaar://agents/main/0             (new)
yaar://user/notifications                (new)
```

Resolution rule:
```
if authority matches /^monitor-\d+$/  → monitor/window handler
else if authority in reserved set     → namespace handler
else                                  → error
```

**Pros:**
- Zero migration. Every existing URI stays the same.
- Simple to implement — one regex check at the top of the resolver.
- Token-efficient. Window URIs (the most common) stay short.

**Cons:**
- `monitor-\d+` is a magic pattern baked into the URI scheme forever.
- Monitor IDs can never be user-named (must stay `monitor-{n}`).
- The reserved namespace list must be maintained and enforced.
- Mixes instance IDs and namespaces in the same position — conceptually messy.

### Option B: Namespace everything — `yaar://monitors/{id}/...`

Move monitors under a proper namespace. All authorities become namespaces.

```
yaar://apps/word-lite                         (unchanged)
yaar://storage/docs/file.txt                  (unchanged)
yaar://sandbox/123/src/main.ts                (unchanged)
yaar://monitors/0/                            (monitor resource — new)
yaar://monitors/0/win-settings                (migrated from yaar://monitors/0/win-settings)
yaar://monitors/0/win-excel/state/cells       (migrated)
yaar://monitors/0/win-excel/commands/save     (migrated)
yaar://browser/current                        (new)
yaar://config/settings                        (new)
yaar://agents/main/0                          (new, monitor ref is just "0")
yaar://user/notifications                     (new)
```

Resolution rule:
```
match authority to namespace handler (apps, storage, sandbox, monitors, browser, config, agents, user)
```

**Pros:**
- Fully uniform — every top-level segment is a namespace, no magic patterns.
- Monitor IDs could be user-named in the future (just another path segment).
- Easier to extend — new namespaces just register, no collision risk.
- Clean parsing: `authority` → handler, remaining path → handler-specific.

**Cons:**
- **Breaking change.** Every window URI in the codebase changes. Affected locations:
  - `parseWindowUri()` regex and all callers
  - `buildWindowUri()`, `buildWindowKey()`, `parseWindowKey()`
  - `parseWindowResourceUri()`, `buildWindowResourceUri()`
  - Frontend store keys (`monitor-0/win-settings` → `monitors/0/win-settings` or `0/win-settings`)
  - `resolve-window.ts` fallback patterns
  - `app-protocol.ts` bare resource regex
  - All tests in `yaar-uri.test.ts`
  - Agent prompts that reference window URIs
- Window URIs get slightly longer (`yaar://monitors/0/win-x` vs `yaar://monitors/0/win-x`).
- The `monitor-0` → `0` change in the ID itself may propagate beyond URIs (store keys, agent scoping, etc.).

### Option C: Two-scheme split

Keep `yaar://` for content and system resources. Introduce `yaar://monitors/` for monitor-scoped things, but keep `monitor-0` as the instance ID format internally.

```
yaar://apps/word-lite                         (unchanged)
yaar://storage/docs/file.txt                  (unchanged)
yaar://sandbox/123/src/main.ts                (unchanged)
yaar://monitors/monitor-0/                    (monitor resource — new)
yaar://monitors/monitor-0/win-settings        (migrated)
yaar://monitors/monitor-0/win-excel/state/cells (migrated)
yaar://browser/current                        (new)
yaar://config/settings                        (new)
yaar://agents/main/0                  (new)
```

This is Option B but keeping `monitor-0` as the full ID (not shortening to `0`).

**Pros:**
- Uniform namespace structure like Option B.
- Monitor IDs stay `monitor-0` everywhere — no ID format change, just URI prefix change.
- Limits blast radius: only URI construction/parsing changes, not the monitor ID system itself.

**Cons:**
- Still a breaking change for all window URIs (same migration surface as Option B).
- Slightly more verbose: `yaar://monitors/monitor-0/win-x` (the word "monitor" appears twice).
- The redundancy (`monitors/monitor-0`) looks awkward.

### Option D: Namespace new resources only, alias monitors

Keep existing URIs exactly as-is. New system resources get their own namespaces. Add `yaar://monitors/` as a **read-only alias** that lists monitors but doesn't own window addressing.

```
yaar://apps/word-lite                         (unchanged)
yaar://storage/docs/file.txt                  (unchanged)
yaar://sandbox/123/src/main.ts                (unchanged)
yaar://monitors/0/win-settings                 (unchanged — canonical window URI)
yaar://monitors/0/                             (monitor resource — new, same pattern)
yaar://monitors/                              (list endpoint only — new)
yaar://browser/current                        (new)
yaar://config/settings                        (new)
yaar://agents/main/0                  (new)
```

Resolution rule:
```
if authority matches /^monitor-\d+$/  → monitor/window handler
else if authority in namespace set    → namespace handler
```

**Pros:**
- Zero migration for existing URIs.
- New namespaces are cleanly separated.
- `yaar://monitors/` exists for listing without owning the window URI space.
- Pragmatic — ships fast, defers the hard rename.

**Cons:**
- Two ways to reference monitors: `yaar://monitors/0/` and `yaar://monitors/` (list only). Could confuse.
- Still relies on the `monitor-\d+` magic pattern.
- Doesn't solve the long-term namespace purity question — just defers it.

---

## Decision

**Option B was chosen and implemented.** Monitor IDs are now plain numeric strings (`'0'`, `'1'`, etc.) and window URIs use the `yaar://monitors/{id}/` namespace (plural, consistent with `apps`, `sessions`, `agents`).

**Before:** `yaar://monitor-0/win-settings` (monitor ID: `monitor-0`)
**After:** `yaar://monitors/0/win-settings` (monitor ID: `0`)

All authorities are now uniform namespaces: `apps`, `storage`, `sandbox`, `monitors`. The `YaarAuthority` type and `YAAR_RE` regex include all four. `DEFAULT_MONITOR_ID = '0'` is exported from `@yaar/shared`.

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
  "activeMonitorId": "0",
  "monitors": ["0", "1"],
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

- `yaar://monitors/0/`
- `yaar://monitors/1/`

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
    "yaar://monitors/1/win-browser",
    "yaar://monitors/1/win-report"
  ]
}
```

Suggested child resources:

- `yaar://monitors/0/windows`
- `yaar://monitors/0/agents/main`
- `yaar://monitors/0/queue`
- `yaar://monitors/0/budget`
- `yaar://monitors/0/history`

### Window compatibility

Window URIs remain:

- `yaar://monitors/0/win-settings`
- `yaar://monitors/0/win-excel/state/cells`
- `yaar://monitors/0/win-excel/commands/save`

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
- `yaar://agents/main/0`
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
read("yaar://agents/main/0")
invoke("yaar://agents/main/0/interrupt", {})
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

- `yaar://monitors/1/` identifies the target monitor
- `yaar://monitors/1/win-report` identifies a specific cross-monitor window

But cross-monitor mutation should require explicit action, for example:

```ts
invoke("yaar://monitors/1/focus", {})
invoke("yaar://monitors/1/windows/create", {
  windowId: "win-report",
  renderer: "markdown",
  content: "# Report"
})
invoke("yaar://monitors/1/windows/move-here", {
  from: "yaar://monitors/0/win-report"
})
```

This keeps monitor scope visible and avoids accidental leaks across workspaces.

---

## OpenAPI vs Manifest

A single huge OpenAPI-style document for all of YAAR is possible, but it is probably the wrong primary interface.

A better fit is a manifest-first model:

- `describe("yaar://")` returns the top-level resource map
- `describe("yaar://config/settings")` returns schema and allowed verbs
- `describe("yaar://monitors/0/")` returns child resources and monitor-specific actions
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

- `yaar://monitors/0/` -> monitor resource
- `yaar://monitors/0/win-x` -> window resource

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
read("yaar://monitors/0/")
list("yaar://monitors/0/windows")
read("yaar://config/settings")
write("yaar://config/settings", { language: "ko" })
read("yaar://browser/current")
invoke("yaar://browser/current/navigate", { url: "https://example.com" })
read("yaar://agents/main/0")
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
