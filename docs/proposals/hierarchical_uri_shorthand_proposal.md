# Proposal: Hierarchical URI Shorthand — Principal-Scoped Relative Addressing

Every verb call spells its target in full: `yaar://apps/memo/storage/notes.md`,
`yaar://windows/win-3/state/cells`. The scheme and the identifiers are pure overhead whenever the
caller could not have meant anything else — an app agent naming *its own* app, a window task
naming *its own* window. Meanwhile the agent tree already encodes exactly that context: every
agent stands at a fixed position (session → monitor → app → window task), carried in
`AsyncLocalStorage` (`agents/agent-context.ts`) and consulted on every call for layout injection
and access tiers.

This proposal makes bare paths resolve against that position. The framing in one line:

> **An agent's position in the agent tree is its working directory — immutable, derived from the
> principal, never from conversation state.** Shorthand is **accept-only**: the two verb doors
> normalize it to canonical `yaar://` form before anything else runs, and the canonical form
> remains the only thing permission-checked, logged, fingerprinted, and emitted. There is no `cd`
> verb, and this document argues there must never be one.

---

## 1. What already exists

This is an extension of three mechanisms, not a new idea:

- **The `self` pronoun.** `resolveSelf` (`http/uri-match.ts:149`) rewrites `yaar://apps/self/…`
  to the calling app at the `POST /api/verb` door, before `requirePermission`. Rewrite at the
  boundary, canonical everywhere inside — the exact shape proposed here.
- **App-agent relative storage.** The app namespace's `query`/`command` tools
  (`mcp/app-agent/index.ts`) already accept a bare `storage/reports/x` and resolve it against the
  app's *own* scoped storage, while the full `yaar://storage/…` spelling names the shared root.
  Two spellings, two trees, disambiguated by form — and the result reports the resolved canonical
  URI (`resolvedStorageUri`) so the rewrite is visible to the model.
- **Monitor inference.** `yaar://windows/{windowId}` already omits the monitor — "monitor
  inferred from context" (`packages/shared/src/yaar-uri.ts` header). The system has been quietly
  doing principal-scoped inference since windows existed.

What's missing is doing this *uniformly at the verb layer*, per tier.

## 2. Design: three layers

### Layer 0 — canonical (unchanged)

`yaar://{authority}/{path}` stays the only form that is stored, emitted, logged, and compared.
`resource_link` blocks, session logs, permission entries, reload fingerprints, subscriptions, and
delegated grants never see shorthand. This is non-negotiable for MCP interop (resource URIs must
be real URIs), for deep-link and federation options on the scheme, and for audit legibility.

### Layer 1 — drop the scheme (all tiers)

If the `uri` argument matches

```
^(apps|storage|windows|config|session|user|history|skills|mcp|system|http)(/|$)
```

prepend `yaar://`. The rule is deliberately conservative: `http://example.com` has a colon where
the rule requires a slash, so a real URL mistakenly passed as a `uri` falls through to a clean
"not a yaar URI" error instead of being rewritten into the phantom `yaar://http` authority
(registered in `handlers/http.ts` but absent from the `AUTHORITIES` union — the one collision in
this space). Anything not matching the rule passes through untouched.

Saves ~4–6 tokens per call, every tier, zero context needed.

### Layer 2 — tier-relative bare paths (the hierarchy)

Resolution consults the principal *before* Layer 1, so a narrower tier's meaning shadows the
global one — the same way a process's relative path shadows nothing and surprises nobody, because
which tree you're in follows from who you are:

| Caller | Spelling | Resolves to |
|---|---|---|
| App agent | `storage/{path}` | `yaar://apps/{ownAppId}/storage/{path}` |
| App agent | `db/{path}` | `yaar://apps/{ownAppId}/db/{path}` |
| App agent, window task | `state/{key}`, `commands/{key}` | `yaar://windows/{getWindowId()}/{…}` |
| App agent | `apps/self/…` (Layer 1 + `self`) | `yaar://apps/{ownAppId}/…` |
| Monitor agent | `storage/{path}` | `yaar://storage/{path}` (Layer 1 — shared root) |
| Session agent | everything | Layer 1 only; canonical encouraged |

Three points in that table deserve emphasis:

1. **The `storage/` shadowing for app agents is forced, not chosen.** The app namespace already
   defines `storage/x` as app-relative for app agents. If the verb door resolved the same
   spelling to the shared root, one agent would hold two tools where the identical string names
   two different trees — a trap no prompt wording survives. Tier-relative resolution is what
   makes the spelling *consistent per caller* across every door that caller can reach. (An app
   agent still reaches the shared root the way it already does: the full `yaar://storage/…`
   spelling, admitted only by a covering `app.json` permission.)
2. **The monitor tier honestly gains only Layer 1.** Window ids are session-unique and URIs never
   carry a monitor id, so there is nothing tier-specific to elide. The row exists so the
   hierarchy is stated, not because it does work today; if per-monitor namespaces ever appear,
   this is where their shorthand lands.
3. **`state/{key}` requires a window task context.** `getWindowId()` is set for window-sourced
   tasks. When it is unset (background app-agent work), the call is **refused** with an error
   naming the full spelling — never guessed. A refusal that teaches the canonical form is the
   correct degradation; a heuristic pick of "some window of mine" is exactly the hidden-state
   failure this design exists to avoid.

## 3. Mechanics: one pure function, two doors

```
resolveShorthandUri(uri, principal, { windowId }) → canonical uri
```

placed next to `resolveSelf` in `http/uri-match.ts`, called as the **first** line of both doors:

- **MCP:** `exec()` in `handlers/index.ts` — before `expandBraceUri`, before `recordVerbCall`,
  before `registry.execute`. Ordering matters: `recordVerbCall` fills the tool-call buffer, whose
  one consumer is `providers/claude/message-mapper.ts` — it replays the URI into a sub-agent's
  `task_progress` activity, which carries no tool input of its own — so mixed spellings would
  describe the same call two ways in the tape. (Not the reload cache: that keys off
  `contentHash`/`windowStateHash` and normalized task text, and never sees a verb URI.) (Brace
  expansion composes fine: the prefix the rule inspects precedes any brace, and a degenerate
  `{storage,apps}/x` simply fails to match and errors as today.)
- **`POST /api/verb`:** `http/routes/verb.ts` — as the first statement after the `uri` field is
  validated, which is ahead of the brace refusal, `requirePermission`, the `copy` source gate and
  the existing `resolveSelf`. (The `resolveSelf` call site named above actually sits *after*
  `requirePermission`, which resolves `self` internally on both sides of the match; shorthand
  cannot do that, so it has to be earlier.) Apps drive this door from code, not from a model, so
  they gain nothing from typing shorthand — but the two doors dispatching identical strings
  identically is an invariant worth the one line.
- **`POST /api/verb/subscribe`:** the same file's other branch, for the same one line. A
  subscription URI is a stored *key*: shorthand there would either 403 at the read gate (no
  permission entry matches a scheme-less string) or, past a broad enough grant, register under a
  string no producer ever notifies with — a subscription that never fires.

Results should echo the resolved canonical URI when a rewrite occurred, extending the
`resolvedStorageUri` reporting pattern — the model learns the canonical name of what it touched,
and the transcript stays self-describing.

## 4. Why the working directory must be immutable — no `cd`

A `cd` verb was the obvious alternative and is rejected outright:

- **Hidden mutable state.** After context compaction, session restore
  (`logging/` context restore), or an app agent interleaving two windows, "what is my cwd" is
  precisely the fact a model silently gets wrong — and a relative write then lands on the wrong
  resource instead of erroring.
- **It breaks replay.** `ContextTape` entries are meaningful because each call is
  self-describing; `read('state/cells')` in a restored tape is meaningless without also restoring
  the cwd at that point in time. Principal-derived resolution has no such time dimension: the
  same call from the same principal resolves identically forever.
- **It resolves after the permission check or corrupts it.** Prefix permissions, verb logs, and
  grants all compare URIs; a `cd` adds a stateful resolution step that every one of those
  consumers must be taught about. A pure function at the door adds none.

## 5. Edge cases and refusals

- **Phantom `http` authority** — handled by the conservative Layer 1 rule (§2); additionally,
  `http` remains listable in the rule so `describe('http')` works, while `http://…` never
  rewrites.
- **Relative-path payload fields.** `saveTo` (`handlers/http.ts`) refuses `yaar://`-prefixed
  values to enforce "relative storage path, not URI." Once authority-prefixed shorthand is
  normal, its guard should also refuse values matching the Layer 1 rule, or a model passing
  `storage/downloads/x.jpg` lands in `storage/storage/downloads/`.
- **The root.** `yaar://` root listing keeps requiring the full spelling; the empty string is not
  a URI.
- **`session/` under Layer 1** resolves for everyone but remains gated where it always was —
  resolution is spelling only; `access: 'session-principal'` in `ResourceRegistry.execute()` is
  untouched.

## 6. Honest token accounting

Two caveats before anyone celebrates:

- **Models echo what they are shown.** Results, prompts, and `resource_link`s emit canonical
  URIs, and models copy-paste them. Accept-only shorthand saves tokens only on URIs the model
  *composes* — which is why Layer 2 (eliding ids the model would otherwise have to recall and
  retype) is worth more than Layer 1's flat ~4–6 tokens, and why it also removes a
  mis-addressing failure mode, which is the better half of the argument.
- **The shorthand must be advertised or it is dead code.** The agent profiles
  (`agents/profiles/`) and the URI reference (`docs/reference/uri_reference.md`) currently teach
  the canonical form exclusively. Each tier's prompt should show *its own* table row from §2 —
  and only its own; teaching the app-agent shorthand to a monitor agent invites the wrong tree.

Before Phase 2, measure: sample `session_logs/` and count URI tokens as a share of prompt+output.
If the share is negligible, Layer 2 still stands on the mis-addressing argument, but the doc
should say which argument is carrying it.

## 7. Rollout

1. ~~**Phase 1 — Layer 1.**~~ **Done.** `resolveShorthandUri` (authority rule only) in
   `http/uri-match.ts`, called at all three doors above; the authority list is imported from
   `@yaar/shared`'s new `YAAR_AUTHORITIES` export (plus the phantom `http`) so the rule cannot
   drift from the union. Tests: `packages/server/src/tests/uri-shorthand.test.ts` — the rule
   itself, both doors, brace interplay, `http://` non-rewrite, tool-call-buffer canonicalization,
   and the two spellings producing byte-identical refusals. **Not yet advertised anywhere** (§6),
   so today it is accepted and untaught — Phase 3's job.
2. **Phase 2 — Layer 2 for app agents.** Principal lookup, `state/`-without-window refusal,
   resolved-URI echo, the `saveTo` guard extension.
3. **Phase 3 — advertise + measure.** Per-tier prompt rows in `agents/profiles/`, reference doc
   update, token-share measurement from session logs.

**Non-goals:** a `cd` verb (§4); scheme-less *emission* anywhere; changes to `parseYaarUri` in
`@yaar/shared` (mixed-scheme fields like window content URLs rely on the scheme to
disambiguate — shorthand exists only at the two verb doors); shorthand for the app→`/api/verb`
SDK beyond what already exists (`self`).
