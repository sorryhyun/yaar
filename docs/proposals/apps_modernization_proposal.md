# Proposal: Apps Modernization — closing the drift between the apps and the platform

**Status:** Phase 0 shipped (2026-07-24). Phases 1–5 and the enforcement guards are open.
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
remount re-registers:

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

### Phase 1 — registration timing (half day)

Move `app.register()`/`registerProtocol()` to a single module-level call in the 5 lifecycle-tied
apps (anima, dc-comics, memo, process-explorer, curious-library-vn). Where registration needs
state that only exists after mount, use the existing `createProtocolContext` seam
(video-editor-lite already demonstrates the pattern). This is mechanical and eliminates the
re-register-on-remount class outright.

### Phase 2 — SDK-primitive adoption sweep (1–2 days)

Per the table above: replace the hand-rolled persisted-signal/panel/loading/errMsg clones with
their SDK equivalents; delete the two hand-maintained `manifest` state keys. Two small SDK
*additions* fall out of the sweep, promoting patterns three apps invented independently:

- `createStaleGuard()` — the generation-counter idiom (dc-comics/github/thesingularity-reader)
  as one helper: `const fresh = staleGuard(); ... if (!fresh()) return;`
- `sanitizeHtml(html, opts?)` — one DOMPurify wrapper with the strict-iframe defaults the four
  bespoke wrappers converge on (forbid `form`/`input`/scripts, strip `javascript:` URLs).

Consolidate the slides-lite/word-lite storage-command twins into a shared helper in the SDK
(`storageIo` command-group factory) or accept the duplication and note it — decide during
implementation based on how identical they still are.

### Phase 3 — trust-boundary validation (1–2 days)

Add `@bundled/zod` schemas at every `JSON.parse`/`readJsonOr` of persisted or external data
(the sites listed under Failure class 1). Convention to adopt everywhere: `readJsonOr` for
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
