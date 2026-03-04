# Proposal: App-Window Decoupling

**Status:** Draft
**Date:** 2026-03-04

## Goal

Remove the coupling where `create()`/`create_component()` tools reach into `app.json` to auto-apply window defaults. After this change:

- **Apps** = skill templates + optional bundled code (identity, capabilities)
- **Windows** = independent UI surfaces (style set explicitly by the agent at create-time)
- **The AI** = the bridge (reads SKILL.md, decides window properties, calls create)

## Changes

### 1. Add explicit window params to `create()` / `create_component()`

**File:** `packages/server/src/mcp/window/create.ts`

Add parameters that the AI can set directly:

```typescript
// New optional params (replace appId's side-channel injection)
variant: z.enum(['standard', 'widget', 'panel']).optional()
  .describe('Window layer. standard (default), widget (always-on-top), panel (dock)'),
dockEdge: z.enum(['top', 'bottom']).optional()
  .describe('Dock edge for panel variant'),
frameless: z.boolean().optional()
  .describe('Hide titlebar'),
windowStyle: z.record(z.union([z.string(), z.number()])).optional()
  .describe('Custom CSS styles for the window element'),
```

Apply them directly in the OSAction instead of looking them up:

```typescript
const osAction: OSAction = {
  type: 'window.create',
  windowId: args.windowId,
  title: args.title,
  content: { renderer, data },
  ...(args.variant ? { variant: args.variant } : {}),
  ...(args.dockEdge ? { dockEdge: args.dockEdge } : {}),
  ...(args.frameless ? { frameless: true } : {}),
  ...(args.windowStyle ? { windowStyle: args.windowStyle } : {}),
};
```

### 2. Remove `appId` parameter from both tools

Delete:
```typescript
appId: z.string().optional()
  .describe('App ID — auto-applies window variant and metadata from app.json'),
```

And the metadata lookup:
```typescript
const appMeta = args.appId ? await getAppMeta(args.appId) : null;
```

### 3. Remove `app://` protocol resolution

Delete from `create.ts`:
```typescript
if (renderer === 'iframe' && typeof data === 'string' && data.startsWith('app://')) {
  const resolved = await resolveAppUrl(data);
  // ...
}
```

The AI will use direct URLs instead. The app list API already returns `run` URLs.

### 4. Remove `resolveAppUrl()` and `getAppMeta()`

**File:** `packages/server/src/mcp/apps/discovery.ts`

- Delete `resolveAppUrl()` (only called by create.ts)
- Delete `getAppMeta()` (only called by create.ts)
- Remove the import from create.ts

### 5. Update SKILL.md files

Every app with window defaults needs its SKILL.md updated to tell the AI what params to use.

**Before** (SKILL.md says nothing about window style, app.json handles it):
```markdown
## Launch
create({ windowId: "dock", renderer: "iframe", content: "app://dock" })
```

**After** (SKILL.md includes window hints):
```markdown
## Launch
create({
  windowId: "dock",
  renderer: "iframe",
  content: "/api/apps/dock/static/index.html",
  variant: "panel",
  dockEdge: "top",
  frameless: true,
  windowStyle: { "position": "fixed", "top": 0, "right": 0 }
})
```

Apps affected (have window defaults in app.json):
- `dock` — variant: panel, dockEdge: top, frameless: true, windowStyle
- Any other app with variant/frameless/dockEdge/windowStyle in app.json

### 6. Update system prompt

**File:** `packages/server/src/providers/claude/system-prompt.ts`

Remove references to `appId` parameter and `app://` protocol. Update iframe content docs:

```
- **iframe**: Use the URL from apps_list `run` field (e.g. `/api/apps/excel-lite/static/index.html`),
  or storage files via `storage://path`
```

### 7. Move `scopedKey` to `@yaar/shared`

**From:** `packages/server/src/mcp/window-state.ts` (`scopedKey`)
**From:** `packages/frontend/src/store/helpers.ts` (`toWindowKey`)
**To:** `packages/shared/src/window-key.ts`

```typescript
export function windowKey(monitorId: string, windowId: string): string {
  return `${monitorId}/${windowId}`;
}
```

Replace both usages. Same format, just shared.

## What Doesn't Change

- `app.json` still exists — identity (name, icon, description) and capabilities (appProtocol, protocol, fileAssociations) stay
- `apps_list` API still returns app info including `run` URL
- `apps_load_skill` still loads SKILL.md
- `app_query`/`app_command` still work (window-addressed)
- Window agent lifecycle (still lazy-created per window)
- `storage://` protocol (separate concern)
- `config/` organization (separate concern)
- Session log format (keys remain `monitorId/windowId`)

## Migration

This is a single atomic change. No phased rollout needed:

1. Add new params to create tools
2. Remove appId + app:// resolution
3. Delete `getAppMeta()` and `resolveAppUrl()`
4. Update SKILL.md files for affected apps
5. Update system prompt
6. Move windowKey to shared
7. Update imports in server + frontend

Existing sessions won't break — session restore replays actions (which don't contain `appId`), not tool calls.

## Risk

**Low.** The `appId` parameter is a convenience shortcut, not load-bearing architecture. Every property it auto-applies can be passed explicitly. The main risk is the system prompt update — the AI needs to learn the new pattern. But since SKILL.md files will document the exact `create()` call, this should be straightforward.
