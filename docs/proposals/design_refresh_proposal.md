# Proposal: Design Refresh — Brighter Dark Theme & Shell Polish

**Status:** In progress — Part 0 landed (`60352548`), Parts A + B landed (`a547cd94`). C–G outstanding.
**Scope:** `packages/shared/src/design/` (token values, new tokens), `packages/frontend` (window frame, content renderers, desktop, command palette), `apps/*` escape-hatch retune

## Summary

A visual refresh in two movements, preceded by a mechanical cleanup (Part 0) that migrates
all legacy alias usage onto semantic token names so the refresh itself only ever touches
`tokens.ts` and the generators:

1. **Brighten the dark theme** by adopting GitHub **Dark Dimmed** values in `PALETTE_DARK` —
   staying inside the palette family the design system already standardized on.
2. **Fix the shell's visual structure** — the audit below found that the "too dark" feeling
   is only half palette; the other half is an inverted elevation model and a handful of
   rough shell surfaces (component renderer, titlebars, command palette, desktop icons).

No architectural changes. The one-source-of-truth pipeline
(`tokens.ts` → generators → sync test) stays exactly as is; this proposal is about the
*values* flowing through it and the shell CSS that consumes them.

## Motivation: findings from a visual audit (2026-07-18)

Reviewed live at `localhost:8000`: empty desktop, bundled apps (GitHub, Excel Lite),
a maximized window, and AI-generated markdown + component windows.

| # | Finding | Where |
|---|---------|-------|
| 1 | **Elevation is inverted.** Window bodies paint `--color-base` and titlebars `--color-mantle` — the two darkest tokens. Windows are the darkest pixels on screen while floating *above* a lighter wallpaper. | `styles/window/WindowFrame.module.css` |
| 2 | **Titlebars have no identity.** Same near-black as the body, no separator, small muted title. Windows read as holes, not cards. | same |
| 3 | **Component DSL renders in monospace.** The `text` component uses `--font-mono`, so agent-built UIs look like debug panels next to sans-serif markdown windows. | `styles/base/typography.module.css` `.text` |
| 4 | **Primary buttons fail contrast.** White text on `#58a6ff` ≈ 2.5:1. GitHub-dark uses bright hues as *text/link* colors; its button *fills* are darker (`#238636`, `#da3633`). We reuse fg colors as fills. | `--color-btn-*` aliases; `.y-btn-primary` |
| 5 | **Badges stretch to full grid-cell width**, turning pills into murky full-width bars. | component renderer grid |
| 6 | `[Unknown component type]` leaks as raw user-facing text when the agent emits an unknown type. | `ComponentRenderer.tsx:133` |
| 7 | **Markdown headings render at blog scale** against the 13px body — a short note becomes mostly heading whitespace. | `typography.module.css` markdown prose |
| 8 | **Command palette reads as three fragments** — input pill, detached icon cluster, orphaned `>` button — and overlaps maximized window content. | `DesktopSurface` / palette styles |
| 9 | **Desktop icon labels wrap mid-word** ("Configurati ons", "DC 만화 갤러 리" — no `keep-all` for Korean); icon art mixes emoji and thumbnails at different weights. | desktop styles |
| 10 | **Windows spawn stacked at one small top-left rect** — the second window buries the first. | window placement defaults |

What already works: the maximized GitHub app (sidebar, stat cards, badges) is coherent and
clean; shadows, radii, and the status pill are fine. The weak surfaces are precisely the
ones the token system doesn't yet govern: shell chrome and the component renderer.

**Status:** findings 1, 2, and 4 are fixed by Parts A + B. 3, 5, 6 remain (Part C), 7
(Part D), 8 (Part E), 9 and 10 (Part F) — all still reproduce on the post-A+B desktop.

## Part 0 — Pre-refactor cleanup: collapse the legacy aliases ✅ landed (`60352548`)

Before changing any value, make every consumer go through the semantic names. This shrinks
the blast radius of Parts A–C to `tokens.ts` + generators, and makes drift greppable
(after this step, a raw hue name anywhere in shell CSS is by definition a bug).

Current legacy usage in `packages/frontend/src` (measured 2026-07-18):

| Legacy name | Usages | Migrate to |
|---|---|---|
| `--color-blue` / `-hover` | 27 | `--color-accent` / `--color-accent-hover` (or `--color-info` where it means "informational") |
| `--color-red` / `-hover` | 15 | `--color-danger` / `--color-danger-hover` |
| `--color-green` / `-dim` | 17 | `--color-success` (add `--color-success-dim` as a real semantic token for the alpha tint) |
| `--color-yellow` | 3 | `--color-warning` |
| `--color-peach` / `pink` / `mauve` / `lavender` | 14 | decorative hues with no semantic — keep, but rename to an explicit decorative namespace (`--hue-peach`, …) so they can't be mistaken for semantics |
| `--text-md` / `--text-xl` / `--text-2xl` / `--text-3xl` | 36 | canonical 5-step ramp (`--text-base` / `--text-lg` / `--text-xl`→`lg`, `2xl`→`xl`, `3xl`→`xl`) |
| `--color-btn-*` | 3 CSS modules | `--color-primary` / `--color-danger` / … directly (Part A then re-points these to emphasis fills in one place) |

Then delete the dead aliases from `buildShellTokensCss()` and regenerate. Mechanical,
behavior-preserving (every alias resolves to what it aliased), verified by the sync test
plus a screenshot diff of the desktop.

**As landed** — 26 files, all 12 dead names deleted. Notes for anyone reading the diff:

- `--color-accent` had to become a **real value** rather than `var(--color-blue)`: the
  accent-preset picker (`DesktopSurface.tsx`) writes it at runtime, and the name it used
  to write to no longer exists. `--color-primary`/`--color-info` follow through `var()`.
- `--text-xl` changed meaning (15px → the canonical 18px step), so the three prior
  `--text-xl` usages moved to `--text-lg` in the same pass. Values preserved.
- `--color-blue` mapped uniformly to `--color-accent`; the `--color-info` split the table
  suggests was deferred, since both resolve identically until Part A gives them distinct
  values — a judgment better made when it's observable.
- Verified in-browser rather than only by test: all 12 dead names undefined, every
  semantic computing to its original hex, and the preset override still cascading to
  `--color-primary`/`--color-info`.

## Part A — Palette lift: GitHub Dark Dimmed ✅ landed (`a547cd94`)

Swap `PALETTE_DARK` to Primer dark-dimmed values. Every hex below is from Primer's
`dark_dimmed` scale, not hand-tuned:

| Token | Current | Proposed | Note |
|---|---|---|---|
| `bg` | `#0f1117` | `#22272e` | canvas.default |
| `bgInset` | `#0a0c10` | `#1c2128` | canvas.inset |
| `bgSurface` | `#161b22` | `#2d333b` | canvas.overlay |
| `bgSurfaceHover` | `#1c2129` | `#373e47` | neutral hover |
| `text` | `#e6edf3` | `#cdd9e5` | gray-0 — one step softer, still crisp (see Open questions) |
| `textSubtle` | `#c9d1d9` | `#adbac7` | fg.default |
| `textMuted` | `#8b949e` | `#768390` | fg.muted |
| `textDim` | `#6e7681` | `#636e7b` | fg.subtle |
| `accent` | `#58a6ff` | `#539bf5` | accent.fg — slightly desaturated for the lighter bg |
| `accentHover` | `#79c0ff` | `#6cb6ff` | blue-2 |
| `border` | `#30363d` | `#444c56` | borders must lift with the canvas or they vanish |
| `borderMuted` | `#21262d` | `#373e47` | |
| `borderHover` | `#3d444d` | `#545d68` | |
| `borderStrong` | `#484f58` | `#636e7b` | |
| `success` | `#3fb950` | `#57ab5a` | |
| `error` | `#f85149` | `#e5534b` | |
| `errorHover` | `#ff7b72` | `#f47067` | |
| `warning` | `#d29922` | `#c69026` | |

**New tokens — emphasis fills** (fixes finding 4). GitHub separates `*.fg` (text on dark)
from `*.emphasis` (fill under white text). We currently conflate them:

| Token | Dark (dimmed) | Light | Used by |
|---|---|---|---|
| `accentEmphasis` | `#316dca` | `#0969da` | primary button fill |
| `successEmphasis` | `#347d39` | `#1f883d` | success button fill |
| `dangerEmphasis` | `#c93c37` | `#cf222e` | danger button fill |

`--color-btn-primary`/`--color-btn-danger`/`--color-btn-success` re-alias to the emphasis
tokens; `.y-btn-primary` (app CSS) switches to `accentEmphasis`. The bright `accent`/`error`
hues remain the text/link/border colors they were always meant to be.

Secondary adjustments in the same pass:

- **Overlays**: white-alpha glass tiers (`0.05/0.08/0.1/0.15`) read weaker on a brighter
  canvas — bump each one tier (≈ `0.06/0.10/0.13/0.18`), eyeball the dock.
- **Shadows**: keep as-is initially; `rgba(0,0,0,0.3–0.5)` may look heavy on the lighter
  canvas — judge on screen, soften only if needed.
- **Accent presets**: `blue` preset value follows `accent` (`#539bf5`/`#6cb6ff`). Other
  preset *keys* are persisted — values may be retuned later, keys never change.
- `PALETTE_LIGHT` is untouched except for gaining the three emphasis tokens.

**As landed** — measured contrast for white text on each fill (WCAG AA needs 4.5):

| Fill | Before | After |
|---|---|---|
| primary button | **2.53** | **5.03** |
| danger button | — | 5.02 |
| success | — | 5.07 |

Two things the proposal didn't anticipate:

- **Every accent preset needed its own emphasis pair**, not just the three palette
  tokens. Filled buttons paint the emphasis token now, and the preset picker only wrote
  `--color-accent` — so a static emphasis would have silently broken the picker, tinting
  links but leaving every primary button blue. `ACCENT_PRESETS_DATA` gained
  `emphasis`/`emphasisHover` per key (all ≥ 5.0:1 on white) and `DesktopSurface` writes
  all four properties. Preset keys unchanged, so persisted settings are unaffected.
- **`COMPILER_VERSION` 7 → 8 is mandatory.** Apps bake the design tokens in at compile
  time and `isAppStale()` judges staleness from app source + `app.json` alone, so a token
  change reaches no existing `dist/`. Without the bump every installed app keeps the
  near-black canvas and paints `.y-btn-primary` with a token its baked-in CSS never
  defines. Caught by inspecting a live app iframe still reporting `--yaar-bg: #0f1117`.
  **Any future part that touches `tokens.ts` or `app-css.ts` needs the same bump.**

Also worth recording: the preset picker writes *inline* styles on `documentElement`, so a
chosen accent shadows the light-theme rule for `--color-accent{,-emphasis}`. That is
pre-existing behavior (presets are deliberately theme-independent), not a Part A
regression — but it means light-theme accent values in `tokens.css` are only ever seen
when no preset override is active.

## Part B — Elevation model: windows are cards, not holes ✅ landed (`a547cd94`)

Adopt GitHub's stack: canvas lowest, elevated panels on surface.

- Window body: `--color-base` → `--color-surface`.
- Titlebar: `--color-mantle` → same surface as the body, separated by a
  `1px solid --color-border-muted` bottom border (GitHub overlay-header idiom), title in
  `--color-text` (not muted).
- Window frame gains a `1px solid --color-border` edge so it survives on bright
  wallpaper areas too. **As landed this is an inset `outline`, not a `border`**: `.frame`
  is absolutely positioned from stored width/height and there is no `box-sizing:
  border-box` reset, so a real border would grow every window by 2px and desync the
  drag/resize math. `outline` + `outline-offset: -1px` is identical visually and
  layout-free. (The titlebar's new bottom border is fine because it got an explicit
  `box-sizing: border-box` to hold its 36px height.)
- Desktop/wallpaper stays on `base`/`bgInset` — it becomes the darkest layer, as it should be.
- App iframes are unaffected (they fill the content area with their own `--yaar-bg`); only
  shell-rendered windows (markdown/text/table/component) change.

This is the single highest-impact change for perceived brightness: it lifts the surfaces
users actually read by two tiers, and compounds with Part A.

### A + B post-landing review (2026-07-18, via `make design-preview`)

Re-verified against source and the generated preview cards, no app run required:

- **Part A values match the table exactly** in `tokens.ts` — all 18 palette entries plus
  the three emphasis pairs. Measured contrast reproduces the claimed numbers: primary
  5.03, danger 5.02, success 5.07 (old primary 2.53), body text 8.89 on the window
  surface and 10.48 on canvas.
- **Part B matches its description** in `WindowFrame.module.css`: `.frame` paints
  `--color-surface` with the inset `outline` + `outline-offset: -1px`, and `.titleBar`
  shares that surface with a `1px --color-border-muted` bottom border, `box-sizing:
  border-box` holding 36px, title in `--color-text` at weight 500.
- Two values land just under WCAG AA for normal text and are worth a look when Part C/D
  touch them: `--color-text-muted` on surface is **3.29**, and the accent link colour is
  **4.47** (AA needs 4.5). Both are fine for large or secondary text; neither is a
  regression from Part A (each improved), but neither reaches AA either.

Two harness bugs found and fixed during this review, both in
`scripts/gen-design-previews.ts`:

1. The light-theme card never received the `y-light` class — `page()` accepted a `light`
   flag and the writer read it back through a `(c as { light?: boolean })` cast, but no
   card ever set it. The cast silenced the type error that would have caught it, so the
   card rendered dark while claiming to demonstrate the light palette. `cards` now has an
   explicit element type and the cast is gone.
2. The window-chrome mock still encoded the **pre-Part-B** elevation (body on
   `--color-base` inside a `--color-mantle` desktop) — the exact inversion Part B fixed.
   Updated to mirror the shipped frame.

Bug 2 exposed the harness's real limit: it loaded only the token generators, so it
previewed token *values* but no shell CSS at all — meaning Parts C and D would have been
invisible in it. Addressed in the same pass by injecting the four shell CSS modules
verbatim and adding a Component DSL card, which reproduces findings 3 and 5 directly.
Card markup stays hand-written, so structural changes (window chrome, grid layout,
placement) still need the running app.

Note for Part C: finding 5's cause is grid, not the badge rule. `.badge` is correctly
`display: inline-flex`, but a grid item is blockified and stretched by the default
`justify-self: stretch` — so the fix belongs on the item, as the part already proposes.

## Part C — Component DSL restyle

The component renderer is the AI's primary UI-building surface and currently its worst-looking one.

- **Sans by default**: `.text` drops `--font-mono`; `variant: "code"` keeps it. Headings/
  subheadings align to the shell type ramp (below).
- **Buttons**: emphasis fills per Part A. Ghost/secondary buttons keep surface fills.
- **Badges**: `justify-self: start` (or an inline wrapper) so pills never stretch to the
  grid cell; progress stays full-width.
- **Unknown component fallback**: replace the raw `[Unknown component type]` span with a
  muted, bordered placeholder chip naming the type (`unsupported: gauge`) — visible enough
  to debug, quiet enough to not wreck the window.

## Part D — Window typography ramp

Markdown/text renderers currently use display-scale headings inside 13px-body windows.
Cap the in-window ramp at the token scale: h1 → `--text-2xl` (18px), h2 → `--text-lg`,
h3 → `--text-base` bold; tighten heading margins accordingly. Same numbers for the DSL
`heading`/`subheading` variants (currently `--text-3xl`/`--text-xl`).

## Part E — Command palette unification

One bar, one surface: merge the icon cluster, input, and Send into a single glass container
(`--bg-glass` + `--color-border`), and dock the orphaned `>` toggle onto the bar's right
edge. Maximized windows reserve bottom inset so the palette never floats over content.

## Part F — Desktop polish

- Icon labels: wider label box, `word-break: keep-all` (Korean), `overflow-wrap: normal`,
  2-line clamp with ellipsis.
- Icon art: uniform tile treatment behind emoji glyphs (consistent size/radius/background)
  so emoji and image icons carry the same visual weight. Per-app art replacement is out of
  scope.
- Window placement: cascade offset (~28px steps) from a centered origin instead of a fixed
  top-left rect; default size up from the current small rect (roughly 380×290 observed) to
  something content-viable (~640×480).

## Part G — Escape-hatch retune

Per the design constitution, these hardcodes are legal but tuned to the old base and need a
pass after Part A:

- Wallpaper gradients (currently fade to near-black — the corner gloom amplifies finding 1).
- `data:` URI colors (greppable — each carries a comment naming its token).
- dc-comics / thesingularity-reader brand orange: re-check contrast on `#22272e`.
- **Grandfathered apps** (`process-explorer`, `video-viewer-lite`): conform them to the
  palette in this refresh and delete their exception-registry entries, rather than carrying
  the grandfather clause into the new theme.

## Rollout order

Each step lands independently; screenshots before/after per step.

0. ✅ **Part 0 cleanup** — alias migration, delete dead names, regenerate. Pure refactor,
   pixel-identical by construction; everything after it edits only semantic names.
1. ✅ **A + B together** (they are one perceived change): edit `tokens.ts`, add emphasis
   tokens to both palettes and both generators, `bun scripts/gen-design-tokens.ts`,
   window-frame CSS, bump `COMPILER_VERSION`. The sync test
   (`packages/frontend/src/tests/design/tokens-sync.test.ts` — not `tests/design/`)
   guards the pipeline.
2. **C** — component renderer restyle. Findings 5 and 6 are both plainly visible in the
   post-A+B desktop, so this is the next-highest-value step.
3. **D** — typography ramp.
4. **E** — command palette.
5. **F** — icons + placement.
6. **G** — escape hatches + grandfathered-app conformance; update the exception registry in
   `docs/architecture/design_system.md`.
7. Regenerate design previews (`make design`; review with `make design-preview`).

## Open questions

1. ~~**Text brightness**~~ — **resolved**: shipped punchy (`#cdd9e5`), which measures
   8.89:1 on the new window surface. Still trivially reversible in `tokens.ts` if it reads
   harsh in daily use; nothing else depends on the choice.
2. **Non-blue accent presets** — **partly resolved**: each preset now carries an
   `emphasis` pair tuned for white-text contrast, so filled buttons are handled. The
   *base* `color`/`hover` hues are still the old GitHub-dark values on a lighter canvas
   and may want a retune. Keys are stable either way.
3. **Default window size/cascade** (Part F) touches window-creation defaults the AI also
   controls via OS Actions — confirm the server-side defaults are the right place to fix.
4. **New:** should the token pipeline fail loudly when `tokens.ts` changes without a
   `COMPILER_VERSION` bump? The coupling is currently only a comment in
   `build-manifest.ts`, and the failure mode is silent and easy to miss — apps look
   subtly stale rather than broken. A test hashing `YAAR_DESIGN_TOKENS_CSS` against a
   value pinned to the compiler version would close it.

## Out of scope

- Light-theme redesign: inherits emphasis tokens, otherwise untouched.
- Per-app icon artwork.
