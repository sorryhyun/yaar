# Plan: `window.yaar` Verb SDK for Iframe Apps

## Context

The agent uses `invoke('yaar://browser/...', payload)` via MCP verbs, but apps use completely different APIs (`fetch('/api/browse', ...)`, `window.yaar.storage.save(...)`, etc.). This forces the agent to context-switch between two mental models when writing app code. We want apps to use the same `yaar://` URI pattern the agent uses.

**Phase 1 (this PR):** Expose only `yaar://browser` to apps.
**Phase 2 (future):** Add `yaar://appstorage/` for app-scoped storage.

## Changes

### 1. New route: `packages/server/src/http/routes/verb.ts`

- `POST /api/verb` — accepts `{ verb, uri, payload? }`, dispatches to `ResourceRegistry`
- Server-side allowlist constant: `IFRAME_ALLOWED_URI_PREFIXES = ['yaar://browser']`
- Validates verb is one of 5 valid verbs, URI starts with an allowed prefix
- Exports `PUBLIC_ENDPOINTS` so iframe token gate allows it
- Pattern follows `browse.ts` / `proxy.ts` structure

### 2. Wire route: `packages/server/src/http/server.ts`

- Import `handleVerbRoutes` from routes index
- Import `PUBLIC_ENDPOINTS as VERB_PUBLIC` from `./routes/verb.js`
- Add to `buildPublicRoutes()` spread
- Add `handleVerbRoutes` dispatch in route chain (after browse, before files)

### 3. Wire route export: `packages/server/src/http/routes/index.ts`

- Add `export { handleVerbRoutes } from './verb.js';`

### 4. SDK script: `packages/shared/src/capture-helper.ts`

- New `IFRAME_VERB_SDK_SCRIPT` constant (IIFE, ES5-style, idempotency guard)
- Adds `window.yaar.invoke(uri, payload)`, `.read(uri)`, `.list(uri)`, `.describe(uri)`, `.delete(uri)`
- Each calls `POST /api/verb` with `X-Iframe-Token` header

### 5. Export SDK: `packages/shared/src/index.ts`

- Add `IFRAME_VERB_SDK_SCRIPT` to export list

### 6. Inject SDK: `packages/frontend/src/components/window/renderers/IframeRenderer.tsx`

- Import `IFRAME_VERB_SDK_SCRIPT`
- Add injection block with `data-yaar-verb` guard (same pattern as other SDKs)

### 7. Types: `packages/server/src/lib/bundled-types/yaar.d.ts`

- Add `VerbResult` interface and verb methods to `YaarGlobal`

### 8. Docs: `packages/server/src/features/skills/app_dev.md`

- Add "Verb API" section documenting `window.yaar.invoke()` etc. with browser example

## Security

- URI allowlist is server-side constant — apps cannot access `yaar://config`, `yaar://storage`, etc.
- Iframe token auth reused (same `X-Iframe-Token` pattern)
- Browser handler's own domain allowlist still enforced internally
- Phase 2 extensibility: just append to `IFRAME_ALLOWED_URI_PREFIXES`

## Verification

1. `bun run --filter @yaar/shared build` — shared package builds with new export
2. `bun run typecheck` — no type errors
3. `make dev` → open an app that uses `window.yaar.invoke('yaar://browser/test', { action: 'open', url: '...' })` → verify it works
4. Verify disallowed URIs return 403: `window.yaar.read('yaar://config/settings')` should fail

## Nice-to-Have / Future

### `yaar://appstorage/` — App-scoped storage
- Each app gets an isolated namespace: `yaar://appstorage/{appId}/`
- Server resolves `appId` from iframe token automatically — apps just write to `yaar://appstorage/data.json` and the server scopes it to `storage/apps/{appId}/data.json`
- Replaces the current pattern where apps manually prefix paths in `window.yaar.storage`
- Would let the agent use `invoke('yaar://appstorage/...', ...)` consistently in both OS and app contexts

### Deprecate purpose-built SDKs
- Once verb SDK covers storage, `window.yaar.storage.*` becomes a convenience alias over `window.yaar.invoke('yaar://storage/...')`
- Same for `window.yaar.windows.*` → `window.yaar.read('yaar://windows/...')`
- Keep the convenience methods but implement them internally via the verb SDK — single code path

### Per-app URI permissions in `app.json`
- Let apps declare which URI prefixes they need: `"permissions": ["yaar://browser", "yaar://appstorage/"]`
- Server validates against declared permissions at runtime
- Agent can see required permissions when loading the skill — knows what the app can/can't do

### `window.yaar.subscribe()` — Reactive verb results
- WebSocket-based subscriptions to URI changes: `window.yaar.subscribe('yaar://browser/my-tab', callback)`
- Enables real-time UI updates when browser state changes (page navigated, content loaded)
- Would use the existing BroadcastCenter infrastructure

### Unify `/api/fetch` and `/api/browse` under verbs
- `window.yaar.invoke('yaar://http', { url, method, headers })` instead of `fetch()` proxy
- `window.yaar.invoke('yaar://browser/new', { action: 'open', url })` instead of `/api/browse`
- Agent and app code become identical — one mental model everywhere
