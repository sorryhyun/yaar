# Plan: Unify App Routes with URI System

## Context

Storage and sandbox HTTP routes now use `parseContentPath()` from `@yaar/shared`,
eliminating duplicated regex patterns. App routes (`/api/apps/`) still use hardcoded
regex in `files.ts`. This plan outlines how to bring them into the same URI system.

## Current State

### Already unified (storage, sandbox)
```
yaar://storage/{path}          ↔  /api/storage/{path}          ↔  parseContentPath()
yaar://sandbox/{id}/{path}     ↔  /api/sandbox/{id}/{path}     ↔  parseContentPath()
```

### Not yet unified (apps)
```
yaar://apps/{appId}            →  /api/apps/{appId}/static/index.html   (resolveContentUri only)
yaar://apps/{appId}/{subpath}  →  /api/apps/{appId}/{subpath}           (resolveContentUri only)
/api/apps/{appId}/icon         ←  hardcoded regex in files.ts           (no URI equivalent)
/api/apps/{appId}/{path}       ←  hardcoded regex with static/dist strip (no reverse parser)
```

## Barriers

1. **App ID format differs from sandbox ID**
   - Sandbox: `\d+` (numeric timestamp)
   - Apps: `[a-z][a-z0-9-]*` (kebab-case)
   - `ParsedFileUri` needs a third variant for apps, or a broader `ParsedContentPath` type

2. **`static/dist` prefix is a fiction**
   - The HTTP regex `(?:(?:static|dist)\/)?` silently strips `static/` or `dist/` prefixes
   - But no app has a `static/` directory — compiled `index.html` lives at app root
   - All 17 app.json files have `"run": "static/index.html"` which only works because
     the regex strips the prefix before resolving against the actual filesystem
   - The full round-trip: `"run": "static/index.html"` → `buildYaarUri('apps', 'dock/static/index.html')`
     → `yaar://apps/dock/static/index.html` → `resolveContentUri` → `/api/apps/dock/static/index.html`
     → HTTP regex strips `static/` → serves `apps/dock/index.html`
   - **Fix:** Change all `"run"` to `"index.html"`, remove `static/dist` stripping from HTTP regex,
     update deploy to stop emitting `"run": "static/index.html"`

3. **Icon route is discovery, not file access**
   - `/api/apps/{appId}/icon` scans the directory for `icon.{png,webp,jpg,...}`
   - This isn't addressable as a URI path — it's a search operation
   - Should remain a separate route, not part of `parseContentPath()`

4. **Apps are read-only**
   - `ParsedFileUri` is used by MCP basic tools (read/write/edit/delete)
   - Adding `apps` to `ParsedFileUri` would imply write support
   - Need a separate type or a read-only flag

## Proposed Steps

### Step 1: Kill the `static/dist` fiction

- Change all 17 `app.json` files: `"run": "static/index.html"` → `"run": "index.html"`
- Update `deploy.ts:239`: stop setting `metadata.run = 'static/index.html'`
- Update `browser/index.ts:158`: `/api/apps/browser/static/index.html` → `/api/apps/browser/index.html`
- Update `resolveContentUri()`: `yaar://apps/{appId}` → `/api/apps/{appId}/index.html` (drop `static/`)
- Remove `(?:(?:static|dist)\/)?` from the HTTP regex in `files.ts`

### Step 2: Introduce `ParsedContentPath` in `@yaar/shared`

A broader type that covers all content-addressable API paths:

```typescript
type ParsedContentPath =
  | { authority: 'storage'; path: string }
  | { authority: 'sandbox'; sandboxId: string; path: string }
  | { authority: 'apps'; appId: string; path: string };
```

`parseContentPath()` returns this instead of `ParsedFileUri`. The app variant
validates `appId` with `/^[a-z][a-z0-9-]*$/`.

`ParsedFileUri` stays as-is for MCP basic tools (no apps variant).

### Step 3: Revise app static route in `files.ts`

Replace the hardcoded regex with `parseContentPath()`:
```typescript
const appParsed = parseContentPath(decodeURIComponent(url.pathname));
if (appParsed?.authority === 'apps' && appParsed.path) { ... }
```

### Step 4: Keep icon route separate

The icon route (`/api/apps/{appId}/icon`) stays as a standalone route.
It performs directory scanning, not file resolution.

## Out of Scope

- Making apps writable via MCP basic tools (they remain read-only, deployed via `dev` tools)
- PDF route (`/api/pdf/`) — uses `resolvePath()` for storage paths, not a content URI
- Browser routes (`/api/browser/`) — session-scoped, not content-addressable
