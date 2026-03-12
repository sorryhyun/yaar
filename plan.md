# Plan: `window.yaar` Verb SDK — Phase 2+

## Status

Phases 1–3 are complete.

- **Phase 1** ✅: `POST /api/verb` route, `IFRAME_VERB_SDK_SCRIPT`, injection in IframeRenderer, types, and docs.
- **Phase 2** ✅: App-scoped storage via `yaar://apps/{appId}/storage/`, `self` → appId resolution from iframe token, REST storage `self` support for `url()`.
- **Phase 3** ✅: Storage SDK reimplemented over verb SDK (`window.yaar.invoke`), Windows SDK reimplemented over verb SDK (`window.yaar.read/list`). Verb SDK added to compiler baked scripts, injection order fixed (verb SDK before dependents). Token read made lazy.

Current allowlist: `yaar://browser`, `yaar://apps/self/`, `yaar://windows`.

---

## Phase 2: App-scoped storage via `yaar://apps/{appId}/storage/`

### Context
Each app currently uses `window.yaar.storage.save('myapp/data.json', ...)` with manually-prefixed paths. This is error-prone (apps can clobber each other's data) and forces the agent to use a different API pattern than the app.

### Design
Use the existing `yaar://apps/` hierarchy instead of a new authority. Apps use the `self` keyword as a shorthand — the server resolves it to the real appId from the iframe token.

- **Agent calls:** `invoke('yaar://apps/my-app/storage/data.json', { action: 'write', content: '...' })`
- **App calls:** `yaar.invoke('yaar://apps/self/storage/data.json', { action: 'write', content: '...' })`
- **On disk:** `storage/apps/{appId}/data.json`

### Changes

#### 1. Extend apps handler: `packages/server/src/handlers/apps.ts`
- Add storage sub-path handling for `yaar://apps/{appId}/storage/{path}`
- Verbs: `read`, `list`, `invoke` (write), `delete`
- Map to `storage/apps/{appId}/{path}` on disk via `StorageManager`

#### 2. Resolve `self` in verb route: `routes/verb.ts`
- Extract `appId` from validated iframe token
- Rewrite `yaar://apps/self/` → `yaar://apps/{appId}/` before dispatching to registry
- Reject if token has no `appId` (non-app iframe)

#### 3. Expand allowlist in `routes/verb.ts`
- Add `'yaar://apps/self/'` to `IFRAME_ALLOWED_URI_PREFIXES`
- The `self` → `appId` rewrite happens before dispatch but after the allowlist check
- Apps can only access their own namespace — `yaar://apps/other-app/storage/` won't match `self`

#### 4. Update docs in `app_dev.md`
- Add verb-based storage examples: `yaar.invoke('yaar://apps/self/storage/...', ...)`
- Note: `window.yaar.storage.*` still works (unchanged) but verb API is preferred

### Security
- `self` is server-resolved from iframe token — apps can't impersonate other apps
- Agent (no iframe token) uses explicit appId — full access across apps
- Path traversal prevented by existing `StorageManager` safe-path checks

---

## Phase 3: Deprecate purpose-built SDKs

### Context
Once verb SDK covers storage via `yaar://apps/self/storage/`, the purpose-built `window.yaar.storage.*` and `window.yaar.windows.*` become redundant. Unify them for a single code path.

### Changes

#### 1. Reimplement `IFRAME_STORAGE_SDK_SCRIPT` over verb SDK
- `window.yaar.storage.save(path, data)` → `yaar.invoke('yaar://apps/self/storage/' + path, { action: 'write', ... })`
- `window.yaar.storage.read(path)` → `yaar.read('yaar://apps/self/storage/' + path)`
- `window.yaar.storage.list(dir)` → `yaar.list('yaar://apps/self/storage/' + dir)`
- `window.yaar.storage.remove(path)` → `yaar.delete('yaar://apps/self/storage/' + path)`
- `window.yaar.storage.url(path)` — keep as-is (returns a direct URL, no verb needed)

#### 2. Reimplement `IFRAME_WINDOWS_SDK_SCRIPT` over verb SDK
- `window.yaar.windows.read(id)` → `yaar.read('yaar://windows/' + id)`
- `window.yaar.windows.list()` → `yaar.list('yaar://windows')`
- Add `'yaar://windows'` to `IFRAME_ALLOWED_URI_PREFIXES`

#### 3. Remove postMessage/REST-based implementations
- Delete the postMessage request/response pattern from windows SDK
- Delete the REST-based pattern from storage SDK
- Both now go through `POST /api/verb` → ResourceRegistry
- Capture helper, notifications, contextmenu, app protocol SDKs remain unchanged (postMessage for real-time push)

#### 4. Update types in `yaar.d.ts`
- Mark old methods as `@deprecated` for one release cycle, then remove

### Migration
- No breaking change initially — old methods still work, just reimplemented internally
- Later: remove deprecated methods and the separate SDK scripts

---

## Phase 4: Per-app URI permissions in `app.json`

### Context
Currently the allowlist is a global server-side constant. As more URI prefixes become available, apps should declare what they need.

### Changes

#### 1. Add `permissions` field to `app.json` schema
```json
{
  "permissions": ["yaar://browser", "yaar://apps/self/storage/"]
}
```

#### 2. Embed permissions in iframe token
- When generating iframe tokens, include the app's declared permissions
- `validateIframeToken()` returns the permission list alongside `appId`

#### 3. Check permissions in `handleVerbRoutes`
- Replace global `IFRAME_ALLOWED_URI_PREFIXES` check with per-token permission check
- Fall back to global allowlist for apps that don't declare permissions (backward compat)

#### 4. Agent visibility
- When loading a skill (`apps_load_skill`), include the app's declared permissions in the output
- Agent knows what the app can/can't do and can suggest appropriate API calls

---

## Phase 5: `window.yaar.subscribe()` — Reactive verb results

### Context
Apps that use headless Chrome need to poll for state changes. A subscription model would let them react in real-time.

### Changes

#### 1. SDK addition: `window.yaar.subscribe(uri, callback)`
- Opens a subscription over the existing iframe ↔ parent WebSocket/postMessage channel
- Returns an unsubscribe function

#### 2. Server-side subscription registry
- Track which sessions/windows are subscribed to which URIs
- When a verb handler modifies a resource, notify subscribers

#### 3. BroadcastCenter integration
- Use existing `BroadcastCenter.publishToSession()` for push delivery
- Parent window relays to iframe via postMessage

#### 4. Scope
- Start with `yaar://browser/*` subscriptions (page navigated, content loaded)
- Extend to `yaar://apps/*/storage/*` later (file changed)

---

## Phase 6: Unify `/api/fetch` and `/api/browse` under verbs

### Context
The final step toward "one mental model everywhere." Currently apps use `fetch('/api/fetch', ...)` for HTTP and `fetch('/api/browse', ...)` for Chrome — both are purpose-built REST endpoints outside the verb system.

### Changes

#### 1. Register `yaar://http` handler
- `invoke('yaar://http', { url, method, headers, body })` → replaces `/api/fetch`
- Domain allowlist and permission dialogs reused

#### 2. Migrate `/api/browse` to `yaar://browser`
- Already partially there — `yaar://browser` handler exists
- Ensure `invoke('yaar://browser/new', { action: 'open', url })` works for one-shot browse (create temp session, extract, close)

#### 3. Add `yaar://http` to default allowlist
- Apps that currently use `fetch()` (which goes through the proxy script) would migrate to `yaar.invoke('yaar://http', ...)`

#### 4. Deprecate `/api/fetch` and `/api/browse`
- Keep as thin wrappers over verb handlers for backward compat
- Eventually remove the proxy fetch script override (biggest win: no more monkey-patching `window.fetch`)
