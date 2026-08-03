# Proposal: SDK & CSS Consolidation for v1 (De-duplicating the App Fleet)

**Status:** Draft — the prune pass that preceded it landed 2026-08-03 (`showAlert` and the
`clsx`/`konva`/`p5` registry entries removed at zero consumers, `COMPILER_VERSION` 15 → 16).
Its standing rule now lives in `packages/compiler/CLAUDE.md` under "Adding to the
Agent-Facing Surface" and governs every addition below.
**Scope:** `packages/compiler` (shims/yaar, bundled-types), `packages/shared` (design tokens), `scripts/check/apps.ts`, adoption edits across `apps/*` and `user-apps/*`

## Summary

An audit of all 32 apps (13 bundled, 19 user-apps, ~366 source files, 39 CSS files) found
that the SDK/token strategy is working — toasts, stale guards, sanitize, debounce, and
markdown are consolidated, and the top helpers are widely adopted (`errMsg` 20 apps,
`showToast` 16, `appStorage` 15). What remains is a small set of high-frequency, tiny
patterns that apps keep re-implementing by hand.

The proposal is four contained additions and one explicit non-decision:

1. **Five micro-helpers added to `@bundled/yaar`** (~80 lines total): `safeParseOr`,
   `tryToast`, `downloadBlob`/`blobToDataUrl`, `escapeHtml`, and a tiny formatter trio.
2. **Three new CSS utilities** in the design-token layer: theme-following color washes
   (`y-wash-*` + `--yaar-wash-*` tokens), status dots (`y-dot*`), progress bars
   (`y-progress*`).
3. **An adoption pass** swapping hand-rolled code for primitives that already exist
   (`.y-scroll`, `.y-truncate`, `.y-empty`, `createAutosave`, `createKeyState`, SDK
   dialogs, `@bundled/uuid`).
4. **Two warnings in `scripts/check/apps.ts`** so the two systemic-but-diffuse problems
   (hardcoded token-adjacent colors, off-scale spacing literals) stop regressing without
   a big-bang refactor.
5. **No new bundled npm library.** The audit looked for missing libraries specifically and
   found none — every gap is a ≤10-line helper, which is exactly the case for the SDK,
   not a registry entry.

On the size concern: the SDK is compiled into each app by `Bun.build`, which tree-shakes
unused ESM exports. ~80 added lines are noise next to any real library (mermaid alone is
3.3 MB). The failure mode to avoid is not SDK size but SDK *scope* — helpers below the
frequency bar are rejected in **Non-goals**.

## How the evidence was gathered

Three parallel sweeps over `apps/*/src` and `user-apps/*/src`, each cross-referenced
against the actual SDK surface (`packages/compiler/src/shims/yaar/`), its declared types
(`bundled-types/index.d.ts`), and the utility-class source of truth
(`packages/shared/src/design/app-css.ts`): one for duplicated plain-JS helpers, one for
duplicated CSS, one for repeated glue *around* the SDK itself. Adoption counts come from
grepping each exported helper across all app source trees. File references below were
verified during the audit; line numbers are approximate where files have since moved.

---

## Part 1 — SDK additions (`@bundled/yaar`)

Each addition is justified by the same bar: **the pattern appears in 3+ apps (or 10+
sites), the copies are near-identical, and the helper is small enough that its whole
contract fits in a signature.** Everything below clears it; everything that didn't is in
Non-goals.

### 1.1 `safeParseOr` — the parse-or-fallback boundary idiom

The single most repeated code shape in the fleet: 82 `z.safeParse` call sites across 22
apps, of which 15+ reproduce this exact block verbatim:

```ts
const parsed = z.safeParse(Schema, raw);
if (!parsed.success) {
  console.error('[app] bad stored layout', parsed.error.issues);
  return FALLBACK;
}
return parsed.data;
```

It appears in two contexts that share the idiom exactly: reviving persisted JSON
(`apps/storage/src/layout.ts`, `apps/memo/src/store.ts`, `user-apps/github/src/storage.ts`,
`user-apps/slides-lite/src/storage.ts`, `user-apps/word-lite/src/documents.ts`,
`user-apps/dc-comics/src/store.ts`, `user-apps/video-editor-lite/src/editor/prefs.ts`, …)
and validating external HTTP responses (`apps/dock/src/main.ts`,
`apps/market-apps/src/api.ts`, `apps/mcp-manager/src/mcp.ts`,
`user-apps/recent-papers/src/data.ts`). The multi-paragraph rationale comment
("persisted JSON is untrusted input…") is itself copy-pasted across 5–6 `schema.ts`
files and has already begun to drift.

```ts
/** Validate untrusted data at a boundary; return `fallback` (and log) on mismatch. */
export function safeParseOr<S extends StandardSchemaV1>(
  schema: S,
  raw: unknown,
  fallback: StandardSchemaV1.InferOutput<S>,
  opts?: { label?: string }, // log tag, e.g. 'storage:layout'
): StandardSchemaV1.InferOutput<S>;
```

Standard Schema generic, not Zod-specific — consistent with `defineApp`, which already
validates `params` through `~standard.validate`. Lives in a new small `boundary.ts` shim
module (or `ui.ts`). The doc comment absorbs the copy-pasted rationale prose so it is
written once.

### 1.2 `tryToast` — the call-it-toast-the-error wrapper

~50 occurrences of:

```ts
try {
  await doThing();
  showToast('Saved', 'success');   // sometimes
} catch (err) {
  console.error('[app]', err);     // sometimes
  showToast(errMsg(err), 'error'); // always
}
```

Concentrations: `user-apps/chitchats/src/stage.ts` (10 copies in one file),
`user-apps/github/src/actions.ts` (9), `user-apps/thesingularity-reader/src/actions.ts`
(6), `apps/process-explorer/src/data.ts` (5), `apps/mcp-manager/src/main.ts` (5),
`apps/configurations` (5), `user-apps/ocr` (4), `apps/lab` (4).

```ts
/** Run an async action; on failure log it and toast `errMsg(e)`. Sibling of `withLoading`. */
export async function tryToast<T>(
  fn: () => Promise<T>,
  opts?: { success?: string }, // success toast, if any
): Promise<T | undefined>;
```

Composes with the existing `withLoading` rather than replacing it (loading signal and
error toast are orthogonal concerns; call sites that need both nest them). Lives in
`ui.ts` next to `showToast` and `errMsg`.

### 1.3 `downloadBlob` and `blobToDataUrl` — file plumbing

Six copies of the objectURL / `<a download>` / click / revoke dance
(`apps/session-logs/src/components.ts`, `user-apps/excel-lite/src/io-utils.ts`,
`user-apps/image-edit/src/store.ts`, `user-apps/word-lite/src/utils.ts`, and **two**
inside `user-apps/video-editor-lite` — one extracted, one inlined). `word-lite` and
`video-editor-lite` independently extracted it with the *same name and signature*, which
is the clearest possible signal it belongs in the SDK.

Four copies of the `FileReader`-promise wrapper under three different names
(`blobToDataUrl` in chitchats, `fileToDataUrl` in image-edit, inlined in slides-lite and
thesingularity-reader).

```ts
/** Trigger a browser download of `blob` as `filename`. */
export function downloadBlob(blob: Blob, filename: string): void;
/** Read a Blob/File into a data: URL. */
export function blobToDataUrl(blob: Blob): Promise<string>;
```

Both are purely mechanical — zero design decisions to get wrong per-app. Natural home:
`image.ts` sidecar or a new `files.ts` shim module.

### 1.4 `escapeHtml` — six copies, inconsistently safe

Six independent implementations with **diverging coverage**:
`apps/devtools/src/ui/editor.ts`, `user-apps/github/src/markdown.ts`, and
`user-apps/word-lite/src/documents.ts` escape only `& < >` — unsafe if the result ever
lands in an attribute context — while `user-apps/slides-lite/src/markdown.ts` and
`user-apps/recent-papers/src/sanitize.ts` correctly add `"` and `'`. This is the one
duplication with a security edge, and it belongs next to `sanitizeHtml` (`sanitize.ts`),
which is already the documented single DOMPurify policy.

```ts
/** Escape text for interpolation into HTML. Always covers & < > " '. */
export function escapeHtml(s: string): string;
```

`word-lite`'s XML variant (`&apos;` for DOCX serialization) stays local — one consumer,
different target grammar.

### 1.5 `format.ts` — `formatBytes`, `formatDuration`, `formatClock`

Three formatter families, all hand-rolled, all visibly inconsistent across the OS:

| Formatter | Copies | Divergence |
|---|---|---|
| bytes → human size | 4 (`apps/market-apps`, `user-apps/github`, `user-apps/ocr`, `user-apps/studio-3d`) | four different unit ladders and rounding rules — "2.0MB" vs "2 MB" vs "2MB" depending on the app |
| seconds → `mm:ss` / `hh:mm:ss` | 3 (`user-apps/video-editor-lite`, `user-apps/video-viewer-lite`, `user-apps/slides-lite`) | three precisions (one adds centiseconds) |
| timestamp → wall clock | 6 (`apps/devtools`, `apps/process-explorer`, `apps/session-logs`, `user-apps/ai-chat`, `user-apps/dc-comics`, `user-apps/thesingularity-reader`) | half hardcode `'ko-KR'`, half use default locale; one hand-rolls `padStart` |

```ts
export function formatBytes(n: number): string;            // '2.0 MB'
export function formatDuration(seconds: number): string;   // '3:07' / '1:03:07'
export function formatClock(ts: number | Date): string;    // locale HH:MM:SS
```

`@bundled/date-fns` is already bundled and *zero* of these sites use it — pulling a date
library into an app for `HH:mm` is heavier than 20 SDK lines, and a library cannot give
the thing that actually matters here: **one consistent rendering across every window on
screen**. Calendar-date formatting (4–5 more copies of `toLocaleDateString` wrappers)
deliberately stays out of scope — date *style* is a legitimate per-app choice in a way
"2.0 MB" is not; those sites should be pointed at `date-fns` instead.

### Type surface

Each addition gets its declaration in the single `declare module '@bundled/yaar'` block
in `bundled-types/index.d.ts` and its export in the `shims/yaar/index.ts` barrel, per the
existing one-entry-point rule.

---

## Part 2 — Design-token layer additions

Source of truth stays `packages/shared/src/design/tokens.ts` / `app-css.ts`; regenerate
with `bun scripts/codegen/design-tokens.ts`.

### 2.1 Color-wash tokens + utilities (`--yaar-wash-*`, `y-wash-*`)

The largest CSS finding: **63 occurrences across 12+ files** hardcode the literal RGB
decomposition of the accent/success colors for tinted backgrounds and borders —
`rgba(88, 166, 255, α)` and `rgba(63, 185, 80, α)`. Worst offenders:
`user-apps/thesingularity-reader/src/styles.css` (18+6), `user-apps/dc-comics` (8),
`user-apps/slides-lite` (5), `apps/session-logs` (4+4), `user-apps/falling-blocks` (4),
plus `apps/configurations`, `apps/devtools`, `word-lite`, `search`, `github`, `memo`,
`dock`, and raw `#58a6ff`/`#3fb950` in gradients (`ai-chat`, `falling-blocks`,
`excel-lite`).

Two compounding problems:

- Those literals are **GitHub's palette, not ours**: `#58a6ff` vs `--yaar-accent`
  `#539bf5`, `#3fb950` vs `--yaar-success` `#57ab5a`. Apps copied the wash by eye,
  slightly wrong, so the fleet already disagrees with the token layer today.
- They can never follow a theme change. This bites *now*, not hypothetically: `.y-light`
  exists (`app-css.ts:104`) and swaps every `--yaar-*` color var — hardcoded washes stay
  dark-tinted on a light surface.

Fix: define washes with `color-mix()` over the cascading var, so they re-theme for free:

```css
:root {
  --yaar-wash-accent: color-mix(in srgb, var(--yaar-accent) 10%, transparent);
  --yaar-wash-accent-border: color-mix(in srgb, var(--yaar-accent) 35%, transparent);
  --yaar-wash-success: color-mix(in srgb, var(--yaar-success) 10%, transparent);
  --yaar-wash-error: color-mix(in srgb, var(--yaar-error) 10%, transparent);
  --yaar-wash-warning: color-mix(in srgb, var(--yaar-warning) 10%, transparent);
}
.y-wash-accent { background: var(--yaar-wash-accent); }
/* …-success / -error / -warning */
```

Tokens *and* classes, because roughly half the offending sites use the wash inside their
own compound selectors (hover states, borders) where only a var() can reach.

**Follow-through:** the generated utilities themselves bake `alpha(D.accent, 0.1)`
literals today (`y-badge-*`, `y-list-item.active`, `y-btn-danger:hover`,
`y-tbtn-active` — `app-css.ts:92–160`), which have the same doesn't-re-theme defect
under `.y-light`. Once the wash tokens exist, migrate those rules onto them so the
token layer obeys its own rule. (`color-mix` baseline: Chrome 111+, well below what the
iframe runtime already requires.)

### 2.2 Status dot (`y-dot`, `y-dot-ok/-warn/-err`)

Five independent implementations converging on the same 3-line shape (6–8px circle,
`border-radius: 50%`, background = a status token): `user-apps/ai-chat`,
`apps/devtools` (with its own `@keyframes pulse`), `apps/process-explorer`,
`apps/mcp-manager`, `user-apps/studio-3d`. The process-explorer and mcp-manager copies
(`.dot`, `.dot-ok/-warn/-err`) are structurally byte-identical — already a copy-paste
pair. Add `y-dot` + status modifiers, plus `y-dot-pulse` for the animated variant
devtools wants.

### 2.3 Progress bar (`y-progress`, `y-progress-fill`)

Exactly at the 3-app bar: `user-apps/ocr` (track + fill), `apps/browser` (indeterminate
loading bar with its own keyframes), `user-apps/slides-lite` (bare bar). Track =
`--yaar-border`, fill = `--yaar-accent`, height 4px; an indeterminate modifier absorbs
browser's keyframes.

### 2.4 Watchlist — two apps each, do not add yet

Recorded so the *third* consumer triggers extraction instead of another fork:

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
Parts dissolve into 1.5/2.1 above; the scraper-specific remainder should either be
extracted to a shared module or the fork consciously accepted — decided once, because a
third scraper-style app will copy it again. No new bundled library for it until that
third app exists.

---

## Part 4 — Guards in `scripts/check/apps.ts`

Two problems are too diffuse for a manual pass but cheap to stop regressing. Both follow
the existing pattern: `check:apps` **warns**, the compiler's `design-token-guard` keeps
owning hard failures.

1. **Token-adjacent hardcoded colors.** Warn when a hex/`rgb()` literal in app CSS is
   within a small RGB distance of a known token value (catches `#58a6ff`-for-accent
   exactly). Suggest the token or wash var by name, reusing the token list the compiler
   already parses out of `YAAR_DESIGN_TOKENS_CSS`.
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

- `date-fns` is bundled and effectively unused. If Part 1.5 lands, its remaining niche is
  calendar-date formatting; keep it and point the `toLocaleDateString` hand-rollers at it
  via docs rather than adding SDK calendar formatters.

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
- **Calendar-date SDK formatters** — see 1.5; `date-fns` exists for this.

## Rollout

The prune pass landed first, so everything below starts from a baseline with no
zero-consumer surface on it.

1. **Part 2** (tokens + codegen + regenerate) — no app changes required to land.
2. **Part 1** (SDK helpers + `.d.ts` + barrel exports) — contained in
   `packages/compiler`; bumps `COMPILER_VERSION` so apps recompile.
3. **Part 3** adoption pass — one commit per app, each verifiable by that app compiling
   and behaving identically (bundled apps first; user-apps opportunistically). The
   minecraft-lite item also settles `createKeyState`'s adopt-or-remove call.
4. **Part 4** guards — last, so the fleet is mostly clean when the warnings switch on.

Parts 1–2 are the actual v1 blockers-adjacent work; Part 3 can proceed incrementally
after release without breaking anything, since nothing in Parts 1–2 removes or changes
existing surface.

## Open questions

- `tryToast` naming (`notifyErrors`? `toastErrors`?) and whether it should also accept a
  loading signal, folding `withLoading` in — current lean: keep them orthogonal.
- Should `safeParseOr` also have a throwing sibling (`parseOrThrow`) for command handlers
  that want `AppCommandError` on bad input, or is that over-reach for v1?
- Wash percentages: standardize on 10%/35% (background/border) or expose two background
  strengths? The fleet's hand-rolled values cluster at 0.08–0.16.
