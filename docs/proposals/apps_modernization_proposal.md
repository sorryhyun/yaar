# Proposal: Apps Modernization — closing the drift between the apps and the platform

**Status:** Phases 0–4 shipped (0–2 on 2026-07-24, 3–4 on 2026-07-25). Phase 5 and the enforcement guards are open.
**Scope:** `apps/*`, `user-apps/*`, `packages/compiler` (new guards), app-dev agent guidance
**Companion:** [`app_dsl_proposal.md`](./app_dsl_proposal.md) — platform-level changes (defineApp, Zod-first schemas, replay semantics). This proposal is about bringing the *existing* 25 apps up to the conventions the platform already has, and adding enforcement so they stay there.

## Summary

An audit of all 25 apps (~40k LOC: 14 bundled, 11 user-apps) found that nearly every fragile
or repeated pattern is an app **hand-rolling something `@bundled/yaar` already provides**, or
diverging from a convention that exists but is unenforced. The SDK primitives work where they
are used — anima leans on `y-*` classes and ships 98 lines of CSS; video-editor-lite ignores
them and ships 797. The plan: a phased cleanup sweep (security fix first, then SDK-primitive
adoption, registration timing, validation, design tokens, and two architectural outliers),
capped with new compiler guards so the drift cannot silently return.

## Findings

### Failure class 1 — silent degradation

Roughly 5 of 6 apps per group contain bare `catch {}` blocks that collapse errors into empty
state: a broken storage backend renders identically to "no data." **[Phase 3 — done]** for
every site below and for the validation gap under it.

- `mcp-manager/src/main.ts:183-217` — config load failure looks like "no servers configured"
- `configurations/src/api.ts:13-18` — `loadConfigList` swallows all errors to `[]`
- `process-explorer/src/data.ts:92-156` — `fetchAgents`/`fetchWindows`/`fetchApps`, bare `catch {}`
- `thesingularity-reader/src/auth.ts` — 10 `.catch(() => {})` in one file; later steps assume
  the swallowed step succeeded
- Same app, two policies: `configurations/src/views/domains-view.ts:14-23` toasts on failure;
  the sibling views via `api.ts` do not.

Compounding it, only ~5/25 apps validate JSON at trust boundaries with `@bundled/zod`
(dock, browser-user, market-apps, mcp-manager, recent-papers). Everyone else duck-types
— all four sites below fixed in Phase 3:

- `browser/src/sse.ts:90` — `JSON.parse(e.data) as {...}`, no shape check
- `github/src/storage.ts:56-68` — persisted config parsed with `String((parsed as any)?.owner || '')`
- `excel-lite/src/state.ts:251-286` — imported workbook JSON (user-picked files, i.e. untrusted
  external input via `fileAssociations`) parsed with hand-rolled `typeof` checks
- `process-explorer/src/data.ts:84-157` — verb-API list responses cast via `entry: any` heuristics

### Failure class 2 — remount/replay-unsafe protocol registration

The server replays recorded app commands on iframe remount (see companion proposal for the
platform fix). Independent of that, 5 apps tie `app.register()` to component lifecycle, so a
remount re-registers — **[Phase 1 — done]**, along with a 6th the audit missed
(thesingularity-reader):

- inside `onMount`: `anima/src/ui/App.ts:49-65`, `dc-comics/src/main.ts:18-24`,
  `memo/src/main.ts:261-266`, `process-explorer` (root component)
- bare component body, ungated: `curious-library-vn/src/main.ts:128-129`

The safe form (one module-level call) is used by excel-lite, github, image-edit, search,
storage — i.e. the convention exists, half the apps missed it. Additionally,
`recent-papers/src/protocol.ts:70-78` fires `app.sendInteraction` directly from a command
handler with no dedup — a replayed or retried command fires a duplicate agent interaction.
**[Phase 0 — done]** guarded via `recent-papers/src/dedup.ts`. Note for anyone writing the
next such guard: the key **must** be persisted (`appStorage`), not held in a module variable.
Replay happens *after* the remount, which has already wiped module state — an in-memory flag
is dead on arrival.

### Failure class 3 — settle-and-hope async

- `browser-user/src/protocol.ts:44-45` — `SETTLE_MS = 400` before post-action screenshots
- `devtools/src/protocol/build.ts:74-76` — `wait(800)` for a remounted iframe to boot
- `video-editor-lite` — `setTimeout(revokeObjectURL, 5000)` guessing download completion
- Stale-fetch generation counters independently invented three times with different shapes:
  `dc-comics/src/actions.ts` (`fetchVersion`), `github/src/actions.ts` (`repoGen`/`stale()`),
  `thesingularity-reader/src/actions.ts:157-259` (6 manual `version !==` checks in one function)

### Repetition — SDK primitives reinvented

| Existing SDK primitive | Reinvented by |
|---|---|
| `createPersistedSignal` (load-race handled) | `storage/src/layout.ts:18-56` (full ~35-line reimplementation); thesingularity-reader ×3 internally (`store.ts:79-100`, `layout.ts:21-63`, `navOverlay.ts:72-100`) — same app uses the real one two files away |
| `createCollapsiblePanel` | `thesingularity-reader/src/navOverlay.ts:1-104`; dc-comics ×2 (`commentsOverlay.ts`, `navOverlay.ts` — near-identical copies of each other) |
| `withLoading` | used by only 2 apps; `market-apps/src/actions.ts:52-66` hand-rolls `runAction`; most apps toggle flags inline |
| `errMsg` | `mcp-manager/src/main.ts:246` and `process-explorer/src/data.ts:340-382` (×4) revert to manual `instanceof Error` |
| auto-manifest state key | `browser/src/protocol.ts:59-84` and `browser-user/src/protocol.ts:87-106` hand-maintain a `manifest` state entry the framework already derives |

Plus cross-app copy-paste with no shared home: storage read/write command handlers duplicated
line-for-line between `slides-lite/src/protocol/storage.ts:41-163` and
`word-lite/src/protocol.ts:152-262`; four independent DOMPurify wrappers
(dc-comics, github, recent-papers, thesingularity-reader) with divergent allowlists; iframe-token
plumbing solved twice with different rigor (`browser/src/token.ts` typed vs
`browser-user/src/bridge.ts:87-93` `as any`).

Three status-feedback conventions coexist project-wide: SDK `showToast` (≈9 apps), hand-rolled
`statusText` signals (market-apps, search, storage, word-lite, recent-papers), inline error
fields (video-editor-lite). A future author has a coin flip to make; an agent reading two apps
learns two contradictory idioms.

### Outdated — design-system defection and dead architecture

- `video-editor-lite/src/editor/styles.css` — 797 lines, **zero** `y-*` usage; `.sb-btn`
  rebuilds `y-btn` state-for-state. Its UI layer is one mega-`createEffect` calling
  `store.getState()` (re-fires on *any* change) driving 694 lines of imperative DOM patching
  (`editor/render.ts`) — a parallel framework beside Solid.
- `process-explorer/src/styles.css:1-19` — locally **overrides** `--yaar-*` tokens with a
  hardcoded hex palette (43 hex vs 17 token refs), then re-skins `y-btn-ghost`/`y-badge`.
- Zero `y-*` component classes: excel-lite, curious-library-vn, recent-papers.
- `excel-lite/src/ui/grid.ts:53-160` — entire grid via `document.createElement` + manual
  node-Map "reactivity"; `history-utils.ts:4-14` deep-clones the whole workbook per keystroke.
- `word-lite/src/editor.ts:11-15` — deprecated `document.execCommand` for all formatting.
- Dead code: `recent-papers/src/template.ts` + `render.ts` (269 lines, never imported,
  pre-Solid rewrite remnant with 14 hardcoded hex colors). **[Phase 0 — done]** deleted.
- **Security:** `thesingularity-reader/src/credentials.ts:6-14` persists plaintext
  `{username, password}` to `appStorage`; `auth.ts:69-79` persists the raw session cookie.
  **[Phase 0 — done]** password no longer persisted; see Phase 0 below.

## Plan

Ordered by risk-reduction per effort. Each phase is independently shippable.

### Phase 0 — surgical fixes ✅ **DONE** (2026-07-24)

1. **thesingularity-reader credentials** — password no longer persisted. Storage moved from
   `auth/credentials.json` to `auth/account.json` holding `{ v, username, savedAt }`; the
   password lives in a module-level variable for the iframe's lifetime and nowhere else.
   Both auth records now validate through `src/schema.ts` (`@bundled/zod`) and carry a `v: 1`
   tag, with pre-v1 records upgraded in place on read.

   `loadAccount()` **scrubs** rather than merely ceasing to write: a legacy record is migrated
   and the old file overwritten-then-deleted (overwrite first, so a failed unlink still
   neutralizes the plaintext). The real machine's stored password was migrated out at the same
   time; `session.json` was left untouched, so the login survived.

   Renames: type `Credentials` → `SavedAccount`, state `savedCredentials` → `savedAccount`,
   and the agent-facing `credentials` / `saveCredentials` / `loadCredentials` →
   `account` / `saveAccount` / `loadAccount`. `saveAccount` no longer accepts a password at
   all. `login` with no password works only within the session that typed it, surfaced to the
   agent as `account.passwordInMemory`. **Accepted UX cost:** once the session cookie expires
   after a restart, the user retypes the password — the logged-out `LoginPanel` state the app
   already renders. SKILL.md updated to match.

2. **Dead code** — `recent-papers/src/template.ts` and `render.ts` deleted (confirmed
   unreferenced first).

3. **`app.json` hygiene** — `configurations` got a real description; no other placeholder
   descriptions existed. **The audit was wrong about `capture`.** It is not an
   under-applied field: it is dead. `readAppInfo()` (`features/apps/discovery.ts`) whitelists
   the keys it reads and `capture` is not among them, and
   `docs/guides/app-development.md` already listed it under "Ignored fields seen in the wild."
   So it was *removed* from all 14 manifests rather than documented. It also lived in the
   `.claude/agents/app-dev.md` scaffold, which would have regenerated it on every new app —
   removed there too, which is the part that actually stops the drift.

4. **`recent-papers` `recommendTop2Today`** — dedup guard shipped (`src/dedup.ts`), keyed on
   `mode|limit|sorted paper ids`, 90s window, applied to the `app-command` path only; the
   user-facing button stays unguarded, since a second click means a second request. See the
   persistence note under Failure class 2.

**Versions bumped for publishing:** `thesingularity-reader` 1.0.2 → **2.0.0** (major: protocol
commands removed/renamed, and re-login is now required on session expiry), `recent-papers`
1.0.1 → 1.1.0 (dedup suppression is a behavior change), and patch bumps for the manifest-only
edits — `video-editor-lite` 1.2.2, `dc-comics` 1.1.1, `slides-lite` 1.2.3, `word-lite` 1.0.3,
`image-edit` 1.2.1, `excel-lite` 1.0.1. The seven `kind: "system"` bundled apps
(browser, configurations, devtools, dock, market-apps, search, storage) were left at their
current versions — they are not published through the marketplace.

**Verified:** `bun run typecheck` clean across all packages; `bun run build:apps` compiled
every app with 0 failures; extracted `dist/protocol.json` matches the updated SKILL.md;
`bun run check:apps` shows only the 2 pre-existing `no-native-dialogs` advisories. Not
verified by exercise: the runtime login flow and the dedup suppression were not driven
through the browser.

### Phase 1 — registration timing ✅ **DONE** (2026-07-24)

Registration moved to a single module-level call in **6** apps — the 5 the audit listed plus
**thesingularity-reader**, which the audit missed (`src/main.ts:22`, first statement of the
same `onMount(async …)` shape as dc-comics). Confirm the count before believing the audit's
list; the grep that finds them all is `app\.register|registerProtocol` across both app roots.

`createProtocolContext` turned out to be unnecessary: every one of the six registers from
module-scope bindings only (signals, stores, and action functions), so no post-mount state had
to be threaded. The five no-arg cases were a two-line move each. anima was the only one taking
deps — its 14-key `ProtocolDeps` literal moved out of `ui/App.ts`'s `onMount` into a new
`src/app/register.ts` exporting `registerAppProtocol()`, called from `main.ts` at module scope
(mirroring the existing `installHeadlessHook()` wiring). That also freed six now-unused imports
from `ui/App.ts` (`registerProtocol`, `batchGenerate`, `lastBatch`, `lastResult`,
`setLastBatch`, `setLastResult`).

Registering *earlier* than before is safe and was checked, not assumed: `export const app =
y.app` in the SDK shim reads `window.yaar` at module-eval time, and the compiler injects the
SDK as inline synchronous `<script>` ahead of the app bundle — which is why the ~16 apps that
already registered at module scope work. Nothing moved across an `await`, either: in all six,
the call was the first statement of its hook, so no handler-visible state is initialized any
later than before.

**Versions bumped:** memo 1.0.0 → 1.0.1, anima 0.2.0 → 0.2.1, dc-comics 1.1.1 → 1.1.2,
curious-library-vn 1.2.0 → 1.2.1, thesingularity-reader 2.0.0 → 2.0.1. process-explorer is
`kind: "system"` and stays at 1.1.0.

Follow-up: **memo was reclassified `kind: "system"`** right after this phase, so its bump is
moot going forward — it no longer publishes through the marketplace (the catalog copy at 1.0.0
is now orphaned, and install/uninstall of `memo` are refused as protected). That leaves
**video-editor-lite as the only catalogued app under `apps/`**; every other bundled app is
`kind: "system"`. Note the Phase 0 paragraph's "seven `kind: system` bundled apps" list is
stale — there are now 13 of the 14.

**Verified:** `bun run typecheck` clean; `bun run build:apps` recompiled exactly the 6 touched
apps, 0 failures, and their extracted `dist/protocol.json` manifests are unchanged (state /
command / event counts identical — moving the call does not disturb static extraction).

Runtime, in one dev-server run: all six app bundles were loaded as iframes from a same-origin
host page with a `yaar:app-ready` listener attached — **6 apps, 6 handshakes, exactly one
each**, which is the direct observable for "registration fired from module scope." Then memo
and process-explorer were driven as real desktop windows through the palette; `addMemo` +
`memos`/`stats` reads round-tripped correctly.

**A trap worth documenting.** The first end-to-end run showed one `addMemo` writing *two* rows
1 ms apart, with `[AppProtocol] Reply for unknown request … Duplicate reply` in the server log.
This was not the code change: `make claude-dev` auto-opens its own Chrome at localhost:8000, so
the driving tab was a **second connection on the same session** (`Connection added … (total: 2)`),
and both clients relayed the command to their own copy of the iframe. Closing the auto-opened
window and re-running produced exactly one row and zero duplicate-reply warnings. CLAUDE.md
warns about driving YAAR from inside YAAR; this is the adjacent hazard — two live desktop
clients silently double every app command. Check `Connection added … (total: N)` in the server
log before trusting any app-command observation.

dc-comics, thesingularity-reader, curious-library-vn and anima were not driven through their
full UI: the first two need external network/auth (the DC gallery, a site login) and anima needs
WebGPU plus multi-GB weights. Their registration is verified by the app-ready probe above and
their compile is clean, but their command paths were not exercised.

Unrelated pre-existing violation surfaced while checking: `user-apps/dc-comics/src/fetcher.ts:321`
hand-rolls `new Promise(r => setTimeout(r, ms))`, an ERROR-level `no-promise-sleep` hit
(`wait(ms)` from `@bundled/yaar` is the fix). It goes unreported by default because
`check:apps` scans only `apps/*/src` — **the 11 user-apps are outside the checker's default
sweep**, so pass them explicitly when validating a phase.

### Phase 2 — SDK-primitive adoption sweep ✅ **DONE** (2026-07-24)

**Three SDK additions** landed first, since the sweep depends on them
(`packages/compiler/src/shims/yaar/`, declared in `bundled-types/index.d.ts`):

- **`sanitizeHtml(html, opts?)`** (new `sanitize.ts`) — DOMPurify's defaults plus the
  no-forms deviation. Six apps had written that `FORBID_TAGS` list, not four: the audit
  missed storage and slides-lite. **After the sweep, zero apps import `@bundled/dompurify`
  directly.**

  One sharp edge, found only because an agent checked the "redundant" claim instead of
  taking it: the form-control default corrects DOMPurify's *default* allowlist, so applying
  it unconditionally would silently strip a tag an explicit `allowedTags` deliberately
  named — invisible at the call site, which is the exact trap the guide warns about. When
  `allowedTags` is passed, that list is now the whole policy. It happens to be a no-op for
  recent-papers (no form control appears in its allowlist), but that is a fact about its
  list, not a property of the wrapper.

- **`createStaleGuard()`** (in `ui.ts`) — `begin()` (bump + capture), `latest()` (capture
  without bumping), `invalidate()` (bump with no fetch attached). Three primitives rather
  than the proposal's one, because the three apps use three shapes: github reads
  `const gen = repoGen` in six loaders and bumps once elsewhere (`latest` + `invalidate`),
  while dc-comics and thesingularity-reader mostly `++fetchVersion` (`begin`). A single
  `begin()`-only helper would have silently changed github's cancellation semantics.

- **`createPersistedSignal` gained `revive`** — runs on the loaded value before it reaches
  the signal. Without it the two layout modules could not have been collapsed: their
  clamp-on-load and `listWidth` migration have nowhere else to live. It is also where
  Phase 3's `z.safeParse` goes, so that phase now has its hook.

**Swept** — `errMsg` (5 sites: mcp-manager ×1, process-explorer ×4); `withLoading`
(market-apps' `runAction` rebuilt on it, plus `confirmPublish`/`signIn`/`signOut`);
`createPersistedSignal` (storage/layout.ts, thesingularity-reader ×3 — layout, navOverlay's
pin, and `hideSpammer`, whose "can't use createPersistedSignal" comment was true only of the
read path); `createCollapsiblePanel` (thesingularity-reader navOverlay −35 lines, dc-comics
navOverlay −26); `createStaleGuard` (github, dc-comics, thesingularity-reader);
`sanitizeHtml` (6 call sites); both hand-maintained `manifest` state keys deleted.
Also fixed the ERROR-level `no-promise-sleep` in `dc-comics/src/fetcher.ts` that Phase 1
found. Net: roughly −180 lines of app code.

**Versions bumped** (marketplace refuses a publish that is not strictly newer):
thesingularity-reader 2.0.1 → 2.0.2, dc-comics 1.1.2 → 1.1.3, github 1.0.1 → 1.0.2,
recent-papers 1.1.0 → 1.1.1, slides-lite 1.2.3 → 1.2.4, word-lite 1.0.3 → 1.0.4. The
`apps/` side is entirely `kind: "system"` now, so nothing there needed one.

**Generator guidance was updated in this phase rather than deferred**, because a primitive
nothing points at will simply be reinvented: `docs/guides/app-development.md` (the
"Rendering Untrusted HTML" section now teaches `sanitizeHtml`; new `createStaleGuard` and
`revive` entries) and `.claude/agents/app-dev.md` — the scaffold that regenerates into every
new app, which is the lever Phase 0 found actually stops drift.

#### The storage-command twins: accept the duplication (decided)

Not a judgement call about how identical they still are — an SDK-hosted `storageIo` command
group is **impossible**. `extract-protocol-ast.ts` resolves only *relative* imports within
the app and hard-errors on a descriptor imported from a package, and equally on a spread of
a call result. Sharing them would trade a duplicated block for a failed build. Only
`readStorageFile`/`readStorageFiles` were ever identical anyway; `saveToStorage` and
`loadFromStorage` are genuinely deck-vs-document specific. The shareable part is the handler
*bodies*, which are already one-liners over `storage.read` — the duplication that remains is
the `params` JSON Schema, which must be app-local by design.

#### Four things the audit had wrong, and one thing this phase broke

1. **The `manifest` state key was never in the extracted manifest.** Both extractors already
   skip a state key by that name (`extract-protocol-ast.ts:954`, `extract-protocol.ts:444`),
   so the hardcoded arrays only polluted the *runtime* manifest, built by
   `shared/src/iframe-scripts/app-protocol.ts`, which has **no such skip**. Deleting them was
   still right, but the extracted-vs-runtime asymmetry is real and survives this phase — a
   one-line fix that belongs with the enforcement work, since "extracted disagrees with
   runtime" is the failure mode the compiler exists to prevent.
2. **`DetailPanel.ts` has no sanitize call** in either dc-comics or thesingularity-reader —
   only prose mentions. Each app has exactly one choke point (`helpers.ts: processImages`),
   which is the right shape and the reason the swap was clean.
3. **thesingularity-reader's `hideSpammer` is not exposed by the protocol** — no state key,
   no command; its only readers are `PostList` and `SettingsPanel`. The store field was kept
   anyway (both readers are store-based), but the stated justification was wrong.
4. **Counts drift.** process-explorer's `errMsg` sites moved 340-382 → 363-411 (count of 4
   correct); thesingularity-reader's "6 manual `version !==` checks" are actually eight touch
   points. Re-grep, don't trust line numbers.
5. **A regression this phase introduced and then fixed.** Collapsing the layout modules moved
   `reclampPanelWidth` onto a *persisting* setter, so a resize landing before the async load
   would write a clamped default and supersede the stored width — permanent loss of the
   user's preference, reachable because a YAAR desktop window fires resize as it opens. Fixed
   in both apps by making the clamp a property of the *read*: the viewport width is a signal,
   `panelWidth()` clamps on read, and `revive` no longer clamps. Storage now holds the user's
   preference and widening the window restores it — better than the pre-phase behavior, and
   the resize path writes nothing at all.

#### A genuine gap in `createCollapsiblePanel`

dc-comics' `commentsOverlay` could not hand its pin to the SDK. Its pin button sits *inside*
the hover-opened drawer, so unpinning must not clear the hover flag — but `setPin(false)`
calls `close()`, which does, snapping the drawer shut under the cursor. Reproducing the
local behavior needs to read `hovering` at unpin time, and `expanded()` is saturated by
`pinned()` exactly then; the SDK exposes no `hovering()` accessor and no pin setter that
skips `open()`/`close()`. The resolution — panel owns hover, app owns pin — is a sound
decomposition and is behavior-identical, so no SDK change was made. If a second app hits it,
the fix is a `hovering()` accessor rather than more options on `setPin`.

#### Found by verification, outside the audit's list

Running the checker over `user-apps/` (which its default sweep never touches, per Phase 1's
note) found **an XSS vector in word-lite**: a user-picked `.docx`, `.md`, or `.html` file went
straight to `editorEl.innerHTML` unsanitized — and `.html` meant arbitrary markup, in the
iframe that holds word-lite's storage and its agent channel. Fixed at the two choke points
(`setEditorFromHtml`, `appendHtmlFragment`), which also covers documents read back from
storage and the agent's batch-document command; the file handlers now route through them
instead of assigning `innerHTML` directly. Since everything downstream reads the editor back,
sanitizing on the way in makes save, export, and the `content` state key safe by construction.

Also noted but **not** changed: `image-edit/src/store.ts` has two more `instanceof Error`
ternaries (lines 238, 246; the other two return an `Error`, so `errMsg` does not apply). It is
outside the audit's list, its fallback labels are more specific than `String(e)` would be, and
touching it forces a version bump for a cosmetic change.

**Verified:** `bun run typecheck` clean across all packages; `bun run build:apps` — 24 apps,
0 failures; every touched app individually typechecked and compiled, with `dist/protocol.json`
state/command/event counts identical before and after in all of them; 169 compiler tests pass;
`check:apps` back to the 2 pre-existing `no-native-dialogs` advisories, and clean over
`user-apps/` for `no-promise-sleep` and `marked-to-innerhtml` (excel-lite's 5
`infer-handler-params` errors there are pre-existing and untouched).

One tooling fix the sweep forced: `check:apps`'s `marked-to-innerhtml` rule tested
`/\bsanitize\b/`, which `sanitizeHtml` cannot match — the trailing `H` is a word character, so
the boundary never lands — and correct code started failing. Widened to `\bsanitiz\w*`.

**Not verified by exercise:** nothing was driven through the browser. The refactors are
behavior-preserving and compile-verified, but the pin persistence, the width clamp, the
stale-guard cancellations, and word-lite's import paths were reasoned about and typechecked,
not clicked. dc-comics and thesingularity-reader need live external sessions to exercise at
all.

### Phase 3 — trust-boundary validation ✅ **DONE** (2026-07-25)

The convention now holds across both app roots (the audit's 25 apps have since become 28 —
14 under `apps/`, 14 under `user-apps/`): `readJsonOr` for "missing file is fine," but
the parsed value goes through `z.safeParse` with a **logged, not silent** fallback —
degraded-by-design distinguishable from broken. Schemas live in a per-app `src/schema.ts`
with a header naming which boundaries it guards; `z.looseObject` throughout, validating only
the fields the app reads.

**Swept — 12 apps, 12 new/extended `src/schema.ts`:**

| App | Boundary |
|---|---|
| browser | SSE frames from `/api/browser/:id/events` (`url`/`title` reach the URL bar, `version` orders them) |
| configurations | `yaar://config/{shortcuts,hooks,domains,settings}` — the generic `loadConfigList` now takes a schema |
| process-explorer | verb-API `resource_link` vs direct records for agents/windows/apps |
| mcp-manager | no schema work (Phase 0 got it right); its two catches now report |
| memo | the pre-appDb `memos.json` legacy migration |
| storage, thesingularity-reader | `layout.json` (hand-rolled `typeof` → `safeParse`) |
| devtools | project-local `app.json` / `protocol.json` — files a *user's in-development app* wrote |
| video-editor-lite (both copies) | `prefs.json` |
| github | `github/config.json` |
| excel-lite | imported workbook JSON |
| slides-lite | `draft.json` + the storage-read deck parser |
| word-lite | `draft.json` |
| ai-chat | `chat.json`, written by *other live instances* — a real cross-process boundary |
| dc-comics, thesingularity-reader | `settings.json` via `revive` |

**Versions bumped** (final, after the review round below): apps/video-editor-lite 1.2.2 →
**1.2.4**, ai-chat 1.2.0 → 1.2.1, dc-comics 1.2.0 → **1.2.2**, excel-lite 1.1.0 → 1.1.1,
github 1.1.0 → **1.1.2**, slides-lite 1.3.0 → **1.3.2**, thesingularity-reader 2.1.0 →
**2.1.2**, user-apps/video-editor-lite 1.3.0 → 1.3.1, word-lite 1.1.0 → 1.1.1. Everything
under `apps/` except video-editor-lite is `kind: "system"` and exempt.

**Generator guidance updated in-phase** (again: a convention nothing points at gets
reinvented) — a new "Never trust a read either — validate at the boundary" section in
`docs/guides/app-development.md`, a matching anti-pattern bullet, and a "Validate at trust
boundaries" block in `.claude/agents/app-dev.md`. Also fixed drift found while editing: the
anti-pattern list still said "run it through `@bundled/dompurify` first", contradicting
Phase 2's `sanitizeHtml` rule three lines above it.

#### Four things worth knowing before writing the next revive

1. **`revive` runs on the fallback, not on `undefined`.** `createPersistedSignal` calls
   `readJsonOr(key, fallback)` and hands the result to `revive`, so when nothing is stored
   `revive` sees the fallback object. A schema the *fallback itself* fails would log an
   error on every fresh install and every headless compile. (One agent reported this firing
   for word-lite; it did not reproduce — a forced rebuild of that app is silent.)
2. **`revive` must not reinterpret.** Both layout modules were the trap Phase 2 already
   fell into once: converting the hand-rolled `typeof` chain to `safeParse` is where a
   clamp sneaks back onto the *load* path. It stays on the read (`panelWidth()`). Verified
   preserved in both storage and thesingularity-reader, along with the latter's
   `listWidth` → `panelWidth` migration.
3. **Whole-record rejection is usually the wrong default.** video-editor-lite's prefs and
   dc-comics' settings recover per field — a drifted `playbackRate` must not cost the user
   their `lastStorageListPath`, and a `settings.json` predating a field is a legitimate old
   record, not a broken one. The whole-record `safeParse` is the *detector* (it logs); the
   recovery is per field. A mechanical conversion would have silently made these
   all-or-nothing.
4. **Never log or toast from a loop.** process-explorer's fetchers are driven by server
   change pings (many per second on a busy desktop) and ai-chat polls every 1.5s. Both now
   log every failure but surface only the *transition* into a failing state.

#### What the audit had wrong

- **`z.number()` does not accept `NaN`/`±Infinity`** (checked against zod 4.3.6). One
  schema shipped a redundant `Number.isFinite` refinement justified by the opposite claim;
  the claim was removed rather than left as a confidently-wrong comment.
- **excel-lite's `fileAssociations` path is dead.** `app.json` declares
  `"command": "openFile"` and no such command exists — the audit's "untrusted external
  input via `fileAssociations`" describes an intent, not a live path. The live untrusted
  paths (clipboard paste, autosave recovery, `openWorkbookFromStorage`, the `importWorkbook`
  command) are all validated now; the broken association is its own ticket.
- **excel-lite's `storageRead(path, 'json')` has no callers** — all three call sites pass
  `'text'` or `'arraybuffer'`. The parse was made legible anyway and documented as unreached.
- **mcp-manager is both "already validates correctly" and a Failure-class-1 site**, which
  is not a contradiction: the schema existed and was doing real work, and `loadServers` then
  swallowed its own `throw new Error('Malformed MCP config')` one frame later.
- Line numbers drifted again, as every prior phase found. Re-grep.

#### Bugs found and fixed that the audit did not list

- **excel-lite wiped the sheet before validating.** `importWorkbook` called `pushHistory()`
  and cleared `cells`/`styles` *first*, so importing a number or an array destroyed the
  user's workbook and reported success. It now validates before it clears, and returns a
  boolean the XLSX path and the protocol command both check.
- **slides-lite could crash on boot.** `normalizeDeck` does `raw.slides?.length ? raw.slides
  : […]` then `.map`, so a `draft.json` whose `slides` was a truthy non-array (a string)
  took the whole app down. The schema gates it.
- **word-lite's storage read bypassed its own sanitizer.** `loadDoc` assigned
  `editorEl.innerHTML = stored.html` directly, while the comment above `setEditorFromHtml`
  claimed "a document read back out of storage" routed through it. Sanitized-at-rest rather
  than live XSS — every *input* path already sanitizes — but `draft.json` is writable by the
  storage app and by any agent holding that permission, and that path never touched the
  sanitizer. Both branches now go through `setEditorFromHtml`.
- **configurations' domains view could crash the first render.** `read()` resolving to null
  was assigned straight into the signal, and the toggle then read `data().allow_all_domains`.

#### The review round found two criticals — read this before trusting a validation sweep

An adversarial read-only review of the whole sweep caught two defects that compiled,
typechecked and passed every guard. **Both were schemas that were wrong about the data they
guarded**, which is the failure mode this phase's tooling cannot see: a schema is only as
good as the writer's shape, and nothing checks that correspondence.

1. **configurations' `HookSchema` rejected most real hooks.** `HookAction.payload` was typed
   `z.record(z.string(), z.unknown())`, but the server
   (`packages/server/src/features/config/hooks.ts:11-13`) declares it `string` for
   `type: 'interaction'` and `OSAction | OSAction[]` for `type: 'os_action'` — so only the
   single-object form passed. Every `HookFilter` field is `string | string[]` there too, and
   the schema said `string`. Combined with **atomic array validation**, one such hook emptied
   the entire list — including the delete button, the only way a user could have fixed it.
   Fixed by reading the server's types instead of the app's local ones (which were themselves
   narrower than the server, and were widened to match), and by switching `loadConfigList` to
   **per-entry recovery**: a bad row is skipped and reported, the rest render.

2. **video-editor-lite's `revive` rejected whole records while its comments promised per-field
   recovery.** Two separate comments claimed "a single unreadable preference should cost that
   preference, not the whole file"; the code did one whole-record `safeParse` and threw. That
   is a *regression against the hand-rolled `typeof` chain it replaced*, which recovered per
   field. The `user-apps/` copy of the same app had it right — the whole-record parse used
   purely as a detector, then per-field recovery — so the fix was to port that policy.

The general lesson: **a mechanical `typeof` → `safeParse` conversion silently converts
per-field recovery into all-or-nothing.** Check the shape of the recovery, not just the
presence of a schema.

Also fixed in the same round: devtools' `getRuntimeManifest` still had the exact bug its new
schema exists to prevent, fifty lines below the fix (`Object.keys` on a string manifest);
process-explorer's `fetchAgents` rejected the whole roster on one bad row while its two
sibling fetchers recovered per row, and its closed `type` union meant a *newer server adding
an agent tier* would blank the panel; memo deleted `memos.json` even when zero rows migrated;
mcp-manager validated one of the two lists it fetched in the same `Promise.all`, and its
`parseRpcResponse` swallowed the very error it had just thrown; dc-comics' `subscriptions.ts`
still had a silent `catch` around its `JSON.parse` *and* wrote the resulting `[]` back over
the corrupt file; slides-lite logged an error for a legitimate `.txt` import whose content was
a bare JSON scalar.

**Five comments asserted things that were false.** Four claimed `z.looseObject` means an added
field "survives a round-trip through an older build" — it survives the *read*; the reviver
rebuilds an explicit object and the next `set` re-persists that, dropping the key. One claimed
`readJsonOr<{name: string}>` had produced a project named `undefined`, when the old code fell
through to the id. All corrected. A confidently-wrong comment is worse than no comment, and
this phase generated a lot of comments.

**Verified:** `bun run typecheck` clean across all five packages; `cd apps && tsc --noEmit`
clean; `cd user-apps && tsc --noEmit` clean; `bun run build:apps` — 0 failures, and every
touched app's extracted `dist/protocol.json` state/command/event counts identical before and
after. `check:apps` over `apps/` and over each of the 14 `user-apps/` shows only pre-existing
`no-native-dialogs` advisories (2 in `apps/`, 9 across `user-apps/`) — no new findings. Note
that `bun run build:apps` **skips `user-apps/video-editor-lite` entirely**: `autoCompileApps`
dedupes by app id across roots and `apps/` wins, so that copy must be compiled directly.

**Known gaps left open** (all trivial blast radius, recorded so they aren't rediscovered as
findings): `apps/devtools/src/ui/editor.ts` takes a raw boolean through
`createPersistedSignal` with no `revive`, and `apps/devtools/src/services/console.ts` sorts
an unvalidated `invoke<ConsoleEntry[]>` from the previewed app on `a.timestamp`.
thesingularity-reader's `hide-spammer.json` was the third such site and *was* closed, purely
because leaving one inconsistent instance is a worse signal to the next reader than the
toggle is worth.

**Not verified by exercise:** nothing was driven through the browser. The malformed-record
log paths were exercised only through standalone zod harnesses against adversarial inputs
(`5`, `"x"`, `[1,2]`, `null`, `{cells:{A1:3}}`, mixed-validity records), confirming each
lands in the intended branch rather than passing a loose-object check by accident.

### Phase 4 — design-token compliance ✅ **DONE** (2026-07-25)

Six apps swept in parallel (one agent per app group). **No app redefines any `--yaar-*` token
any more** — `grep -rn -- '--yaar-[a-z0-9-]*\s*:' apps/*/src user-apps/*/src` returns nothing
outside `var()` reads, which was not true when the phase started.

| App | Result |
|---|---|
| process-explorer | Tailwind-slate override block and all three `y-*` re-skins deleted; 43 hexes → **1**, token refs 25 → 44. Now themes entirely through the injected palette. |
| session-logs | 11 `'Courier New'` declarations → `y-font-mono` at 14 call sites; 5 role colors → named `--sl-role-*` vars. |
| video-editor-lite (both copies) | `.sb-btn`/`.sb-input`/`.sb-title`/`.sb-divider` now layer `y-btn`/`y-input`/`y-label`/`y-divider` + narrow modifiers for the real deltas. 4 previously unclassed action-row buttons gained classes. |
| excel-lite | **15 byte-identical local classes deleted** in favour of the SDK document-app family (see below); 570 → 496 lines, hexes 16 → 4. |
| curious-library-vn | **Zero swaps, by design** — every control is diegetic. Its `--library-*` palette is now a registered exception instead of unexplained drift. |
| recent-papers | 3 buttons → `y-btn`, 1 input → `y-input`, 4 selects → `y-select`, 2 panels → `y-card`; −18 CSS lines. One hex the audit's CSS-only scan missed (an inline `style` in `main.ts:234`) fixed. |

#### The finding that matters more than the phase: naming the classes narrowed the sweep

excel-lite's first pass concluded **zero adoptable sites** — and was right about the four
classes this line item named. `y-btn` is a bordered, filled, padded text button; every excel-lite
button is a 32px transparent icon button. No 1:1 anywhere.

It had nonetheless hand-rolled **a different SDK family, line for line**. `.tb-btn` duplicates
`.y-tbtn` on every property (`display`, `gap:6px`, `height:32px`, `min-width:32px`,
`padding:0 7px`, `border:1px solid transparent`, radius, `background:transparent`,
`color:--yaar-text-muted`, `font-family`), has a **byte-identical** `:hover`, and an `:active`
whose `rgba(accent, .14)` is exactly what `y-tbtn:active` already ships — the app had even
introduced an `--xl-accent-rgb` var to re-derive a value the SDK computes for it. `.tb-btn-text`
is byte-identical to `.y-tbtn-text`. Fourteen more classes were the same story: `.topbar`/
`y-appbar`, `.brand`/`y-brand`, `.brand-name`/`y-brand-name`, `.header-actions`/
`y-appbar-actions`, `.doc-meta`/`y-doc-field`, `.tb-group`/`y-tgroup`, `.tb-sep`/`y-tsep`,
`.tb-label`/`y-tlabel`, `.tb-select`/`y-tselect`, `.tb-btn.active`/`y-tbtn-active`.

That family carries a comment in `app-css.ts` saying it was extracted for "the document apps
(word-lite, slides-lite)". excel-lite is a document app that never got the memo.

**The lesson for the next sweep: a line item that names specific SDK classes silently scopes
the audit to those classes.** The instruction has to be "diff this app's CSS against the whole
`y-*` inventory", not "adopt `y-btn`/`y-input`/`y-card`/`y-empty`". word-lite and slides-lite
were never checked for the reverse case and should be.

#### A second pattern worth a guard: inert adoption

video-editor-lite was recorded above as having "zero `y-*` usage". False — it already wrote
`class="y-label sb-title"` at every title site. But `.sb-title` re-declared *every* property
`y-label` sets, at equal specificity and later in the cascade, so the SDK class contributed
nothing. Adoption was present and functionally dead.

This is invisible to grep (the class is there), invisible to the compiler (the CSS is valid),
and invisible to a reviewer skimming markup. Fixing it meant *removing* declarations from the
local class, not adding a class. **A guard that flags a local class co-applied with a `y-*`
class while overriding ≥N of its properties would catch it** — worth adding to the enforcement
list below, since nothing else can see it.

#### Where the line item was not followed, and why

- **session-logs' role colors are not "derived from tokens".** No token carries a
  "thinking" / "tool-call" / "interaction" role, and `--yaar-warning` (`#c69026`) is a duller
  caution amber that would make the assistant's voice read as a warning. All five are named
  `--sl-role-*` vars holding their original hex, each with a comment saying why no token fits.
  Deduplicated and explained, not tokenized — the honest outcome.
- **curious-library-vn got no swaps at all.** Grepping for settings/save/load/modal/menu
  surfaced nothing: the app has no non-diegetic chrome. Its 10 hexes were *already* in local
  `--library-*` vars and only lacked justification, which they now have, plus an entry in
  `design_system.md`'s exception registry. It is on the audit's list on a false premise.

#### What the audit had wrong (the streak continues)

- **session-logs has 11 `'Courier New'` declarations, not 9.**
- **`.sb-btn` does not "rebuild `y-btn` state-for-state".** Its base fill is
  `--yaar-bg-surface-hover` (pre-highlighted), its hover is a strong `--yaar-accent-emphasis`,
  and its press is `translateY(1px)` — none of which any `y-btn` variant does. It shares
  *structure* with `y-btn`, not states, so the swap needed a modifier rather than a deletion.
- **excel-lite's "5 pre-existing `infer-handler-params` errors" are 0.** Phase 3's command work
  cleared them; the claim survived in this document as a stale carry-forward from Phase 2.
- **video-editor-lite's token half was already done** before this phase: 0 hexes, 207 token
  refs. The "797 lines, zero `y-*`" framing described the component-class gap only.
- **`design_system.md`'s exception registry was stale in both halves of one bullet.** It
  grandfathered process-explorer's re-skin (removed by this phase) alongside
  **`video-viewer-lite`, which does not exist** — that doc line was the only occurrence of the
  name in the entire repo. The nearest real app, video-editor-lite, defined no tokens at all.
  Registry rewritten; the "grandfathered, not endorsed" bullet is gone.
- Line numbers drifted again. process-explorer was the one app whose measurements matched the
  audit exactly.

#### Visual changes that are real, not just reference changes

The phase's non-goal is "no visual redesigns", but three changes do alter pixels and are
deliberate:

1. **session-logs' monospace face changes** — `--yaar-font-mono` is `'SF Mono', SFMono-Regular,
   ui-monospace, Menlo, Consolas, monospace`, not Courier New. Session IDs, timestamps, tool
   output and the raw transcript all re-render. This is the app ceasing to defect from the
   design system's mono choice.
2. **process-explorer moves from Tailwind-slate to GitHub-dark.** That is the entire point of
   deleting the override.
3. **excel-lite's primary button and recent-papers' radii shift slightly** — excel-lite's
   hardcoded `#58a6ff` had drifted from the current `--yaar-accent` (`#539bf5`); recent-papers'
   hand-rolled 10px/12px radii become the token's 6px. Both are drift corrections.

**Generator guidance updated in-phase** (the third phase running to conclude that a primitive
nothing points at gets reinvented). The root cause of the excel-lite duplication was located
precisely: `docs/guides/app-development.md:376` already documents the document-app chrome family
in full, but `.claude/agents/app-dev.md` — the scaffold that regenerates into every new app, and
which Phase 0 identified as the lever that actually stops drift — listed only the 11 basic
component classes and **never mentioned `y-tbtn`, `y-appbar`, `y-tselect` or the rest**. An agent
reading only the scaffold could not discover them, would try `y-btn` for a toolbar, find it
doesn't fit, and hand-roll the transparent variant. Exactly what happened. The scaffold now
carries the chrome family, an explicit "`y-tbtn` is not `y-btn`" warning citing this incident,
`y-font-mono`, an extend-vs-override section naming the inert-adoption trap, and the rule that
`app-css.ts` is the authoritative inventory and these lists are a summary.

**Versions bumped:** apps/video-editor-lite 1.2.4 → **1.2.5**, user-apps/video-editor-lite
1.3.1 → **1.3.2**, excel-lite 1.1.1 → **1.1.2**, curious-library-vn 1.3.0 → **1.3.1**,
recent-papers 1.2.0 → **1.2.1**. process-explorer and session-logs are `kind: "system"` and
exempt.

**Verified:** `bun run typecheck` clean across all five packages; `cd apps && bunx tsc --noEmit`
and `cd user-apps && bunx tsc --noEmit` both clean; `bun run build:apps` — 26 apps, **0
failures**; every touched app's extracted `dist/protocol.json` state/command/event counts
identical before and after. `check:apps` is back to exactly the Phase 3 baseline — 2
`no-native-dialogs` advisories under `apps/`, 9 across `user-apps/`, every ERROR rule at 0 —
so the sweep introduced no new findings. Independently spot-checked the one failure the
compiler's guard structurally cannot see: **local custom properties are exempt from
`--yaar-*` validation**, so a typo'd `--xl-*`/`--sl-*`/`--pe-*` would silently drop its
declaration. Every local var reference in all six stylesheets resolves to a definition in the
same file. Every surviving hex is a named var definition, a mask-alpha stop, or inside a
comment.

Note for the next phase: agents must **not** run `bun run build:apps` concurrently — it sweeps
every app's `dist/` at once and parallel runs race. A per-app compile wrapper around
`compileTypeScript` is what made five-way parallelism safe; the full sweep runs once at the end.

**Not verified by exercise:** nothing was driven through a browser. Every visual-equivalence
claim above is CSS-cascade reasoning (specificity, declaration order, and the fact that
`transition` is a non-additive shorthand), not a screenshot. Highest-risk if that reasoning is
wrong: video-editor-lite's `.sb-btn` hover/press (its modifier must re-list
`background`/`border-color` alongside `transform` because of the shorthand), the four
video-editor-lite action-row buttons that went from unclassed to `y-btn sb-btn`, and
`y-tbtn`'s `font-weight:600` now reaching excel-lite's icon buttons. One cosmetic nit left
open: excel-lite keeps `.topbar` in markup with no remaining CSS rule.

### Phase 5 — architectural outliers (optional, per-app decision)

Larger rewrites, each its own task, ordered by payoff:

1. **video-editor-lite render layer**: split the mega-effect into per-region effects consuming
   narrow signals; replace hand-diffed node Maps with `<For>`. (~694 lines touched.)
2. **excel-lite**: keep the imperative grid if performance demands it (a spreadsheet grid is a
   legitimate escape hatch) but make the escape *explicit and contained* — one documented
   imperative module with a signal-driven boundary; replace whole-workbook history snapshots
   with per-mutation deltas.
3. **word-lite**: migrate off `execCommand` to explicit `Range`/`Selection` editing commands.

### Enforcement — compiler guards + lint (parallel to phases 1–4)

The compiler's guard infrastructure (`solid-html-guard`, `design-token-guard`, `mount-guard`)
is the one mechanism that has reliably disciplined AI-generated app code. Add:

- **register-scope guard** (hard error): `app.register(...)` reachable from a component/
  `onMount` scope. AST-detectable with the same machinery as `mount-guard`.
- **hex-color guard** (warning): hex literal in app CSS where a `--yaar-*` token has the same
  role; allowlist comment `/* yaar-allow-hex: reason */` for theme swatches (slides-lite's
  presets are legitimate). Phase 4 left the six swept apps at 1/6/0/4/11/0 hexes, all of them
  either a named local-var definition, a mask-alpha stop, or text inside a comment — so the
  guard needs to skip comments and `mask-image` to avoid drowning in false positives.
- **inert-adoption guard** (warning, added by Phase 4's finding): a local class co-applied with
  a `y-*` class in markup while re-declaring that class's own properties at equal specificity,
  so the SDK class contributes nothing. video-editor-lite shipped `class="y-label sb-title"`
  where `.sb-title` overrode every property `y-label` sets. Invisible to grep (the class is
  present), to the compiler (the CSS is valid), and to markup review — nothing but a
  property-level diff can see it.
- **local-custom-prop guard** (warning): the token guard deliberately exempts app-declared
  names, which means a typo'd `--xl-*`/`--sl-*`/`--pe-*` silently drops its declaration exactly
  the way an unknown `--yaar-*` would. Phase 4 had to check this by hand. The same
  declaration/usage machinery already in `design-token-guard.ts` covers it: warn on a `var(--x)`
  with no fallback and no declaration anywhere in the app.
- **silent-catch guard** (warning): `catch` block with an empty body and no comment. Phase 3
  cleared the storage/config/external-JSON reads, so what remains is mostly browser-automation
  best-effort calls (`user-apps/thesingularity-reader/src/auth.ts` has ~14 `.catch(() => {})`
  on `web.click`/`web.scroll`, each genuinely optional) — the guard should therefore be a
  warning with a comment-based opt-out, not an error.
- **interval-leak guard** (warning): `setInterval` without a paired cleanup (`onCleanup`/
  `clearInterval` in scope).
- **direct-dompurify guard** (warning, added by Phase 2's finding): an app importing
  `@bundled/dompurify` instead of `sanitizeHtml`. The count is at zero across all 25 apps as
  of Phase 2, so this one can be promoted to ERROR immediately.
- **runtime/extracted manifest symmetry** (one-line fix, not a guard): the runtime manifest
  builder in `shared/src/iframe-scripts/app-protocol.ts` does not skip a state key named
  `manifest`, while both extractors do — so an app declaring one makes the two manifests
  disagree with no signal. Zero apps do today; the fix is to make the runtime skip it too.

Two of these rules already exist in `scripts/check-apps.ts` rather than the compiler, and
**that checker scans only `apps/*/src` by default** — pass `user-apps` explicitly, or eleven
of the 25 apps go unswept. Phase 2 found an XSS in word-lite that way.

Plus an `apps/.eslintrc` layer for the rules that fit lint better than the bundler
(no `window.yaar` direct access — `video-editor-lite/src/editor/storage-utils.ts:11`;
no `window.prompt`/`alert`/`confirm` — `video-editor-lite/src/editor/edit-mode.ts:266`;
prefer `errMsg` over `instanceof Error` ternaries).

### Generator guidance

Update the app-dev agent guidance (SKILL.md templates + `docs/guides/app-development.md`) with
a "reach for the SDK first" table (persistence → `createPersistedSignal`/`createAutosave`;
panels → `createCollapsiblePanel`; async actions → `withLoading` + `errMsg`; feedback →
`showToast`; lists → `<For>`; sanitization → `sanitizeHtml`) and one canonical registration
example. Also fix the SKILL.md drift found in the audit: dc-comics and excel-lite register
full command sets their SKILL.md never mentions — an agent reading only the skill file cannot
discover their commands.

## Verification

- `bun run typecheck` + per-app compile (`yaar-dev` compile/typecheck) after each phase.
- Phases 1–3 are behavior-preserving; verify by driving each touched app once through the
  browser (open window, exercise one command, reload the iframe, confirm no double effects).
- Guard additions get compiler unit tests alongside the existing guard tests.
- The audit tables above double as the acceptance checklist — each row is done when its
  file references no longer exhibit the pattern.

Two things Phase 0 learned that every later phase inherits:

- **`user-apps/` is git-ignored.** Eleven of the 25 audited apps live there, so changes to
  them leave no git history and no diff to review. Record what changed in this document (or a
  per-app note) — the repo will not do it for you. Only `apps/*` edits show up in `git status`.
- **Publishing requires a version bump.** The marketplace refuses a publish whose `app.json`
  `version` is not strictly newer than the catalog's (`market-apps/src/actions.ts:177-186`),
  so any phase that touches a publishable app must bump it in the same change. `kind: "system"`
  bundled apps are exempt — they ship with the repo, not the marketplace.

Re-verify the audit's claims against current code before starting a phase. Phase 0 found two
of them wrong (`capture` was dead rather than under-applied; the dedup fix could not use the
in-memory approach the finding implied), and both were only caught by reading the code.

## Non-goals

- No new platform capabilities — replay semantics, `defineApp`, and Zod-derived protocol
  schemas are the companion DSL proposal.
- No visual redesigns — token compliance changes what CSS *references*, not how apps look.
- No rewrite of app architecture where the imperative escape hatch is justified (excel-lite's
  grid may stay imperative; it just stops pretending to be reactive).
