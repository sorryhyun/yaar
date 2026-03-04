# Proposal: URI-Based Window Addressing & App-Window Decoupling

**Status:** Draft
**Author:** Claude (with sorryhyun)
**Date:** 2026-03-04

## Problem Statement

Apps and windows are currently coupled in ways that conflate four distinct concepts:

1. **Agent** = process (computation unit)
2. **Window** = surface (presentation/interaction area)
3. **App** = skill template + optional bundled code
4. **Shortcut** = desktop icon config (how to launch something)

The coupling manifests in:
- The `create` tool's `appId` parameter injects `app.json` metadata into window creation
- `app://appId` protocol resolves iframe content URLs, tying window content to app identity
- `app.json` mixes concerns: skill identity (name, icon), window defaults (variant, frameless), launch config (`run`, `createShortcut`), and capabilities (`appProtocol`, `fileAssociations`)
- "Window agent" terminology implies agents ARE windows, when agents are processes that may be scoped to a surface
- `app_query`/`app_command` tools live in the `window/` MCP domain but are conceptually app-specific

Meanwhile, windows are already internally keyed as `{monitorId}/{windowId}` — a URI-like scheme that was never formalized.

### Concern Separation in app.json

Currently `app.json` bundles:

| Concern | Fields | Should belong to |
|---------|--------|-----------------|
| **Skill identity** | name, icon, description | App (SKILL.md / app.json) |
| **Window defaults** | variant, dockEdge, frameless, windowStyle | AI decision (via SKILL.md hints) |
| **Launch config** | run, createShortcut, hidden | Shortcut config |
| **Capabilities** | appProtocol, fileAssociations, protocol | App manifest |

The user interacts with **shortcuts on the desktop**, not with apps directly. The `run` field in `app.json` enables direct window open + render — this is a shortcut/launch concern. The AI reads SKILL.md for the skill, and the shortcut config determines how the desktop icon behaves.

## Goals

1. **Decouple apps from windows.** Apps become pure skill/template providers. Windows are independent, addressable surfaces.
2. **Formalize the internal URI scheme.** Replace ad-hoc `scopedKey()` with `yaar://{monitorId}/{windowId}[/path]` as the internal addressing substrate.
3. **Enable future REST-style app protocol.** The URI scheme should naturally extend to address app state and commands (e.g., `yaar://monitor-0/win-excel/commands/format-cell`).

## Non-Goals

- Exposing URIs to the AI in tool interfaces (internal only for now)
- Changing how the AI generates windowId strings
- Reworking the window agent lifecycle (separate concern)

## Current Architecture

### Window Creation Flow
```
AI reads SKILL.md → AI calls create(appId="excel", content="app://excel")
  → resolveAppUrl("app://excel") → "/api/apps/excel/static/index.html"
  → getAppMeta("excel") → { variant: "standard", frameless: false, ... }
  → WindowCreateAction emitted with metadata applied
```

### Internal Window Addressing
```
scopedKey(monitorId, rawId) → "monitor-0/win-storage"  (ad-hoc string concat)
resolve(windowId)           → suffix scan for "/windowId" match
toWindowKey(monitorId, id)  → "monitor-0/win-storage"  (frontend duplicate)
```

### App Protocol
```
app_command(windowId="win-excel", command="format-cell", params={...})
  → ActionEmitter → WebSocket → Frontend → postMessage → Iframe
```

## Proposed Architecture

### 1. Decouple Apps from Window Creation

**Remove `appId` from `create`/`create_component` tools.** Instead, add explicit window property parameters:

```
create(
  windowId, title, renderer, content,
  variant?,        // 'standard' | 'widget' | 'panel' (was auto-applied from app.json)
  dockEdge?,       // 'top' | 'bottom' (was auto-applied)
  frameless?,      // boolean (was auto-applied)
  windowStyle?,    // CSS object (was auto-applied)
  ...
)
```

The AI already reads `SKILL.md` before opening an app. The skill file can instruct the AI which window properties to use. No information is lost — it just flows through the AI's understanding rather than through a side-channel metadata injection.

**Replace `app://` with direct URLs.** The app list response already includes a `run` field with the resolved URL. The AI can use it directly:

```
# Before
create(appId="excel", renderer="iframe", content="app://excel")

# After
create(renderer="iframe", content="/api/apps/excel/static/index.html", variant="standard")
```

The `resolveAppUrl()` function and `app://` protocol can be removed.

**Subsume `storage://` under `yaar://storage/`.** Rather than keeping a separate `storage://` scheme, content references become `yaar://storage/{path}`. This unifies all internal resource addressing under one scheme. The server resolves `yaar://storage/...` → `/api/storage/...` just as it currently resolves `storage://` → `/api/storage/`.

### 2. Internal URI Scheme

Introduce a `YaarURI` utility in `@yaar/shared` — a unified scheme for all internal resource addressing:

```typescript
// Scheme: yaar://{authority}/{path}
//
// Window resources:
//   yaar://monitor-0/win-storage              → window surface
//   yaar://monitor-0/win-excel/state/cells    → app state (future)
//   yaar://monitor-0/win-excel/commands/save  → app command (future)
//
// Storage resources:
//   yaar://storage/documents/report.pdf       → persistent file
//
// Future:
//   yaar://config/...                         → config addressing (TBD)

type YaarURI = string; // branded string in practice

interface ParsedURI {
  authority: string;    // "monitor-0", "storage", etc.
  segments: string[];   // path segments after authority
}

function buildURI(authority: string, ...segments: string[]): YaarURI;
function parseURI(uri: YaarURI): ParsedURI | null;

// Convenience for window keys (most common case)
function windowKey(monitorId: string, windowId: string): string;
```

Replace all occurrences of:
- `scopedKey(monitorId, rawId)` in `window-state.ts`
- `toWindowKey(monitorId, rawId)` in frontend `helpers.ts`

The key format stays `{monitorId}/{windowId}` for backward compat with existing session logs. The `yaar://` prefix is only used when a full URI is needed (future: app protocol routing, diagnostics, logging).

### 3. Future: REST-Style App Protocol

With URIs as the substrate, app protocol commands can evolve from:
```
app_command(windowId="win-excel", command="format-cell", params={bold: true})
```

To URI-addressable resources:
```
yaar://monitor-0/win-excel/commands/format-cell  { bold: true }
yaar://monitor-0/win-excel/state/cells/A1        → { value: "Hello" }
```

This doesn't need to happen now, but the URI scheme should be designed to support it. The `/path` segment in `WindowAddress` enables this extension.

## Impact Analysis

### What Changes

| Area | Change | Risk |
|------|--------|------|
| `create` tool | Remove `appId`, add explicit window properties | Low — AI just passes properties directly |
| `create_component` tool | Same as above | Low |
| `app://` resolution | Remove from create.ts | Low — AI uses direct URLs |
| `resolveAppUrl()` | Deprecate/remove | Low |
| `getAppMeta()` | Still used by app list API, but not by window creation | Low |
| `window-state.ts` scopedKey | Replace with shared windowKey() | Low — same format |
| Frontend toWindowKey | Replace with shared windowKey() | Low — same format |
| SKILL.md files | Add window property hints (variant, frameless) | Low |
| System prompt | Update to reflect new create tool params | Medium — needs testing |

### What Doesn't Change

- Window agent lifecycle (still lazy-created on WINDOW_MESSAGE)
- Window grouping (WindowConnectionPolicy)
- Message routing (USER_MESSAGE vs WINDOW_MESSAGE)
- Event broadcasting (BroadcastCenter)
- App protocol MCP tools (app_query, app_command) — these stay as-is
- AI-facing windowId strings
- Session log format (keys remain `monitorId/windowId`)

### Backward Compatibility

- Existing session logs use `monitorId/windowId` keys — new scheme uses same format
- The `resolve()` suffix-matching in WindowStateRegistry handles both old and new keys
- `app://` URLs in old session logs won't replay correctly — but session restore already replays actions, not tool calls, so this is fine

## Open Questions

1. **app.json split** — How far do we go separating concerns? Options:
   - (a) Keep app.json as-is but stop reading window defaults from it in create tools (minimal change)
   - (b) Split into `app.json` (identity + capabilities) and a shortcut config layer (launch behavior)
   - (c) Full split — deferred to a separate proposal
2. **Should app.json `windowStyle`/`variant`/etc. move into SKILL.md hints?** Currently it's metadata the system auto-applies. With decoupling, the AI needs to know about it — SKILL.md is the natural place for "when you open this app, use these window properties."
3. **Naming: "window agent" → ?** If agents are processes and windows are surfaces, what do we call an agent scoped to a surface? "Surface agent"? "Scoped agent"? Or just keep "window agent" as convenient shorthand?
4. **Config addressing (`yaar://config/...`)** — Deferred. Worth thinking about but not part of this proposal.

## Migration Path

### Phase 1: Decouple (this proposal)
- Add explicit window property params to create tools
- Remove appId parameter
- Remove app:// protocol
- Update SKILL.md files to include window property hints
- Add WindowURI utility to @yaar/shared
- Replace scopedKey/toWindowKey with shared utility

### Phase 2: URI Routing (future)
- Add path support to WindowURI
- Route app protocol through URI paths
- Expose URIs in diagnostics/logging

### Phase 3: AI-Facing URIs (future)
- Make URIs available in tool responses
- Allow AI to reference windows by URI
- URI-based app protocol commands
