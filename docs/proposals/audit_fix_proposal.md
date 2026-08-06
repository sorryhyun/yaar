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

## Phase 3 — ✅ landed (findings 4, 7, 9, 11, 12, 13)

Six mechanical consolidations, one commit each. Each is documented where it is enforced —
`packages/server/CLAUDE.md`'s access-chokepoint section and the headers of the modules
named below — not here.

1. **One `resolveSelf`** (finding 4). Exported from `access.ts`, with `namesSelf` as its
   counterpart: `resolveSelf` returns the URI untouched when there is no appId to expand
   against, so testing the *result* is how each door decides whether that is fatal. Both
   of `verb.ts`'s inline copies collapse to two lines. `storageUriFor` keeps its
   path-flavored expansion and gains the cross-reference.
2. **Shared door prelude** (finding 13). `openVerbDoor` owns "read the body, resolve the
   caller"; `requireApp` (access.ts, third caller `requireBundledApp`) owns "insist it is a
   real app" and returns the narrowed `AppPrincipal`. Each door's genuinely different rules
   stayed at the door — folding them in would make one helper answer "may this caller in?"
   two ways depending on a flag.
3. **Shared copy-action shape** (finding 7). `handlers/storage-copy.ts` owns the action
   name, the `from` schema, the refusal wording and `copySources()`. It found live drift:
   the composite `yaar://apps/*` registration listed `copy` in its action enum and declared
   no `from` property at all.
4. **One token-extraction rule** (finding 9). `extractIframeToken` exported from
   `access.ts`; `auth.ts` and `server.ts`'s Phase B gate both call it.
5. **Subscription URI contract** (finding 12). `subscribe` throws on a `self`-bearing URI;
   `notifyChange`/`publishFrame` log and carry on.
6. **Delete the dead batch branch** (finding 11), and refuse a brace URI at the door by
   name.

### Behavior deltas (intentional)

| Before | After |
|---|---|
| A query-param token skipped the coarse route allowlist | It meets the same gate as a header token |
| `/api/verb` with a bad verb *and* a bad token reported the verb | Reports the identity failure — the more accurate of two refusals |
| `yaar://storage/{a,b}` → "No handler registered for …" | "Brace expansion is MCP-only", plus what this door does batch |
| A `self`-bearing URI reached the subscription registry silently | Refused at `subscribe`, logged at `notifyChange`/`publishFrame` |

Item 4 was the only one needing verification rather than reading: the tightening is safe
only if every legitimate query-param consumer is on `PUBLIC_ENDPOINTS`. All are — storage
files and listings, app static files (the iframe document itself), PDF page rasters,
browser screenshots, browser events — and `tests/iframe-token-extraction.test.ts` holds one
row per consumer, driving the real fetch handler.

Also pinned by `tests/self-resolution.test.ts`, `tests/verb-door-prelude.test.ts`,
`tests/storage-copy-shape.test.ts`, `tests/subscription-uri-contract.test.ts`, and new rows
in `tests/verb-envelope.test.ts`. All plain units.

**Not done, deliberately:** finding 5 (authority assembled in three layers). It is a
description of the Phase 0/1 design rather than a defect — frozen-at-mint identity,
per-request grants, per-check canonicalization are three layers because they have three
different lifetimes. Consolidating them would undo the split that fixed findings 1 and 2.

## Phase 4 — optional, separately scheduled (findings 6, 8, 10)

Real refactors with their own risk budgets; none blocks Phases 1–3.

- **Middle-wildcard registration** (finding 8): teach `ResourceRegistry` a
  `yaar://apps/*/storage/…`-style pattern so `handlers/apps/register.ts`'s five-verb
  fallthrough chain becomes four independent registrations. Kills the hand-merged invoke
  schema and the local URI-shape regexes.
- **Consolidate the two setter globals** (finding 6): one `access-wiring.ts` owning both
  resolvers (plus Phase 2's extended one), with an explicit `resetForTest()` — tests stop
  hand-rewiring module globals per file, and a third door reuses instead of copying.
- **`previewBundles`** (finding 10): the traceability and import halves are ✅ **landed**;
  the relocation is **not done, deliberately** (below).

### Finding 10, in detail

Two of the three parts landed, pinned by new rows in `tests/preview-bundles.test.ts`:

- **The soft-fail path now says something — on the two paths where silence is a bug.**
  `previewBundles` has five ways to return `undefined` and three are ordinary (not a
  preview at all, which is most calls; the project declares no bundles; the project is
  gone), so a blanket log would be noise on the common path. The two anomalies warn: a
  project id that would climb out of the directory, and a manifest that *exists* and will
  not parse (an extra `exists()` only on the failure path distinguishes it from a missing
  file). The traceable message the finding actually wanted is at the **403**, not the
  mint: `requireBundle` gives a preview principal its own wording, because the generic one
  names "app.json" and for a preview that is the *project's* file, not an installed app's.
  That is where the developer hitting the refusal is standing; the mint that came up empty
  happened windows ago.
- **The dynamic `discovery.js` import is now static.** There is no cycle: `discovery.ts`'s
  runtime import closure is 11 modules and reaches neither `http/access.ts` nor
  `http/iframe-tokens.ts` — its only edge back into `http/` is `import type
  { PermissionEntry }`, which erases. That type-only edge is the whole reason the cycle
  stays hypothetical, so it now carries a comment saying it must stay type-only; turning it
  into a value import would fail as an undefined binding at module init, not as a build
  error.

**Not done, deliberately: the relocation.** `features/dev/` is not the owner — nothing in
it mentions `projects` at all. The real owner is the devtools *app*
(`apps/devtools/src/lib/paths.ts`), across a boundary the server cannot import, so moving
the string one directory over renames the layering violation without removing it. The
duplicate worth attention is a different one: `http/routes/dev.ts` reads the same `bundles`
key off the same file for the same reason at compile time, but *generically* —
`resolveAppPath(callerAppId, path)`, no `devtools` anywhere — while the token mint
hardcodes the layout. Single-sourcing that pair is the real version of this finding; both
readings now cross-reference each other in comments. Reading from disk stays either way: a
preview window reloaded after a server restart re-mints with no compile in front of it, so
anything cached at compile time is back to failing soft.

## Sequencing & risk

- **Remaining:** findings 8 and 6 of Phase 4, when convenient — the two that remove real
  structural duplication. Finding 10 is closed. All are independent of each other and of
  everything above.
- Phases 2 and 3 changed behavior on purpose; each phase's deltas are tabled in its own
  section.
- Test partitions: token/grant tests are plain units; anything booting the hub follows the
  existing partition rules (`scripts/test/partitions.ts`).
- Docs live where the behavior is enforced — `packages/server/CLAUDE.md`'s access
  chokepoint section plus the module headers — and were updated with each phase.
