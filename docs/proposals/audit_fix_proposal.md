# Proposal: untangle iframe-token lifecycle & verb-flow seams

**Responds to:** `audit_report.md` (2026-08-05)
**Scope:** `packages/server/src` — iframe tokens, window-scoped authority, the session-principal gate, and the drift-surface consolidations around `/api/verb`.

## Phases 0 & 1 — ✅ landed (findings 1, 2, most of 5)

The audit's diagnosis was that window-scoped authority had two competing homes — the token
(frozen at mint) and `WindowStateRegistry` (read per request) — and the token kept losing.
The rule now in force:

> **The token is pure identity** — who this iframe is (window, session, app, monitor) and
> what its manifest declares (`permissions`, `systemApp`, `bundles`, `streams`).
> **`WindowStateRegistry` is the single home of window-scoped authority** — everything a
> caller granted *to this window* at runtime. Identity is re-mintable at will; authority
> survives remount and dies with the window.

It is documented where it is enforced, not here: `packages/server/CLAUDE.md` (access
chokepoint — the split, the three producers, the revocation), `http/iframe-tokens.ts`'s
header, `WindowStateRegistry.delegatedGrants`, and `delegated-grants.ts`'s header.

Pinned by `tests/iframe-token-lifecycle.test.ts` and `tests/iframe-document-access.test.ts`,
both driving the real paths (`handleCreate` for the mint, `LiveSession.generateSnapshot()`
for the reconnect, `actionEmitter` for the close). The eight cases written as `it.failing`
ratchets in Phase 0 all flipped.

### Behavior deltas (intentional)

| Before | After |
|---|---|
| Closed window's token valid up to 24h | Revoked at close/retire |
| Document URI / caller-supplied `permissions` lost on first reconnect | Survive for the window's lifetime |
| Token map grows with reconnect count | Grows with open-window count |
| A storage-served window came back from a refresh as an anonymous principal | Restore prefers the action's own `appId` |

### Four things worth remembering

- **The key had to agree, not just the home.** A create records grants *before* the emit,
  so the window does not exist and `targetKey` resolves nothing — the fallback was the bare
  raw id, which every monitor's copy of the same app resolves to, while the reconnect token
  names the scoped handle. `WindowHandleMap.handleFor` names the handle the create is about
  to register without registering it; `getWindowGrants` unions every spelling on read.
- **The close teardown lives in `LiveSession`'s constructor**, not after pool init. Windows
  outlive the pool (restore replays them; `POST /api/iframe-token` mints against pool-less
  sessions), so revocation wired into `doInitialize` would have been dead for exactly the
  cases the tests pin.
- **The cookie jar is cleared only once nothing holds it** (`clearJarIfOrphaned`). It is
  keyed by (session, app), not by window — clearing on every token drop was harmless while
  the TTL was the only caller, but on window close it would log an app's *other* window out.
- **Not done, deliberately:** revoking the old token on re-mint. Several live tokens per
  window is the design (one per connected tab); the bug was only that none died with the
  window. The 24h TTL stays as the backstop for windows that never see a clean close.

## Phase 2 — ✅ landed (finding 3)

The two gates disagreed because they answered in different currencies (token `systemApp`
flag vs. agent `role`). **The registry gate is the authority** — it sits behind both doors
(MCP and `/api/verb` both end in `ResourceRegistry.execute`) — and the definition of
"session principal" widened to what the HTTP gate already implied:

> A caller satisfies `access: 'session-principal'` iff its role is `session` **or** it is
> a token-backed bundled system app.

It is documented where it is enforced: `packages/server/CLAUDE.md` (access tiers),
`ResourceRegistry.execute`'s gate, `AgentContext.systemApp`, and the widened
`isSessionUri` comment in `http/access.ts`.

- `AgentContext` gained `systemApp?: boolean` (plus the `AccessPrincipal` shape);
  `verb.ts`'s `runWithAgentContext` sets it from the **validated token**
  (`tokenEntry.systemApp`) — never from the request body, so it is as unforgeable as the
  token.
- The injected resolver went from `() => role` to `() => ({ role, systemApp })`, and
  `setAccessRoleResolver` was renamed `setAccessPrincipalResolver` — it no longer resolves
  only a role.
- `handlers/agents.ts`'s two registrations are tagged, so all seven `yaar://session/*`
  registrations are uniform. Process Explorer keeps working via `systemApp` rather than via
  the accidental gap.

Behavior delta: bundled system apps gain working access to the `session/*` sub-resources
their `app.json` already declares — previously admitted by one gate and 403'd by the other.
In-tree that is process-explorer alone (the only bundled app declaring `yaar://session/`);
the widening is unavailable to marketplace apps, since `getAppMeta` sets `systemApp` for
bundled `kind: "system"` apps only. The other half is a *narrowing*: monitor and app agents
lost the ungated reach into `yaar://session/agents/*` (list, interrupt, delete every agent
in the session) that the missing tag left them. Nothing asks for it — the app-agent `relay`
tool is a separate path, and `RELAY_SECTION`, the one prompt naming
`yaar://session/agents/monitor` for non-session agents, is dead code.

Pinned by `tests/session-principal.test.ts` (both doors, including that the flag comes off
the token and not the body) and the widened gate cases in `tests/registry.test.ts`. Both
files wire the *production* resolver rather than a fake: the resolver is a process global
and the unit partition runs its files concurrently, so a fake would decide the gate's answer
for whatever else overlapped it.

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

- **Remaining order:** 3's items in any order, 4 when convenient. Each phase is one
  PR against `dev`; Phase 3 can be one PR of small commits.
- Phase 2 changed behavior on purpose (delta above); Phase 3 is intended to be
  behavior-preserving except items 4 and 6's error-message/coarse-gate tightening.
- Test partitions: token/grant tests are plain units; anything booting the hub follows the
  existing partition rules (`scripts/test/partitions.ts`).
- Docs to update in the same PR: `packages/server/CLAUDE.md` (access chokepoint section —
  the widened session-principal definition).
