# Proposal: Design Refresh — Brighter Dark Theme & Shell Polish

**Status:** Draft
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

## Part 0 — Pre-refactor cleanup: collapse the legacy aliases

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

## Part A — Palette lift: GitHub Dark Dimmed

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

## Part B — Elevation model: windows are cards, not holes

Adopt GitHub's stack: canvas lowest, elevated panels on surface.

- Window body: `--color-base` → `--color-surface`.
- Titlebar: `--color-mantle` → same surface as the body, separated by a
  `1px solid --color-border-muted` bottom border (GitHub overlay-header idiom), title in
  `--color-text` (not muted).
- Window frame gains a `1px solid --color-border` outline so edges survive on bright
  wallpaper areas too.
- Desktop/wallpaper stays on `base`/`bgInset` — it becomes the darkest layer, as it should be.
- App iframes are unaffected (they fill the content area with their own `--yaar-bg`); only
  shell-rendered windows (markdown/text/table/component) change.

This is the single highest-impact change for perceived brightness: it lifts the surfaces
users actually read by two tiers, and compounds with Part A.

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

0. **Part 0 cleanup** — alias migration, delete dead names, regenerate. Pure refactor,
   pixel-identical by construction; everything after it edits only semantic names.
1. **A + B together** (they are one perceived change): edit `tokens.ts`, add emphasis
   tokens to both palettes and both generators, `bun scripts/gen-design-tokens.ts`,
   window-frame CSS. Sync test (`tests/design/tokens-sync.test.ts`) guards the pipeline.
2. **C** — component renderer restyle.
3. **D** — typography ramp.
4. **E** — command palette.
5. **F** — icons + placement.
6. **G** — escape hatches + grandfathered-app conformance; update the exception registry in
   `docs/architecture/design_system.md`.
7. Regenerate design previews (`scripts/gen-design-previews.ts`).

## Open questions

1. **Text brightness**: proposal keeps text punchy (`#cdd9e5`) rather than Dimmed's softer
   default (`#adbac7`). Full-Dimmed is lower-contrast/calmer; decide on screen.
2. **Non-blue accent presets** (lavender/mauve/pink/…): retune for the lighter canvas now,
   or leave until someone complains? Keys are stable either way.
3. **Default window size/cascade** (Part F) touches window-creation defaults the AI also
   controls via OS Actions — confirm the server-side defaults are the right place to fix.

## Out of scope

- Light-theme redesign: inherits emphasis tokens, otherwise untouched.
- Per-app icon artwork.
