# The Clean Mental Model & Where It Breaks

**Status:** Reference doc
**Date:** 2026-03-04

## The Clean Model

```
Session (conversation state, survives reconnection)
├── Config     (credentials, preferences — per-app JSON files)
├── Storage    (persistent user files — flat filesystem)
├── Monitor(s) (virtual desktops, each with a main agent)
│   └── Window(s) (UI surfaces — created/destroyed by agents)
│       ├── content  (renderer + data — markdown, components, iframe)
│       ├── agent?   (optional persistent agent, scoped to this window)
│       └── style    (variant, frameless, bounds, windowStyle)
└── Apps       (skill templates + optional bundled code — NOT running processes)
    ├── SKILL.md        (instructions for the agent)
    ├── app.json        (identity + capabilities metadata)
    ├── static/         (compiled iframe content, if any)
    └── config/         (credentials at config/{appId}.json)
```

**Key principles:**

1. **Windows are the UI primitive.** They're created, destroyed, moved. They have content and style. They're addressable as `{monitorId}/{windowId}`.
2. **Apps are metadata bundles, not processes.** An app doesn't "run" — an agent reads its SKILL.md, creates a window with its content, and interacts with it.
3. **Agents are computation.** Main agents process user messages (one per monitor). Window agents process window interactions (one per window, lazily created). Agents are never "app agents."
4. **Config is app-scoped state.** Credentials and preferences, stored at `config/{appId}.json`. Orthogonal to windows.
5. **Storage is user-scoped files.** Persistent data the user creates. Orthogonal to apps and windows.

## Where the Current Code Breaks This Model

### 1. `app.json` mixes four concerns

```
apps/dock/app.json:
{
  "name": "Dock",                    ← App identity
  "icon": "🕐",                      ← App identity
  "description": "Clock, weather…",  ← App identity
  "appProtocol": true,               ← App capability
  "protocol": { "state": {…} },     ← App capability
  "run": "static/index.html",        ← Launch/shortcut config
  "createShortcut": false,           ← Launch/shortcut config
  "variant": "panel",                ← Window default
  "dockEdge": "top",                 ← Window default
  "frameless": true,                 ← Window default
  "windowStyle": { "position": … }  ← Window default
}
```

| Concern | Fields | Clean owner |
|---------|--------|-------------|
| App identity | name, icon, description | `app.json` (keep) |
| App capabilities | appProtocol, fileAssociations, protocol | `app.json` (keep) |
| Launch config | run, createShortcut, hidden | Shortcut / desktop layer |
| Window defaults | variant, dockEdge, frameless, windowStyle | SKILL.md hints or explicit `create()` params |

**Why it matters:** An app could open multiple windows with different styles (e.g., a "mini player" widget and a "full library" standard window). Baking one set of window defaults into app identity prevents this.

### 2. `appId` in `create()` pretends to "open an app"

```typescript
// packages/server/src/mcp/window/create.ts
appId: z.string().optional()
  .describe('App ID — auto-applies window variant and metadata from app.json'),
```

What it actually does:
```typescript
const appMeta = args.appId ? await getAppMeta(args.appId) : null;
// → Just reads variant/dockEdge/frameless/windowStyle from app.json
// → Spreads them onto the window create action
// → No persistent app↔window link is created
```

The window has no memory of which app it came from. `appId` is a one-shot "apply these CSS defaults" parameter wearing an "app identity" label.

### 3. `app://` conflates content URL with app identity

```typescript
// create.ts: resolves app:// to a URL
if (data.startsWith('app://')) {
  data = await resolveAppUrl(data);
  // "app://storage" → "/api/apps/storage/static/index.html"
}
```

- Only works for apps with compiled code (`run` field in app.json)
- Pure-skill apps (no iframe) can't use `app://`
- It's really just a URL shorthand, not an app protocol

### 4. `app_query`/`app_command` address windows, think about apps

```typescript
// app-protocol.ts
server.registerTool('app_query', {
  inputSchema: {
    windowId: z.string().describe('ID of the window containing the iframe app'),
    stateKey: z.string(),
  },
  // ...
});
```

Agents think "query the Excel app" but must provide a `windowId`. There's no way to address "the Excel app" without knowing which window contains it. If Excel has two windows open, agents must know which one.

### 5. "Window agent" suggests agents ARE windows

Agents are processes. Windows are surfaces. A window agent is "an agent scoped to a window" — the naming is okay as shorthand, but the code treats them as synonymous:

```typescript
// agent-pool.ts
this.windowAgents.set(windowId, agent);  // keyed by window, not by role
```

If two windows show the same app, they get separate agents with no shared state. There's no "app context" that persists across windows.

### 6. System prompt says "open an app" — no such operation exists

```
- **Open an app** (load skill → create window with instructions)
```

This is documentation for a concept that doesn't exist in the tool interface. The actual flow is:
1. Agent calls `apps_load_skill(appId)` — reads SKILL.md
2. Agent calls `create(windowId, renderer, content)` — creates a window
3. These are two independent operations with no formal link

### 7. `getAppMeta()` is a window-defaults accessor disguised as app metadata

```typescript
// discovery.ts — returns ONLY window presentation fields
export async function getAppMeta(appId: string): Promise<{
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
} | null>
```

The function name says "get app meta" but it only extracts window defaults. For actual app info (protocol, capabilities, name), you must call `listApps()` and search.

### 8. Config namespace is a flat mix

```
config/
├── permissions.json         ← System config
├── hooks.json               ← System config
├── curl_allowed_domains.yaml ← System config
├── settings.json            ← System config
├── shortcuts.json           ← System config (desktop)
├── mounts.json              ← System config (storage)
├── github-manager.json      ← App config (credentials)
├── excel-lite.json          ← App config (credentials)
```

System config and app config share the same directory with no namespace separation. The only distinction is convention: system files have descriptive names, app files use `{appId}.json`.

### 9. `storage://` is both a protocol and an app

- `storage://path` is a content URL protocol resolved in `create.ts`
- `apps/storage/` is a browsable app with its own SKILL.md and iframe
- The storage app shows files from `storage/`, which is also addressable via `storage://`

Storage plays three roles: protocol handler, app, and filesystem — each addressing the same underlying data differently.

## Summary

| Principle | Clean Model | Current Reality |
|-----------|------------|-----------------|
| Apps don't run | Apps are metadata bundles | System prompt says "open an app", `appId` in create implies running |
| Windows own their style | Style is a create-time decision | `app.json` bundles window defaults, `getAppMeta()` injects them |
| Agents are processes | Agents compute, windows display | "Window agent" naming, agents keyed by windowId |
| Config is app-scoped | `config/{appId}.json` for app state | Mixed namespace with system config files |
| One concern per file | Separation of concerns | `app.json` mixes identity + capabilities + launch + window defaults |

None of these conflicts are bugs. The system works. But the coupling makes it harder to reason about, extend, and explain. The app-window decoupling proposal addresses the most impactful conflicts (items 1-3, 7).
