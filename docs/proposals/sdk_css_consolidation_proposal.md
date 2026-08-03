# Proposal: SDK & CSS Consolidation for v1 (De-duplicating the App Fleet)

**Status:** the design-token primitives and their bundled-app adoption landed 2026-08-03
(`COMPILER_VERSION` 16 → 17), as did the prune pass that preceded the proposal (`showAlert`
and the `clsx`/`konva`/`p5` registry entries removed at zero consumers, 15 → 16). The
prune's standing rule now lives in `packages/compiler/CLAUDE.md` under "Adding to the
Agent-Facing Surface" and governs every addition below. Part 3a (the `user-apps/` half of
that migration) landed the same day, across 11 installed apps. Part 1 (the seven SDK
helpers) landed 2026-08-03 as well (17 → 18). **Open:** Part 3 (the
pre-existing-primitive adoption pass), Part 3b (adopting Part 1's helpers — the
integration half of the same pass), Part 4 (guards). Landed sections are deleted as they
land rather than annotated, so what is left in this document is the work that is left.
**Scope:** `packages/compiler` (shims/yaar, bundled-types), `packages/shared` (design tokens), `scripts/check/apps.ts`, adoption edits across `apps/*` and `user-apps/*`

## Summary

An audit of all 32 apps (13 bundled, 19 user-apps, ~366 source files, 39 CSS files) found
that the SDK/token strategy is working — toasts, stale guards, sanitize, debounce, and
markdown are consolidated, and the top helpers are widely adopted (`errMsg` 20 apps,
`showToast` 16, `appStorage` 15). What remains is a small set of high-frequency, tiny
patterns that apps keep re-implementing by hand.

What remains is two contained pieces of work and one explicit non-decision:

1. **An adoption pass** swapping hand-rolled code for primitives that already exist —
   `.y-scroll`, `.y-truncate`, `.y-empty`, `createAutosave`, `createKeyState`, SDK dialogs,
   `@bundled/uuid` (Part 3), and the seven helpers Part 1 just added (Part 3b). The surface
   exists now; the ~150 hand-rolled call sites it replaces do not know it yet, and an
   export nothing calls is the state the prune pass existed to clean up.
2. **Two warnings in `scripts/check/apps.ts`** so the two systemic-but-diffuse problems
   (hardcoded token-adjacent colors, off-scale spacing literals) stop regressing without
   a big-bang refactor.
3. **No new bundled npm library.** The audit looked for missing libraries specifically and
   found none — every gap is a ≤10-line helper, which is exactly the case for the SDK,
   not a registry entry.

The CSS half — theme-following washes, status dots, progress bars — is done, as is the SDK
half; what is left is teaching the fleet that both exist.

## How the evidence was gathered

Three parallel sweeps over `apps/*/src` and `user-apps/*/src`, each cross-referenced
against the actual SDK surface (`packages/compiler/src/shims/yaar/`), its declared types
(`bundled-types/index.d.ts`), and the utility-class source of truth
(`packages/shared/src/design/app-css.ts`): one for duplicated plain-JS helpers, one for
duplicated CSS, one for repeated glue *around* the SDK itself. Adoption counts come from
grepping each exported helper across all app source trees. File references below were
verified during the audit; line numbers are approximate where files have since moved.

---

## Watchlist — two apps each, do not add yet

Recorded so the *third* consumer triggers extraction instead of another fork. All three
live in `user-apps/`, and Part 3a passed through every one of them without moving a count —
each was migrated in place and left un-extracted on purpose, so all three still stand at
two consumers:

- `y-skeleton` — dc-comics and thesingularity-reader share a **verbatim** shimmer clone
  (same keyframe name, same gradient stops, same comment wording).
- `y-kbd` — keyboard-hint chips in studio-3d and falling-blocks.
- `y-tree` — file/scene tree rows in devtools and studio-3d (both also hardcode `#fff`
  for on-accent text; if a third tree appears, extract alongside an `--yaar-on-accent`
  token).

---

## Part 3 — Adoption pass (no new surface)

Hand-rolled code that duplicates something that already ships. Mechanical, but touches
many apps — land as one commit per app.

| Existing primitive | Apps still hand-rolling it | Size |
|---|---|---|
| `.y-scroll` | 9 files reimplement `::-webkit-scrollbar` from scratch; **none** of the 9 apply the class (~53 rules) | ~35 lines |
| `.y-truncate` | 41 hand-written ellipsis blocks across 16 files (swap only the pure duplicates; many are folded into larger rules) | ~80 lines |
| `.y-empty` | search, video-viewer-lite, dc-comics each built an `.empty-state` | ~20 lines |
| `y-btn` family | studio-3d rebuilt `.btn/.btn-primary/:disabled` (~30 lines); process-explorer re-derived `.btn-sm`/`.btn-danger` with slightly different values | ~45 lines |
| `.y-modal`/`.y-overlay` | `apps/search/src/styles.css:207` is a near-verbatim reimplementation (storage and github show the correct layer-only-additions pattern) | ~40 lines |
| `createAutosave` | devtools (`ui/editor.ts`), lab (`state/persistence.ts`), ai-chat (`store.ts`) each hand-roll debounced save + flush; only slides-lite adopted it | ~40 lines |
| `createKeyState` | minecraft-lite hand-rolls the held-keys `Set` — including the stuck-key-on-blur bug the helper exists to fix. Adoption: **zero apps**, so this swap is *binding*: if it lands cleanly the helper has earned its place; if it doesn't fit in practice, delete the export and its `KeyState`/`KeyStateOptions` types rather than keep a 0-consumer API | ~15 lines |
| `showConfirm`/`showPrompt`/`showAlert` | ai-chat, excel-lite, word-lite still call blocking native `confirm`/`alert`/`prompt` | — |
| `@bundled/uuid` | lab (`state/signals.ts`) and studio-3d (`scene-doc.ts`) hand-roll `Math.random().toString(36)` ids | — |
| `withLoading` | github and thesingularity-reader repeat the loading/error/finally triad 18× between them; `withLoading` already accepts `(v) => setState('loading', v)` — an adoption/doc gap, not a missing primitive | — |

**The sibling-fork special case:** dc-comics and thesingularity-reader share a forked
~250-line `helpers.ts` at ~90% identity (countdown/clock formatters, lazy-image
resolution, scraped-HTML rewrite pipeline) plus cloned CSS (shimmer, scrollbars, washes).
The clock formatters dissolve into `formatClock`; the cloned CSS is settled (see below). The
scraper-specific remainder should either be extracted to a shared module or the fork
consciously accepted — decided once, because a third scraper-style app will copy it again.
No new bundled library for it until that third app exists.

Part 3a resolved the CSS half by force rather than by choice, and the reasoning is worth
keeping: two separately-installed apps each compile to a self-contained HTML file, so
cloned CSS has **no sharing route between them** except promotion into the token layer —
which is exactly what the `y-skeleton` watchlist defers until a third consumer. So the two
apps were migrated independently, and the shimmer clone stayed cloned. Only the JS fork is
still open, and it does not block anything.

---

## Part 3b — SDK integration (adopting what Part 1 added)

Part 3's sibling: same mechanical shape, same one-commit-per-app rule, but the target is
the surface Part 1 *just* created rather than surface that has existed for months. It is
listed separately because the risk profile is the opposite. Part 3 swaps a hand-rolled copy
for a primitive that already proved itself; here every swap is also the helper's first real
exercise, so a bad fit is a signal about the helper, not just about the app.

Sites are from the audit that justified each helper — the counts are what the bar was
argued on, so an adoption pass that lands far short of them means the helper missed:

| Helper | Adopt at | Count |
|---|---|---|
| `safeParseOr` | persisted JSON: `apps/storage/src/layout.ts`, `apps/memo/src/store.ts`, `user-apps/github/src/storage.ts`, `slides-lite/src/storage.ts`, `word-lite/src/documents.ts`, `dc-comics/src/store.ts`, `video-editor-lite/src/editor/prefs.ts`; HTTP responses: `apps/dock/src/main.ts`, `apps/market-apps/src/api.ts`, `apps/mcp-manager/src/mcp.ts`, `user-apps/recent-papers/src/data.ts` | 82 `safeParse` sites / 22 apps, 15+ verbatim |
| `tryToast` | `user-apps/chitchats/src/stage.ts` (10 in one file), `github/src/actions.ts` (9), `thesingularity-reader/src/actions.ts` (6), `apps/process-explorer/src/data.ts` (5), `apps/mcp-manager/src/main.ts` (5), `apps/configurations` (5), `ocr` (4), `apps/lab` (4) | ~50 |
| `escapeHtml` | `apps/devtools/src/ui/editor.ts`, `github/src/markdown.ts`, `word-lite/src/documents.ts` (all three `& < >`-only — **these are fixes, not swaps**), `slides-lite/src/markdown.ts`, `recent-papers/src/sanitize.ts` | 6 |
| `downloadBlob` | `apps/session-logs/src/components.ts`, `excel-lite/src/io-utils.ts`, `image-edit/src/store.ts`, `word-lite/src/utils.ts`, `video-editor-lite` (two: one extracted, one inlined) | 6 |
| `blobToDataUrl` | chitchats (`blobToDataUrl`), image-edit (`fileToDataUrl`), slides-lite + thesingularity-reader (inlined) | 4 |
| `formatBytes` | `apps/market-apps`, `github`, `ocr`, `studio-3d` | 4 |
| `formatDuration` | `video-editor-lite`, `video-viewer-lite`, `slides-lite` | 3 |
| `formatClock` | `apps/devtools`, `apps/process-explorer`, `apps/session-logs`, `ai-chat`, `dc-comics`, `thesingularity-reader` | 6 |

Four things to watch, because they are where "behaves identically" is not the goal:

- **`escapeHtml`'s three unsafe adopters change output on purpose.** devtools, github and
  word-lite escape only `& < >`; adopting the helper starts escaping `"` and `'` too. Any
  golden-output test there is asserting the bug.
- **`safeParseOr` logs where a hand-rolled copy may have been silent**, and treats
  `undefined` as absence. A site that currently passes a schema-failing fallback through
  `readJsonOr` goes from noisy-on-fresh-install to quiet, which is the intended change.
- **The formatters change pixels.** `'2 MB'` becomes `'2.0 MB'`, a `ko-KR` clock loses its
  오후 marker. That is the point — one rendering per value across every window — but it is a
  visible diff, not a refactor, and worth saying so in the commit.
- **`user-apps/` is git-ignored**, so those commits live in each app's own history and need
  a deploy, exactly as Part 3a did. Bundled apps under `apps/` land in this repo.

`createKeyState`'s adopt-or-remove call (Part 3) is the precedent for what to do if a
helper does not fit in practice: delete the export rather than keep a zero-consumer API.
That applies to anything here that survives the pass unadopted.

---

## Part 4 — Guards in `scripts/check/apps.ts`

Two problems are too diffuse for a manual pass but cheap to stop regressing. Both follow
the existing pattern: `check:apps` **warns**, the compiler's `design-token-guard` keeps
owning hard failures.

1. **Token-adjacent hardcoded colors.** Warn when a hex/`rgb()` literal in app CSS is
   within a small RGB distance of a known token value (catches `#58a6ff`-for-accent
   exactly). Suggest the token or wash var by name, reusing the token list the compiler
   already parses out of `YAAR_DESIGN_TOKENS_CSS`.

   Part 3a left this guard three concrete requirements, each from a site a naive
   literal-scan would have handled wrong:

   - **Follow channel-list indirection.** excel-lite declared `--xl-accent-rgb: 83, 155,
     245` — `--yaar-accent`'s decimal channels — and fed it seven tints as
     `rgba(var(--xl-accent-rgb), .14)`. A `rgba(<digit>` scan matches none of them, and
     they have the exact defect the wash tokens exist to remove. The form appears in one
     app and zero bundled apps today, so the guard should catch it before it spreads.
   - **An exact match is the signal; a near miss is usually deliberate.** In
     falling-blocks the author's own arcade palette (`#58a6ff`/`#b35cff`/`#ff4c68`, reused
     as one identity gradient) sits beside two literals that are bit-for-bit
     `--yaar-warning` and `--yaar-error` — and only those two were chrome. Distance-based
     matching inverts this: a *small but nonzero* distance to a token is weak evidence,
     while an exact hit is strong. Tuning the radius up will flag identity palettes and
     train people to ignore the warning.
   - **It cannot see the content exemption at all.** Chart series colors, canvas brush
     strokes, game sprites, and the slide surface in slides-lite are all legitimate
     literals, and `export.ts`-style standalone output has no token layer for a `var()` to
     resolve against. The warning must be suppressible per file or per line, or it will be
     wrong on every app that draws something.
   - **A fallback literal beside its own token name is correct, not drift.** A canvas
     cannot parse `var()`, so a drawing app resolves tokens at runtime and passes the
     token's own value as the fallback — `colorVar('--yaar-bg', '#161b22')`. music-maker
     has eight of these. They are exact token matches sitting one argument away from the
     token they belong to, so the exact-match signal above fires on every one. The guard
     must not flag a literal whose sibling argument names the matching token.

   Scope note: two of these four come from colors living in **TypeScript**, not CSS
   (`ctx.fillStyle`, a `TRACK_COLORS` array). A CSS-only guard would have missed the
   entire music-maker migration, so this rule needs to read app `.ts` too.
2. **Off-scale spacing literals.** Warn when `padding`/`margin`/`gap` use a bare px value
   that lands exactly on the 4px scale (~180 occurrences across 24 files today). Warn-only
   by design: many literals are legitimate one-off dimensions, so this surfaces new
   drift without demanding a fleet-wide rewrite.

---

## Part 5 — Bundled-library registry: no additions

The audit specifically checked whether any duplication cluster maps to a **missing** npm
library. None does — the gaps are all micro-helpers. The removals in the other direction
already happened (`clsx`, `konva`, `p5`, all at zero consumers); one observation survives
them:

- `date-fns` is bundled and effectively unused. Now that the SDK owns bytes, durations and
  wall clocks, its remaining niche is calendar-date formatting; keep it and point the
  `toLocaleDateString` hand-rollers at it via docs rather than adding SDK calendar
  formatters.

## Non-goals

Rejected on the too-thin / too-divergent / markup-is-cheap bar, recorded so they aren't
re-proposed piecemeal:

- **Loading/empty/error UI components in the SDK** — markup over `y-empty`/`y-spinner` is
  ~5 lines of `html` template; only github bothered to factor it locally. A doc snippet,
  not an SDK export.
- **Polling/interval wrappers** — ~5 sites, each with different interval semantics; a
  wrapper saves ~3 lines.
- **Single-flight `busy()` guards, ResizeObserver glue** — one-liners or
  divergent-by-design.
- **A generic `{ ok, error }` command-envelope type** — the 75 occurrences are mostly
  legitimate domain result shapes; the real guidance is "throw `AppCommandError` for true
  failures," which is a style note for the app-authoring contract.
- **Calendar-date SDK formatters** — `date-fns` exists for this. Date *style* is a
  legitimate per-app choice in a way "2.0 MB" is not, which is why `formatClock` shipped
  and a `formatDate` did not.

## Rollout

The prune pass, the token primitives, and the SDK helpers landed first, so what follows
starts from a baseline with no zero-consumer surface, no hand-rolled washes in `apps/`, and
every primitive the two adoption passes want already exported.

1. **Part 3b** SDK integration — first of the two adoption passes, because its helpers are
   days old and unexercised: every swap is also the evidence that the addition was right,
   and the sooner one of them turns out not to fit, the cheaper it is to delete.
2. **Part 3** adoption pass — one commit per app, each verifiable by that app compiling
   and behaving identically. The minecraft-lite item also settles `createKeyState`'s
   adopt-or-remove call. The sibling fork's CSS half is already settled (see Part 3); only
   the `helpers.ts` remainder is still a live call, and it blocks nothing.
3. **Part 4** guards — last, so the fleet is mostly clean when the warnings switch on.
   Part 3a already did that work: the token-adjacent-color warning now starts life
   effectively quiet, with the only surviving literals being deliberate content
   (falling-blocks' game palette, chart series colors, the slides surface).

All three can proceed incrementally after release without breaking anything, since nothing
landed so far removes or changes existing surface.

## Open questions

- The dc-comics/thesingularity-reader sibling fork: extract the scraper-specific remainder
  to a shared module, or consciously accept the fork? Now the JS half only — Part 3a
  settled the CSS half (see Part 3) and blocks nothing, and Part 1's `formatClock` already
  dissolves the countdown/clock formatters in both copies.

(Settled: wash percentages — two background strengths, 10% and 16%, plus a 35% accent
border. The reasoning is in `app-css.ts`, including why the scale ships complete for all
four semantic colors rather than only where the chrome consumes it.)

(Settled by Part 1: `tryToast` keeps its name and stays orthogonal to `withLoading` — a
loading flag and an error toast are separate concerns, and a call site wanting both nests
them. No `parseOrThrow` sibling: it had zero hand-rolled call sites, which is exactly what
the "Adding to the Agent-Facing Surface" bar in `packages/compiler/CLAUDE.md` rejects; a
command handler wanting `AppCommandError` on bad input declares a `params` schema and gets
it from `defineApp`. `safeParseOr` treats `undefined` as absence and stays silent there,
so a fresh install is quiet even when the fallback would not satisfy the schema — the trap
`createPersistedSignal`'s `revive` documents.)
