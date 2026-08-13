# YAAR Design System

This document is the design **constitution**: the decisions, the model, and the rules.
It deliberately contains **no token values** — values live in one place and are
generated everywhere else. A value table in markdown would just be another palette
waiting to drift.

## The one rule

**Token values are never written by hand anywhere except
`packages/shared/src/design/tokens.ts`.** Every other surface derives from it:

| Surface | How it derives |
|---|---|
| App iframes (`--yaar-*` vars, `y-*` classes) | `buildAppTokensCss()` → re-exported by the compiler as `YAAR_DESIGN_TOKENS_CSS`, injected into every compiled app |
| OS shell (`--color-*`, `--space-*`, …) | `buildShellTokensCss()` → checked-in generated file `packages/frontend/src/styles/base/tokens.css`; a frontend test fails if it's out of sync |
| Agent-facing token reference | `describeDesignTokens()` / `describeDesignTokensBrief()` parse the generated CSS — what agents are told exists is what the compiler injects, mechanically |
| Compile-time token guard | parses the same CSS — what the compiler rejects and what it advertises share one source |
| Shell accent picker | `ACCENT_PRESETS_DATA` from the same module (preset **keys** are persisted in user settings — never rename them) |
| TS code needing a color (canvas, QR, error boundaries) | imports `PALETTE_DARK` / `alpha()` from `@yaar/shared` |

To change the visual language: edit `packages/shared/src/design/tokens.ts`, run
`bun scripts/codegen/design-tokens.ts`, commit both. Tests enforce the rest.

## Decisions

- **Palette: GitHub-dark**, one family across the OS shell and app iframes.
  Decided 2026-07 (previously the shell was Catppuccin Mocha, apps GitHub-dark,
  and the component DSL Tailwind — three palettes for one semantic was the main
  thing this system exists to prevent).
- **Semantics are identical across layers.** Accent, success, error, warning,
  text tiers, spacing, radius, shadows, and the type ramp mean the same thing and
  render the same value in shell chrome and app content. Only background *tint*
  may deliberately differ per surface.
- **Type ramp is 5 canonical steps** (`xs/sm/base/lg/xl`) — the only step names
  that exist. Don't add steps — pick the nearest.
- **Tints are `--yaar-wash-*`, never a baked `rgba()`.** A tinted background or
  border (selected row, status badge, pressed toolbar button) mixes the color
  var with `color-mix()`, at one of three strengths: base, `-strong` for a
  pressed/selected fill, `-border` for a tinted edge. Two things follow that a
  literal cannot give: the tint tracks `.y-light` and any app accent override,
  and every window on screen agrees on how strong "tinted" is. The app fleet
  hand-wrote ~60 of these as GitHub's `#58a6ff` rather than YAAR's accent, so
  the drift this prevents is measured, not hypothetical.
- **Borders are opaque color tokens.** The alpha white/black overlays
  (`--bg-overlay-*`, `--bg-dark-overlay-*`) are the **glass tier** — hover washes,
  scrims, translucent chrome — not a border mechanism.
- **The component DSL paints with semantic tokens.** `variant: "success"` in a
  JSON component and `--yaar-success` in an app resolve to the same hue.
- **Shell CSS names colors semantically only** — `--color-accent`,
  `--color-success`, `--color-danger`, `--color-warning`, and the deliberately
  non-semantic `--hue-*` decoratives. There are no raw hue names
  (`--color-blue`) or `--color-btn-*` aliases; a hue name in shell CSS is a bug.
- **Light theme comes from the same data.** `PALETTE_LIGHT` powers the app-side
  `.y-light` class and the shell light theme; neither is hand-maintained.

## Chrome vs content

The token rules apply to **chrome**: surfaces, text, buttons, borders, badges —
anything that reads as "the UI". They do not apply to **content**: pixels that are
the app's subject matter rather than its frame.

Legitimately hardcoded content: game boards and sprites (minecraft-lite,
falling-blocks), canvas artwork (music-maker piano roll, drawing strokes are
chrome though), chart series colors, spreadsheet cell fills, slide theme palettes,
wallpaper gradients (tuned to harmonize with the base background, but they are
artwork). When in doubt: if swapping the palette should recolor it, it's chrome.

One escape hatch that is *not* drift: colors inside `data:` URIs (inline SVG
placeholders) can't resolve `var()`. Use the token's current value with a comment
naming the token.

## Exception registry

Deviations are legal only if listed here, with a reason:

- **dock** — translucent glass panel, no `y-*` classes. Deliberate: the dock is
  meta-chrome floating over the wallpaper. Uses the glass-tier overlay tokens.

No other bundled app currently has an exception. The registry above is the
mechanism, not a target list — add an entry here when an app genuinely needs
one, with the same reasoning shown for dock.

**No app redefines a `--yaar-*` token**, and the registry above holds no exception for
one. To check: `grep -rn -- '--yaar-[a-z0-9-]*\s*:' apps/*/src` should
return nothing outside `var()` reads.

Defining a *new* `--yaar-*` token in your own `:root` is still supported — the
compiler's token guard deliberately exempts app-declared names, since that is how
the palette gets extended. What is drift is redefining one the compiler already
ships, or shipping a parallel hex palette for chrome. Prefer a non-`--yaar-`
prefix for app-local properties (`--pe-*` in process-explorer, `--sl-*` in
session-logs) so a reader can tell an extension from an override at a glance.

## Where things are

- Canonical data + generators: `packages/shared/src/design/`
- Regeneration: `bun scripts/codegen/design-tokens.ts`
- Sync test: `packages/frontend/src/tests/design/tokens-sync.test.ts`
- Token reference for agents/humans: two tiers in `@yaar/compiler`, both parsed
  from the same injected CSS. `describeDesignTokens()` is the full reference —
  every token with its value, every class grouped by family — served on demand at
  `GET /api/dev/bundled-libraries` (name `design-tokens`).
  `describeDesignTokensBrief()` is what the App Authoring Contract embeds in the
  prompt of every app holding `yaar-dev`: every token *name*, no values, and a
  starter set of classes. Names stay in both tiers because a wrong `--yaar-*` is
  a build error while a wrong `y-*` fails silently — see that function's header.
- Browsable previews: `make design` regenerates tokens + preview cards;
  `make design-preview` serves them at `http://127.0.0.1:4321/previews/` for visual
  review **without running the app** (override with `DESIGN_PREVIEW_PORT`). Also
  published as the "YAAR Design System" project on claude.ai/design.
  - The cards render from the real token module, so **token values** (palette,
    contrast, type ramp, component fills) cannot drift from what ships.
  - The real shell CSS modules (typography / components / forms / renderers) are
    injected verbatim, so **shell styling** is previewed too — not a re-implementation.
    This works only because those files are plain CSS with literal class names (the
    module hashing happens at bundle time). A `composes`/`:global`/`@value` or a
    class-name collision between them would silently break it.
  - Card **markup** is still hand-written, so DOM structure can drift from the real
    components even while the CSS stays honest. Verify structural changes (window
    chrome, grid layout, placement) in the running app.
