# Proposal: SDK & CSS Consolidation for v1 (De-duplicating the App Fleet)

**Status:** the design-token primitives and their bundled-app adoption landed 2026-08-03
(`COMPILER_VERSION` 16 → 17), as did the prune pass that preceded the proposal (`showAlert`
and the `clsx`/`konva`/`p5` registry entries removed at zero consumers, 15 → 16). The
prune's standing rule now lives in `packages/compiler/CLAUDE.md` under "Adding to the
Agent-Facing Surface" and governs every addition below. Part 3a (the `user-apps/` half of
that migration) landed the same day, across 11 installed apps. Part 1 (the seven SDK
helpers) landed 2026-08-03 as well (17 → 18), and Part 3b — adopting them across 24 apps —
landed the same day, taking `safeParseOr`'s `onInvalid` with it (18 → 19). **Open:** Part 3
(the pre-existing-primitive adoption pass), Part 4 (guards). Landed sections are deleted as
they land rather than annotated, so what is left in this document is the work that is left;
Part 3b keeps a short findings section because Part 3 runs the same play and should not
re-learn what it measured.
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
   `@bundled/uuid` (Part 3). The surface exists now; the ~150 hand-rolled call sites it
   replaces do not know it yet, and an export nothing calls is the state the prune pass
   existed to clean up. Part 3b did this for the seven SDK helpers and is the calibration
   for what Part 3 should expect — read its findings before starting.
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

## What Part 3b measured (landed 2026-08-03)

The seven Part 1 helpers were adopted across 24 apps — 12 bundled (one commit each) and 12
user-apps (recompiled in place). Every helper found real consumers, so none is a candidate
for `createKeyState`'s adopt-or-remove call. What the pass was *for*, though, was the
counter-evidence, and it produced four results worth keeping:

**1. `safeParseOr` had a fixed-logging problem, and it cost adoptions.** Three boundaries
kept their hand-rolled block for the same reason — logging was not the right answer there:
parse-or-throw (~18 sites across 8 apps, including a chitchats helper named `parseOrThrow`;
three agents independently invented an `undefined`-sentinel workaround that logs "using
fallback" on a path that throws), telling the user (configurations' domain allowlist renders
identically whether empty or corrupt), and reporting a *transition* rather than a tick
(ai-chat re-reads shared state every 1.5s). All three are now `onInvalid`, added in response
to this pass — one option rather than a second export.

**2. Counting by shape overcounts.** `tryToast`'s ~50 became ~38: configurations and lab
curate a short static failure message (`'Failed to add'`) instead of surfacing `errMsg(e)`,
and only 2 of ~15 candidate sites across those two apps fit. devtools, storage and
image-edit report through a status bar and have *zero* toast sites. One of `formatClock`'s
six was a formatter with no callers. The rule now lives in `packages/compiler/CLAUDE.md`.

**3. The predicted pixel diffs all happened, plus one bug fix nobody predicted.** `'2 MB'`
→ `'2.0 MB'` (market-apps `'2.00 MB'`, github `'15 MB'` → `'15.0 MB'`); ocr's decimal ladder
became binary, so a 62 MB model reads `'59.1 MB'`; `ko-KR` clocks in ai-chat and
thesingularity-reader lost their 오후 marker. slides-lite's presentation timer had rolled
past an hour as `'75:07'` and now reads `'1:15:07'`.

**4. Three helpers have a documented edge they should not grow into.** `formatDuration`
floors to whole seconds, so video-editor-lite's trim scrubber keeps its own hundredths
formatter (`'00:00.00'`) — the right call, since a scrubber that rounds disagrees with the
file it plays. `escapeHtml` is HTML, so word-lite's DOCX serializer keeps `escapeXml`
(`&apos;`, not `&#39;`). And `safeParseOr` at *module scope* in a `defineApp`-with-Zod-params
app logs on every compile: protocol extraction runs the module graph in the `fold-schemas`
Worker against a `window.yaar` stub whose `read()` returns a truthy inert Proxy, which the
helper correctly reads as present-and-wrong. Worth fixing in the stub, not the helper.

Two things behaved exactly as the plan assumed and need no further note: the three
`& < >`-only `escapeHtml` copies were security fixes rather than swaps (all three fed text
nodes, so nothing rendered differently), and `user-apps/` commits live in each app's own
history with a recompile as the deploy.

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

1. **Part 3** adoption pass — one commit per app, each verifiable by that app compiling
   and behaving identically. The minecraft-lite item also settles `createKeyState`'s
   adopt-or-remove call. The sibling fork's CSS half is already settled (see Part 3); only
   the `helpers.ts` remainder is still a live call, and it blocks nothing.

   Part 3b ran this play first and left two lessons for it. **Expect the site counts to be
   high**: they were gathered by grep, and a matching silhouette is not a matching
   contract — check each one before treating a shortfall as the primitive missing.
   **A non-fit is the finding.** Part 3b's most valuable output was the boundaries that
   refused `safeParseOr`, which is what `onInvalid` came from; an agent that forces the
   swap destroys exactly the evidence the pass exists to collect.
2. **Part 4** guards — last, so the fleet is mostly clean when the warnings switch on.
   Part 3a already did that work: the token-adjacent-color warning now starts life
   effectively quiet, with the only surviving literals being deliberate content
   (falling-blocks' game palette, chart series colors, the slides surface).

All three can proceed incrementally after release without breaking anything, since nothing
landed so far removes or changes existing surface.

## Open questions

- The dc-comics/thesingularity-reader sibling fork: extract the scraper-specific remainder
  to a shared module, or consciously accept the fork? Now the JS half only — Part 3a
  settled the CSS half (see Part 3) and blocks nothing. Part 3b shrank it less than hoped:
  `formatClock` dissolved the clock formatter in thesingularity-reader and deleted a
  *dead* one in dc-comics, but the countdown formatter is a different function and stays.
  What remains forked at ~90% identity is the scraper machinery itself — `normalizeUrl`,
  the lazy-image resolution set, `fetchImageAsBlobUrl`, the sanitize-and-rewrite pipeline,
  the image-error fallbacks — and none of it is a micro-helper the SDK would take.

(Settled: wash percentages — two background strengths, 10% and 16%, plus a 35% accent
border. The reasoning is in `app-css.ts`, including why the scale ships complete for all
four semantic colors rather than only where the chrome consumes it.)

(Settled by Part 1: `tryToast` keeps its name and stays orthogonal to `withLoading` — a
loading flag and an error toast are separate concerns, and a call site wanting both nests
them. `safeParseOr` treats `undefined` as absence and stays silent there, so a fresh
install is quiet even when the fallback would not satisfy the schema — the trap
`createPersistedSignal`'s `revive` documents. `null` is *not* absence, deliberately and
under test: a stored literal `null` is a value that is present and wrong, and the migration
for an app that used `readJsonOr(path, null)` is to pass `undefined` instead.)

(**Corrected by Part 3b:** Part 1 rejected a `parseOrThrow` sibling on the grounds that it
had *zero* hand-rolled call sites. That premise was false — the adoption pass found ~18
across 8 apps, including a chitchats helper named `parseOrThrow`, and three separate agents
independently invented the same `undefined`-sentinel workaround for it. It is still not a
second export: `safeParseOr`'s `onInvalid` covers it, along with the two other boundaries
that had a fixed-logging problem. See "What Part 3b measured" above.)
