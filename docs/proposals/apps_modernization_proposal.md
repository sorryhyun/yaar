# Proposal: Apps Modernization — closing the drift between the apps and the platform

**Status:** Phases 0, 1 and 2 shipped (2026-07-24). Phases 3–5 and the enforcement guards are open.
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
state: a broken storage backend renders identically to "no data."

- `mcp-manager/src/main.ts:183-217` — config load failure looks like "no servers configured"
- `configurations/src/api.ts:13-18` — `loadConfigList` swallows all errors to `[]`
- `process-explorer/src/data.ts:92-156` — `fetchAgents`/`fetchWindows`/`fetchApps`, bare `catch {}`
- `thesingularity-reader/src/auth.ts` — 10 `.catch(() => {})` in one file; later steps assume
  the swallowed step succeeded
- Same app, two policies: `configurations/src/views/domains-view.ts:14-23` toasts on failure;
  the sibling views via `api.ts` do not.

Compounding it, only ~5/25 apps validate JSON at trust boundaries with `@bundled/zod`
(dock, browser-user, market-apps, mcp-manager, recent-papers). Everyone else duck-types:

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

### Phase 3 — trust-boundary validation (1–2 days)

Add `@bundled/zod` schemas at every `JSON.parse`/`readJsonOr` of persisted or external data
(the sites listed under Failure class 1). Phase 2 built the hook this needs:
`createPersistedSignal`'s `revive` is where the `safeParse` goes for anything persisted
through a signal, and it already logs rather than swallowing when it throws. Convention to adopt everywhere: `readJsonOr` for
"missing file is fine," but the parsed value goes through `z.safeParse` with a logged (not
silent) fallback — degraded-by-design must be distinguishable from broken. market-apps and
mcp-manager already model this correctly; copy their shape.

### Phase 4 — design-token compliance (2–3 days)

- process-explorer: delete the local token overrides and `y-*` re-skins; theme through tokens.
- excel-lite, curious-library-vn, recent-papers: adopt `y-btn`/`y-input`/`y-card`/`y-empty`
  where a 1:1 replacement exists; keep genuinely bespoke layout CSS (grids, timelines).
- session-logs: lift the 5 role-color hexes into local CSS vars derived from tokens; collapse
  the 9 repeated `'Courier New'` declarations into one class.
- video-editor-lite CSS: replace `.sb-btn`/`.sb-input` with `y-*`; keep timeline-specific CSS.

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
  presets are legitimate).
- **silent-catch guard** (warning): `catch` block with an empty body and no comment.
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
