# Proposal: untangle iframe-token lifecycle & verb-flow seams

**Responds to:** `audit_report.md` (2026-08-05)
**Scope:** `packages/server/src` — iframe tokens, window-scoped authority, the session-principal gate, and the drift-surface consolidations around `/api/verb`.

## The one decision everything else follows from

The audit's diagnosis is that window-scoped authority has two competing homes — the token
(frozen at mint) and `WindowStateRegistry` (read per request) — and the token is the one
that keeps losing. `delegated-grants.ts` already recorded the lesson explicitly: *"tokens
are re-minted on remount and would otherwise silently lose it."*

So the decision this proposal commits to:

> **The token is pure identity** — who this iframe is (window, session, app, monitor) and
> what its manifest declares (`permissions`, `systemApp`, `bundles`, `streams`).
> **`WindowStateRegistry` is the single home of window-scoped authority** — everything a
> caller granted *to this window* at runtime (`delegatedGrants`, and now `documentUri` and
> `extraPermissions` too). Identity is re-mintable at will; authority survives remount and
> dies with the window.

Everything in Phase 1 is a consequence of that sentence. Phases 2–4 are independent of it
and can land in any order after it.

---

## Phase 0 — pin behavior with tests (land with Phase 1, write first)

Fixes nothing; pins what both fix shapes must preserve (audit's closing recommendation).

1. **Mint → refresh survival** (finding 2, currently failing): create an iframe window with
   a storage-served document and caller-supplied `permissions`, simulate a reconnect
   (`refreshRestoredWindowActions`), assert the app can still `read` its own document URI
   and still holds the extra permissions. Extends `tests/iframe-document-access.test.ts`,
   which today exercises only the mint path.
2. **Close → revoked** (finding 1, currently failing): open an iframe window, capture its
   token, close the window, assert `validateIframeToken` returns null — under both the raw
   and the scoped windowId spelling, and via the app-retire path
   (`features/apps/retire.ts`) as well as a plain close.
3. **Multi-tab characterization** (keep passing): two connections to one session each get
   their own token for the same window; both stay valid until the window closes. This is
   the intended behavior finding 1's "singular token" comments contradict — pin it so the
   revocation work cannot "fix" it away.

## Phase 1 — token = identity, registry = authority (findings 1, 2, most of 5)

### 1a. Move `extraPermissions` and `documentUri` off the token

- `features/window/create.ts` stops passing `extraPermissions` / `documentUri` into
  `generateAppIframeToken`. Instead the existing `grantWindowAccess` call (already made
  before the emit, already keyed by the raw id) grows to:

  ```ts
  session?.windowState.grantWindowAccess(actualId, [
    ...grantsFromPayload(payload),
    ...(mayDelegateGrants() ? callerPermissions : []),      // was extraPermissions
    ...(docUri ? [{ uri: docUri, verbs: ['read'] }] : []),  // was documentUri
  ]);
  ```

  Two caveats found while tracing, both must be handled:
  - **The `if (appId)` gate on that call must go.** `documentUri` matters for *plain*
    iframe windows rendering storage-served content too (no appId), and
    `resolveWindowGrants` in `access.ts` is not appId-conditional, so the read side
    already supports this.
  - **The "read-only, exact files" doc on `delegatedGrants` needs updating**, not
    weakening: payload-derived grants keep all four narrowings (they still come through
    `grantsFromPayload`); caller-supplied `permissions` entries stay gated on
    `mayDelegateGrants()` exactly as they are today at the mint site. The registry stores;
    the producers narrow. Rewrite the `delegated-grants.ts` header to name both producers.

- `IframeTokenOptions` loses `extraPermissions` and `documentUri`; `generateAppIframeToken`
  loses the corresponding blocks. This collapses the four-site options-bag drift the audit's
  finding 13 lists — after this change, every mint site passes the same shape
  (`{ appId, monitorId }` + optional explicit `permissions`), and there is nothing left for
  a refresh to forget.

- `storageDocumentUri` moves out of `create.ts` into a shared helper
  (`features/window/helpers.ts` is the natural home) so the restore path can call it.

### 1b. Make restore re-derive what it can

- **Reconnect** (`SessionSnapshotService` → `refreshRestoredWindowActions`): nothing to do —
  the registry survives on the live `LiveSession`, so grants now survive automatically.
  This is the fix for the recurring devtools-preview 403.
- **Server-restart restore** (session log replay): the registry is fresh, but
  `action.content.data` is right there in the replayed `window.create` — call the shared
  `storageDocumentUri(data)` and `grantWindowAccess` during replay. Restart-restore becomes
  strictly better than today. `extraPermissions` are *not* recoverable after a restart
  (they were never logged); document that as the accepted loss, matching what delegated
  grants already accept.

### 1c. Wire revocation to window close

- `iframe-tokens.ts` gains a secondary index `Map<"{sessionId}::{windowId}", Set<token>>`
  maintained by mint/expire/revoke, and a `revokeTokensForWindow(sessionId, windowId)`.
- Wire it into the close pipeline at the point that holds both the sessionId and the
  window key — the same callback chain that already reaches
  `WindowEventCoordinator.handleWindowClose` (its `PoolContext` / the `LiveSession` that
  registered `onWindowCloseCallback`). Revoke under **both** id spellings, exactly as
  `window-state.ts:280-281` deletes `delegatedGrants` under both — a token minted by
  `create.ts` is keyed by the raw id, one minted by restore by the scoped handle.
  App retire (`features/apps/retire.ts`) inherits the fix for free, since it goes through
  the same close pipeline.
- **Deliberately not done:** revoking the old token on re-mint. Multi-tab is real
  (`SessionSnapshotService` mints per connection); several live tokens per window is the
  design, not the bug. The bug was only that none of them died with the window. Fix the
  `TokenEntry` comments that reason about "the" token as singular.
- The 24h TTL timer stays as the backstop for windows that never see a clean close.

### Behavior deltas (intentional)

| Before | After |
|---|---|
| Closed window's token valid up to 24h | Revoked at close/retire |
| `documentUri` / `extraPermissions` lost on first reconnect | Survive for the window's lifetime |
| Token map grows with reconnect count | Grows with open-window count |

## Phase 2 — one session-principal policy (finding 3)

The two gates disagree because they answer in different currencies (token `systemApp` flag
vs. agent `role`). Decision: **the registry gate is authoritative** — it sits behind both
doors (MCP and `/api/verb` both end in `ResourceRegistry.execute`) — and the definition of
"session principal" widens to what the HTTP gate already implied:

> A caller satisfies `access: 'session-principal'` iff its role is `session` **or** it is
> a token-backed bundled system app.

- `AgentContext` gains `systemApp?: boolean`; `verb.ts`'s `runWithAgentContext` sets it
  from the **validated token** (`tokenEntry.systemApp`) — never from the request body, so
  it is as unforgeable as the token.
- The registry gate becomes `role === 'session' || context.systemApp === true` (via the
  injected resolver, extended from `() => role` to `() => ({ role, systemApp })`).
- `access.ts`'s `isSessionUri` check stays as the cheap early refusal for non-system apps
  (identical behavior), with a comment naming the registry gate as the authority.
- **Decide `yaar://session/agents` explicitly:** tag `handlers/agents.ts:30,79` with
  `access: 'session-principal'` so all seven `yaar://session/*` registrations are uniform.
  process-explorer keeps working — it now qualifies via `systemApp` instead of via the
  accidental gap.

Behavior delta: bundled system apps gain working access to the `session/*` sub-resources
their `app.json` already declares (`session/browser`, `/monitors`, `/context` for
process-explorer) — previously admitted by one gate and 403'd by the other. This is a
capability *widening* for `kind: "system"` bundled apps only (marketplace apps cannot hold
the flag; `getAppMeta` enforces bundled-only). Tests: a system-app iframe can invoke a
tagged handler; a non-system app still 403s at both doors; a monitor agent still 403s at
the MCP door.

## Phase 3 — shrink the drift surface (findings 4, 7, 9, 11, 12)

Mechanical consolidations, each its own small commit:

1. **One `resolveSelf`** (finding 4): export it from `access.ts`; use it at `verb.ts`'s two
   inline copies (main + subscribe). `storageUriFor` keeps its path-flavored expansion but
   gains a cross-reference comment — restructuring it to round-trip through the URI form
   isn't worth the churn.
2. **Shared door prelude** (finding 13): extract the common "parse body → resolvePrincipal
   → insist app" sequence from `/api/verb` and `/api/verb/subscribe` into one helper,
   keeping each door's genuinely different rules (describe-for-anonymous, stream carve-outs)
   at the door.
3. **Shared copy-action shape** (finding 7): one module (e.g. `handlers/storage-copy.ts`)
   exports the copy-payload schema and `copySources(payload): string[]`; `verb.ts`'s
   enforcement loop and both storage handlers (`handlers/storage.ts`,
   `handlers/apps/storage-resource.ts`) import it. A renamed field then breaks the build
   instead of uncovering the check.
4. **One token-extraction rule** (finding 9): export `extractIframeToken` from `access.ts`;
   `auth.ts:hasValidIframeToken` and `server.ts`'s Phase B route gate both call it.
   Behavior delta: a query-param token now also hits the coarse PUBLIC_ENDPOINTS
   allowlist — the safe direction, but **verify first** that every legitimate query-param
   consumer (`<img src>` on `/api/storage/…`, `EventSource`) is on the allowlist, with a
   test per consumer.
5. **Subscription URI contract** (finding 12): make `subscriptionRegistry` itself refuse (or
   resolve) a `self`-bearing URI at both `subscribe` and `notify` boundaries, so the
   "producers always pass resolved URIs" convention becomes checked instead of trusted.
6. **Delete the dead batch branch** (finding 11): `/api/verb` never brace-expands, so
   `toEnvelope`'s `--- uri ---` sniffing branch is dead — remove it, and have the door
   return a pointed error for brace URIs ("brace expansion is MCP-only; send an array
   payload") instead of "No handler registered".

## Phase 4 — optional, separately scheduled (findings 6, 8, 10)

Real refactors with their own risk budgets; none blocks Phases 1–3.

- **Middle-wildcard registration** (finding 8): teach `ResourceRegistry` a
  `yaar://apps/*/storage/…`-style pattern so `handlers/apps/register.ts`'s five-verb
  fallthrough chain becomes four independent registrations. Kills the hand-merged invoke
  schema and the local URI-shape regexes.
- **Consolidate the two setter globals** (finding 6): one `access-wiring.ts` owning both
  resolvers (plus Phase 2's extended one), with an explicit `resetForTest()` — tests stop
  hand-rewiring module globals per file, and a third door reuses instead of copying.
- **`previewBundles` relocation** (finding 10): move the devtools-projects path knowledge
  next to its owner (`features/dev/` or the devtools app boundary), log on the soft-fail
  path so a layout change produces a traceable warning instead of a distant 403, and
  either justify or inline the dynamic `discovery.js` import (comment says nothing; if no
  cycle exists, make it static).

## Sequencing & risk

- **Order:** 0 → 1 → 2, then 3's items in any order, 4 when convenient. Each phase is one
  PR against `dev`; Phase 3 can be one PR of small commits.
- Phases 1 and 2 change behavior on purpose (deltas tabled above); Phase 3 is intended to
  be behavior-preserving except items 4 and 6's error-message/coarse-gate tightening.
- Test partitions: token/grant tests are plain units; anything booting the hub follows the
  existing partition rules (`scripts/test/partitions.ts`).
- Docs to update in the same PRs: `packages/server/CLAUDE.md` (access chokepoint section —
  the token/registry split and the widened session-principal definition),
  `delegated-grants.ts` header, `TokenEntry` comments.
