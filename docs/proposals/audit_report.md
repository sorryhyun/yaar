# Audit: iframe-token & verb flow entanglement (`packages/server`)

**Date:** 2026-08-05
**Scope:** `packages/server/src` — the iframe-token lifecycle (`http/iframe-tokens.ts` and its call sites) and the `yaar://` verb flow (`http/routes/verb.ts`, `http/access.ts`, `handlers/uri-registry.ts` and both dispatch doors).
**Method:** direct code reading of the core modules plus two file-by-file traces (token mint/refresh/revoke lifecycle; verb dispatch through both doors). Every high-severity claim was verified against the code at the cited lines.

## Diagnosis in one paragraph

An app's effective authority is assembled in **three different layers at three different times** — frozen into the token at mint time (declared permissions + `SELF_GRANTS` + `documentUri` + `extraPermissions`), added per-request (delegated grants via an injected resolver in `resolvePrincipal`), and rewritten per-check (`requirePermission` canonicalizes every grant entry on every call). Meanwhile the token's **lifecycle is not tied to the window it represents**: nothing revokes it on close, and the refresh path re-derives only a subset of the mint inputs. Most individual pieces are carefully documented, but the seams between them have already drifted in four confirmed places, two with live behavioral consequences (findings 2 and 3).

---

## High severity

### 1. Token revocation exists but is wired to nothing

- `revokeIframeToken` (`http/iframe-tokens.ts:261`) has **zero callers** in the entire repo. Its own doc comment says "e.g., when a window is closed."
- The window-close teardown (`session/window-state.ts` → `agents/window-event-coordinator.ts:117`) clears delegated grants, app commands, subscriptions, the context tape, and the app agent — everything **except the token**. App retire on redeploy (`features/apps/retire.ts`) goes through the same close pipeline and inherits the gap.
- `validateIframeToken` checks only TTL, so a closed window's token remains a valid credential — same appId, same baked-in permissions — for up to 24 hours.
- Compounding it: every reconnect/RESYNC mints a **fresh** token per open iframe window per connection (`session/session-snapshot-service.ts` → `logging/window-restore.ts:175`) without invalidating the old one. Multiple tokens for the same window are routinely live at once, while `TokenEntry`'s comments reason about "the" token as singular. The mental model and the implementation disagree.

**Why it hurts:** anyone reading the close/retire paths reasonably assumes revocation happens there; the growth of the process-global `tokens` Map tracks reconnect frequency, not window count.

### 2. Mint-time grants are silently dropped on every token refresh

- `features/window/create.ts:263` mints the full token: `appId`, `extraPermissions` (a privileged caller's additions), `monitorId`, `documentUri` (the "an iframe may read its own document" grant).
- The refresh path (`logging/window-restore.ts:175`, hit on every reconnect and session restore) re-mints with only `{ appId, monitorId }`. `extraPermissions` and `documentUri` vanish on the first page refresh. (`storageDocumentUri` is private to `create.ts`, so the restore path could not recompute it even if it tried.)
- This is exactly the failure the codebase already diagnosed once: `features/window/delegated-grants.ts` stores its grants on `WindowStateRegistry` *specifically because* "tokens are re-minted on remount and would otherwise silently lose it." The two sibling delegation mechanisms in the very same `window.create` handler ended up on opposite sides of that lesson — `grantsFromPayload` survives remount and is tested (`tests/delegated-grants.test.ts`); `extraPermissions`/`documentUri` do not and are not.
- Concrete regression: the devtools-preview 403 that `documentUri` was built to fix (`iframe-tokens.ts:212-227`, `tests/iframe-document-access.test.ts`) should recur on every reconnect — that test only exercises the mint path, never the refresh path.

**Why it hurts:** two structurally similar "hand the app extra reach" mechanisms sit side by side with silently different durability; a maintainer extending one will assume both behave the same.

### 3. Two non-equivalent "session principal" gates that have already diverged

The same policy — who may touch `yaar://session/*` — is enforced twice, in different currencies:

- **HTTP door:** `http/access.ts:260` gates on the token's `systemApp` manifest flag.
- **Registry:** `handlers/uri-registry.ts:299` gates handlers tagged `access: 'session-principal'` on `resolveAgentRole() === 'session'`.

The two never agree for iframe callers: `verb.ts`'s `runWithAgentContext` call (~line 388) never sets a `role`, so an iframe caller can **never** satisfy the registry gate. And the tier is applied unevenly — 5 of the 7 `yaar://session/*` registrations carry it (`handlers/session.ts:80,125,177,197,273`), while `yaar://session/agents` and `/agents/*` (`handlers/agents.ts:30,79`) carry none.

Concrete consequence: process-explorer (bundled `kind: "system"` app) declares `"yaar://session/"` in its `app.json`. That grant works only because the one sub-resource it actually uses (`session/agents`) happens to lack the registry tier. The rest of its declared scope (`session/browser`, `/monitors`, `/context`) is silently inert — the HTTP gate would admit it and the registry gate would 403 it. Whether `session/agents` being tier-less is intentional is undecidable from the code, which is itself the problem: two gate definitions, no single place stating which wins.

---

## Medium severity

### 4. `self`-resolution implemented four times

`access.ts:204` (`resolveSelf`), `verb.ts:340-348` (main endpoint), `verb.ts:257-265` (subscribe endpoint), plus the path-flavored variant in `storageUriFor` (`access.ts:375`). All four must agree for permission matching and subscription delivery to work; nothing shares or enforces the rule. A change to the `self` spelling (or a future `windows/self`) is a four-site edit.

### 5. Effective authority is assembled in three layers

Frozen at mint (`iframe-tokens.ts`: declared perms + `SELF_GRANTS` + `documentUri` + `extraPermissions`), added per-request (`access.ts:149-156`: delegated grants via injected resolver), rewritten per-check (`requirePermission`'s `canonicalStorageUri`/`resolveSelf` flatMap over every grant on every call). Answering "what can app X reach right now?" requires reading three files and knowing which layer runs when. Finding 2 is a direct casualty of this split.

### 6. Two module-level setter globals with silent no-op defaults

`setAccessRoleResolver` (`uri-registry.ts:23`) and `setWindowGrantResolver` (`access.ts:107`), both wired only in `lifecycle.ts:77-85`, both defaulting to no-ops ("no role", "no grants") until wired. Before wiring — or in any test that doesn't boot the hub — semantics silently change rather than fail. Tests already hand-rewire these globals per file; a third door will likely mint a third copy of the pattern instead of reusing either.

### 7. Copy-source authorization lives outside the resource it protects

`verb.ts:314-333` re-checks `read` on `payload.from` for `copy` invokes, because the storage handlers themselves (`handlers/storage.ts:204`, `handlers/apps/storage-resource.ts:162`) perform no authorization at all. The invariant is enforced at one door, duck-typed against a payload shape (`element?.action !== 'copy'`, `element.from`) that two other files independently define, with no shared schema linking enforcement to implementation. A renamed field or a new copy-capable resource silently uncovers it.

### 8. `handlers/apps/register.ts` is a hand-rolled router standing in for a registry gap

`ResourceRegistry` supports no middle wildcard, so one `yaar://apps/*` registration fans out db → storage → agents → app in a null-returning fallthrough chain duplicated across all five verbs, with the storage sub-path's invoke schema hand-merged into the composite's (`register.ts:96-102`) and URI-shape knowledge re-parsed by local regex (`rejectInstanceSubPath`). Self-acknowledged scaffolding, but every new sub-resource costs five synchronized edits with only call-site ordering keeping dispatch correct.

### 9. Three token-validation layers disagree on what "presenting a token" means

- `server.ts` Phase B route gate: reads the `x-iframe-token` **header only**.
- `auth.ts` `hasValidIframeToken` and `access.ts` `extractIframeToken`: header **or** `?__yaar_token=` query param.

A subresource riding the query param skips the coarse route-allowlist gate entirely and is caught only by the fine-grained gates. Probably safe today (the routes behind the allowlist still run `requirePermission`/`requireHost`), but there are three copies of the extraction rule and one is already different. `server.ts` also carries an inline cross-app static-file check (`/api/apps/` regex) — permission policy living outside the chokepoint `access.ts` claims to be.

---

## Low severity

### 10. Token layer hardcodes one app's private storage layout

`previewBundles` (`iframe-tokens.ts:161-179`) path-joins into `storage/apps/devtools/projects/{id}/app.json` and fails soft (`catch → undefined`), so a devtools layout change silently stops granting preview bundles and the eventual 403 points nowhere near the cause. Alongside it: an uncommented `await import('../features/apps/discovery.js')` (`iframe-tokens.ts:196`) with no evident import cycle to justify it — inconsistent with the module's otherwise exhaustive commenting, reads as a legacy artifact.

### 11. Batching asymmetry between the two doors

Brace expansion is MCP-only (`handlers/index.ts:105-124`); `/api/verb` never expands, so an app sending `yaar://storage/{a,b}` just gets "No handler registered". Consequently `toEnvelope`'s `--- uri ---` header-sniffing batch branch (`verb.ts:170-188`) is dead code for the only door that calls it — and it couples to `formatBatchResults`' string format purely by convention. The endpoint description documents only the array-payload form; the asymmetry is otherwise silent.

### 12. Subscription delivery relies on an unwritten contract

Subscriptions are keyed by literal URI string; the subscribe endpoint resolves `self` before storing so that `notifyChange`/`publishFrame` URIs match. Every producer call site (~12 across 4 files) must therefore pass the resolved (never `self`-bearing) URI. All comply today; nothing enforces it, and the failure mode is a subscription that silently never fires.

### 13. Miscellany

- Two unrelated "preview" encodings in one subsystem: windowId `preview:{appId}` (`http/routes/dev.ts:242`) vs appId `preview--{projectId}` (`PREVIEW_APP_PREFIX`).
- `/api/verb` and `/api/verb/subscribe` have structurally similar but hand-duplicated gate preludes (different non-app rejection rules, subscribe's stream/bundle carve-outs, main-door-only session logging) with no shared "resolve + gate" helper.
- `generateIframeToken` and `generateAppIframeToken` share one all-optional `IframeTokenOptions`, each silently ignoring fields it doesn't read — which is how new fields (`documentUri`, `extraPermissions`) got added without every call site reconsidering them (see findings 2 and the options-bag drift across the four mint sites: `create.ts:263` passes the full set, `window-restore.ts:175` and `api.ts:163` pass `{appId, monitorId}`, `dev.ts:242` passes `{appId}` only).

## Non-findings (checked, clean)

- The `monitorId::appId` agent-pool key encoding does **not** leak into the token layer — `TokenEntry` keeps the fields separate, and `WindowStateRegistry` resolves its own scoped keys.
- Delegated grants (`delegated-grants.ts`) are the well-engineered half of the delegation story: caller-rank check, exact-files-only, read-only, window-scoped, remount-safe, tested.
- Array-payload batching is properly per-element access-checked (`executeBatch` re-enters `execute`); a batch is a spelling, not a bypass.

---

## Recommended focus

If only two things get fixed:

1. **Tie token lifecycle to window lifecycle.** Wire `revokeIframeToken` into the window-close/retire teardown, and make refresh either reuse or fully re-derive the original mint inputs. The cleaner shape, following `delegated-grants.ts`'s own precedent: move `extraPermissions` and `documentUri` off the token onto `WindowStateRegistry`, making the token pure identity and the registry the single home of window-scoped authority. (Fixes findings 1, 2, and most of 5.)
2. **Pick one session-principal gate as authoritative** and make the other delegate to it; decide explicitly whether `yaar://session/agents` carries the tier. (Fixes finding 3.)

Cheaper consolidations that shrink the drift surface: one shared `resolveSelf`, a shared door prelude for `/api/verb` + `/api/verb/subscribe`, a shared copy-action schema between `verb.ts` and the two storage handlers, and unifying token extraction into one function used by all three gates.

A regression test for finding 2 (mint → refresh → assert `documentUri`/`extraPermissions` survive) is worth landing before any refactor, since it pins the behavior both fix shapes must preserve.
