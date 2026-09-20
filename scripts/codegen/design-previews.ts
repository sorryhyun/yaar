/**
 * Generates the design-system preview cards, in the two envelopes they are read in.
 *
 *   bun scripts/codegen/design-previews.ts
 *     → dist/design-previews/previews/*.html   browsable over http, `make design-preview`
 *     → dist/design-previews/project/          a Design-canvas Artifact: *.dc.html + canvas.json
 *
 * Renders from the SAME generators that style the product (@yaar/shared design
 * module), so neither envelope can drift from what ships — and because both are
 * built from one `CARD_CSS` and one set of card bodies, they cannot drift from
 * each other either.
 *
 * The canvas is the surface that closes the loop: it is the only one that can send
 * a comment back to a Claude Code session (ArtifactComments), so a change asked for
 * on a card can be made in tokens.ts and regenerated here. The claude.ai/design
 * project this script used to feed had no such channel and is no longer published;
 * see docs/architecture/design_system.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAppTokensCss } from '../../packages/shared/src/design/app-css.ts';
import { buildShellTokensCss } from '../../packages/shared/src/design/shell-css.ts';

/**
 * `dist/` by default, which is where `make design-preview` serves from.
 *
 * Overridable because publishing the canvas has to read the generated files back,
 * and `.claude/settings.json` denies reads under `dist/` — deliberately, to keep
 * build output out of an agent's context. An agent republishing the canvas points
 * this at its own scratchpad instead; nothing else cares where the files landed.
 */
const OUT = process.env.YAAR_DESIGN_OUT ?? join(import.meta.dir, '../../dist/design-previews');
mkdirSync(join(OUT, 'previews'), { recursive: true });

// Strip @font-face — the OTF files are served by the YAAR server, not claude.ai.
const stripFonts = (s: string) => s.replace(/@font-face\s*\{[^}]*\}/g, '');
const appCss = stripFonts(buildAppTokensCss());
const shellCss = stripFonts(buildShellTokensCss());

/**
 * Shell CSS modules, injected verbatim so cards preview the REAL shell styling and
 * not a re-implementation of it. The token generators above emit only custom
 * properties; everything the shell actually paints (component renderer, prose,
 * form controls) lives in these modules, so without them Parts C/D of the design
 * refresh would be invisible here.
 *
 * Safe because these are plain CSS with literal class names — the hashing that
 * makes them "modules" happens at bundle time, not in the source. Verified: no
 * `composes`/`:global`/`@value`, no class-name collisions between the four files
 * or against the app CSS. If that ever changes, this concatenation is what breaks.
 *
 * Card markup is still hand-written, so DOM structure can drift from the real
 * components even while the CSS stays honest. Structural changes (grid layout,
 * window placement) must be verified in the running app.
 */
const SHELL_MODULES = [
  'packages/frontend/src/styles/base/typography.module.css',
  'packages/frontend/src/styles/base/components.module.css',
  'packages/frontend/src/styles/base/forms.module.css',
  'packages/frontend/src/styles/window/renderers.module.css',
];
const shellModuleCss = SHELL_MODULES.map((p) =>
  readFileSync(join(import.meta.dir, '..', '..', p), 'utf8'),
).join('\n');

/**
 * Everything both envelopes paint with: the two generated token blocks, the real
 * shell modules, and the few scaffold rules the card bodies below use. One const
 * so a browsable preview and its artboard twin cannot disagree about any of it.
 */
const CARD_CSS = `${shellCss}
${appCss}
${shellModuleCss}
.demo{padding:var(--yaar-sp-4);display:flex;flex-direction:column;gap:var(--yaar-sp-4)}
.demo-row{display:flex;align-items:center;gap:var(--yaar-sp-3);flex-wrap:wrap}
.demo-note{font-family:var(--yaar-font-mono);font-size:var(--yaar-text-xs);color:var(--yaar-text-dim)}`;

/** The card surface itself — on <body> in a preview, on the frame in an artboard. */
const CARD_SURFACE =
  'background:var(--yaar-bg);color:var(--yaar-text);font-family:var(--yaar-font);font-size:var(--yaar-text-base);line-height:1.5';

function page(opts: { title: string; body: string; light?: boolean }): string {
  const { title, body, light } = opts;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${CARD_CSS}
html,body{margin:0;height:100%}
body{${CARD_SURFACE}}
</style>
</head>
<body class="${light ? 'y-light' : ''}">
<div class="demo">
${body}
</div>
</body>
</html>
`;
}

/**
 * The .dc.html envelope, shared by both kinds of artboard: a token card and a phone
 * screen differ only in the `frame` they hand it.
 *
 * Three things the format requires that the preview envelope does not: the
 * `support.js` head line verbatim, a root element sized exactly to the board's frame
 * in canvas.json, and a `$preview` that agrees with it. What was `<head>` becomes
 * `<helmet>`.
 *
 * Deliberately no `data-props` levers. A tweak knob would let someone recolor the
 * picture without touching tokens.ts, which is precisely the drift this system exists
 * to prevent: the canvas is a mirror of the code, not a place to edit the palette.
 */
function dcPage(opts: { title: string; frame: string; w: number; h: number }): string {
  const { title, frame, w, h } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
${CARD_CSS}
body{margin:0}
</style>
</helmet>
${frame}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() {
    return {};
  }
}
</script>
</body>
</html>
`;
}

/**
 * A token/component card: the generator supplies the frame, and `.y-light` rides on
 * it rather than on <body> — which works because that class only declares custom
 * properties, so descendants inherit the substituted values wherever it sits.
 */
function artboard(opts: {
  title: string;
  body: string;
  w: number;
  h: number;
  light?: boolean;
}): string {
  const { title, body, w, h, light } = opts;
  const frameClass = light ? ' class="y-light"' : '';
  return dcPage({
    title,
    w,
    h,
    frame: `<div${frameClass} style="width: ${w}px; height: ${h}px; box-sizing: border-box; overflow: hidden; ${CARD_SURFACE}">
<div class="demo">
${body}
</div>
</div>`,
  });
}

const swatch = (name: string) => `
  <div style="display:flex;flex-direction:column;gap:4px;align-items:center">
    <div style="width:64px;height:44px;border-radius:var(--yaar-radius);border:1px solid var(--yaar-border);background:var(${name})"></div>
    <span class="demo-note">${name}</span>
  </div>`;

const directionBody = `
<span class="y-label">One palette, one source, two surfaces</span>
<div class="y-card">
  <div class="y-font-bold" style="margin-bottom:4px">GitHub-dark, generated everywhere</div>
  <div class="y-text-sm y-text-muted">Every stylesheet derives from packages/shared/src/design/tokens.ts:
  the compiler injects the app CSS (--yaar-* / y-*), the OS shell's tokens.css is generated and
  sync-tested (--color-* aliases), and the agent-facing token reference is parsed from the same CSS.
  Semantics — accent, success, error, warning, spacing, type — are identical in shell chrome and app content.</div>
</div>
<div class="demo-row">
  <span class="y-badge y-badge-accent">accent = --color-accent = --yaar-accent</span>
  <span class="y-badge y-badge-success">one success</span>
  <span class="y-badge y-badge-error">one error</span>
  <span class="y-badge y-badge-warning">one warning</span>
</div>
<div class="y-card">
  <div class="y-font-bold" style="margin-bottom:4px">Chrome vs content</div>
  <div class="y-text-sm y-text-muted">Tokens govern chrome. Game boards, charts, artwork and brand accents are
  content and may hardcode. Exceptions live in docs/architecture/design_system.md's registry.</div>
</div>`;

const colorBody = `
<span class="y-label">Backgrounds</span>
<div class="demo-row">${['--yaar-bg', '--yaar-bg-surface', '--yaar-bg-surface-hover'].map(swatch).join('')}</div>
<span class="y-label">Text</span>
<div class="demo-row">${['--yaar-text', '--yaar-text-muted', '--yaar-text-dim'].map(swatch).join('')}</div>
<span class="y-label">Accent & semantic</span>
<div class="demo-row">${['--yaar-accent', '--yaar-accent-hover', '--yaar-border', '--yaar-success', '--yaar-error', '--yaar-warning'].map(swatch).join('')}</div>`;

const shellBody = `
<span class="y-label">Shell aliases — same values, --color-* names</span>
<div class="demo-row">${['--color-base', '--color-mantle', '--color-surface', '--color-text', '--color-accent', '--color-success', '--color-danger', '--color-warning'].map(swatch).join('')}</div>
<span class="y-label">Glass tier (alpha overlays — hover washes, dock, scrims)</span>
<div class="demo-row">${['--bg-overlay-light', '--bg-overlay-medium', '--bg-overlay-strong', '--bg-overlay-hover'].map(swatch).join('')}</div>
<span class="y-label">Window chrome mock — elevation: desktop on mantle, window on base</span>
<div style="background:var(--color-mantle);border-radius:var(--radius-lg);padding:var(--space-4)">
  <div style="background:var(--color-base);outline:1px solid var(--color-border);outline-offset:-1px;border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);overflow:hidden;max-width:420px">
    <div style="display:flex;align-items:center;gap:var(--space-2);height:36px;box-sizing:border-box;padding:0 var(--space-3);background:var(--color-base);border-bottom:1px solid var(--color-border-muted)">
      <span style="width:10px;height:10px;border-radius:var(--radius-full);background:var(--color-danger)"></span>
      <span style="width:10px;height:10px;border-radius:var(--radius-full);background:var(--color-warning)"></span>
      <span style="width:10px;height:10px;border-radius:var(--radius-full);background:var(--color-success)"></span>
      <span style="font-size:var(--text-base);font-weight:500;color:var(--color-text);margin-left:var(--space-2)">Window title</span>
    </div>
    <div style="padding:var(--space-4);color:var(--color-subtext);font-size:var(--text-base)">AI-generated window content</div>
  </div>
</div>`;

const typeBody = `
<div class="y-text-xl y-font-bold">Text XL — window titles (18px)</div>
<div class="y-text-lg">Text LG — modal titles, headings (15px)</div>
<div class="y-text-base">Text Base — body copy, default (13px)</div>
<div class="y-text-sm">Text SM — buttons, inputs, secondary (12px)</div>
<div class="y-text-xs">Text XS — status bars, badges (11px)</div>
<hr class="y-divider">
<span class="y-label">y-label — uppercase section header</span>
<div class="y-text-muted">y-text-muted — secondary copy</div>
<div class="y-text-dim">y-text-dim — placeholder-level copy</div>
<div class="y-text-accent">y-text-accent — links and emphasis</div>
<div class="y-font-mono">y-font-mono — code and paths</div>`;

const spacingBody = `
<span class="y-label">Spacing scale (4px base)</span>
<div class="demo-row" style="align-items:flex-end">
${['1', '2', '3', '4', '5', '6', '8', '10', '12']
  .map(
    (n) => `
  <div style="display:flex;flex-direction:column;gap:4px;align-items:center">
    <div style="width:var(--yaar-sp-${n});height:var(--yaar-sp-${n});background:var(--yaar-accent);border-radius:2px"></div>
    <span class="demo-note">sp-${n}</span>
  </div>`,
  )
  .join('')}
</div>
<span class="y-label">Radius</span>
<div class="demo-row">
  <div style="width:72px;height:48px;border:1px solid var(--yaar-border);background:var(--yaar-bg-surface);border-radius:var(--yaar-radius-sm)" class="y-flex-center"><span class="demo-note">sm</span></div>
  <div style="width:72px;height:48px;border:1px solid var(--yaar-border);background:var(--yaar-bg-surface);border-radius:var(--yaar-radius)" class="y-flex-center"><span class="demo-note">md</span></div>
  <div style="width:72px;height:48px;border:1px solid var(--yaar-border);background:var(--yaar-bg-surface);border-radius:var(--yaar-radius-lg)" class="y-flex-center"><span class="demo-note">lg</span></div>
</div>
<span class="y-label">Shadows</span>
<div class="demo-row">
  <div style="width:88px;height:56px;background:var(--yaar-bg-surface);border-radius:var(--yaar-radius);box-shadow:var(--yaar-shadow-sm)" class="y-flex-center"><span class="demo-note">sm</span></div>
  <div style="width:88px;height:56px;background:var(--yaar-bg-surface);border-radius:var(--yaar-radius);box-shadow:var(--yaar-shadow)" class="y-flex-center"><span class="demo-note">md</span></div>
  <div style="width:88px;height:56px;background:var(--yaar-bg-surface);border-radius:var(--yaar-radius);box-shadow:var(--yaar-shadow-lg)" class="y-flex-center"><span class="demo-note">lg</span></div>
</div>`;

const buttonBody = `
<span class="y-label">Variants</span>
<div class="demo-row">
  <button class="y-btn">Default</button>
  <button class="y-btn y-btn-primary">Primary</button>
  <button class="y-btn y-btn-ghost">Ghost</button>
  <button class="y-btn y-btn-danger">Danger</button>
  <button class="y-btn y-btn-warning">Warning</button>
</div>
<span class="y-label">Sizes</span>
<div class="demo-row">
  <button class="y-btn">Regular</button>
  <button class="y-btn y-btn-sm">y-btn-sm</button>
  <button class="y-btn y-btn-primary y-btn-sm">Small primary</button>
</div>`;

const inputBody = `
<span class="y-label">Text input</span>
<div style="max-width:320px" class="y-flex-col y-gap-2">
  <input class="y-input" placeholder="Placeholder text">
  <input class="y-input" value="Filled value">
</div>
<span class="y-label">Select & toolbar</span>
<div class="y-toolbar y-rounded y-border" style="max-width:420px">
  <input class="y-input" placeholder="Search..." style="flex:1">
  <select class="y-select"><option>All</option></select>
  <button class="y-btn y-btn-sm y-btn-primary">Go</button>
</div>`;

const badgeBody = `
<span class="y-label">Badges</span>
<div class="demo-row">
  <span class="y-badge">Default</span>
  <span class="y-badge y-badge-accent">Accent</span>
  <span class="y-badge y-badge-success">Success</span>
  <span class="y-badge y-badge-warning">Warning</span>
  <span class="y-badge y-badge-error">Error</span>
</div>
<span class="y-label">Cards & lists</span>
<div class="y-border y-rounded" style="max-width:360px;overflow:hidden">
  <div class="y-list-item"><span>&#128196;</span><span class="y-flex-1 y-truncate">notes.md</span><span class="y-text-xs y-text-dim">2 KB</span></div>
  <div class="y-list-item active"><span>&#128196;</span><span class="y-flex-1 y-truncate">tokens.ts</span><span class="y-text-xs y-text-dim">6 KB</span></div>
</div>`;

const layoutBody = `
<div class="y-border y-rounded" style="max-width:520px;height:280px;display:flex;flex-direction:column;overflow:hidden">
  <div class="y-toolbar">
    <span class="y-font-bold">App title</span>
    <span class="y-flex-1"></span>
    <button class="y-btn y-btn-sm">Action</button>
  </div>
  <div class="y-tabs">
    <button class="y-tab active">Overview</button>
    <button class="y-tab">Details</button>
  </div>
  <div style="display:flex;flex:1;min-height:0">
    <div class="y-sidebar y-p-2" style="width:130px">
      <span class="y-label y-px-2">Sidebar</span>
      <div class="y-list-item active">Item one</div>
      <div class="y-list-item">Item two</div>
    </div>
    <div class="y-p-4 y-flex-1 y-text-muted">Content area</div>
  </div>
  <div class="y-statusbar"><span>Ready</span><span>3 items</span></div>
</div>`;

const feedbackBody = `
<span class="y-label">Spinners</span>
<div class="demo-row"><span class="y-spinner"></span><span class="y-spinner y-spinner-lg"></span></div>
<span class="y-label">Status dots</span>
<div class="demo-row">
  <span class="y-dot"></span><span class="y-text-sm y-text-muted">idle</span>
  <span class="y-dot y-dot-ok"></span><span class="y-text-sm y-text-muted">ok</span>
  <span class="y-dot y-dot-warn"></span><span class="y-text-sm y-text-muted">warn</span>
  <span class="y-dot y-dot-err"></span><span class="y-text-sm y-text-muted">err</span>
  <span class="y-dot y-dot-accent y-dot-pulse"></span><span class="y-text-sm y-text-muted">busy (pulse)</span>
</div>
<span class="y-label">Progress</span>
<div style="max-width:360px;display:flex;flex-direction:column;gap:var(--yaar-sp-2)">
  <div class="y-progress"><div class="y-progress-fill" style="width:35%"></div></div>
  <div class="y-progress y-progress-indeterminate"><div class="y-progress-fill"></div></div>
</div>
<span class="y-label">Toast (forced visible)</span>
<div class="y-toast y-toast-visible y-toast-success" style="position:static;transform:none;display:inline-block">Saved successfully</div>
<span class="y-label">Empty state</span>
<div class="y-empty y-border y-rounded" style="max-width:360px;padding:var(--yaar-sp-4)">
  <div class="y-empty-icon">&#128230;</div>
  <div>Nothing here yet</div>
</div>
<span class="y-label">Modal</span>
<div class="y-modal" style="animation:none;max-width:360px">
  <div class="y-modal-title">Delete file?</div>
  <div class="y-modal-msg">This action cannot be undone.</div>
  <div class="y-modal-actions"><button class="y-btn">Cancel</button><button class="y-btn y-btn-danger">Delete</button></div>
</div>`;

/**
 * Component DSL — the AI's primary UI-building surface, rendered with the real
 * shell module CSS. Class names and structure mirror ComponentRenderer.tsx
 * (componentRoot > inline-styled grid > text/button/badge/progress); the grid is
 * inline-styled there too, so `display:grid` here is faithful, not a stand-in.
 * Part C of the design refresh edits exactly these rules.
 */
const componentDslBody = `
<span class="y-label">Text variants (finding 3 fixed: .text is sans; only code stays mono)</span>
<div class="componentRoot" style="display:grid;grid-template-columns:1fr;gap:var(--space-3)">
  <span class="text textHeading">Heading variant</span>
  <span class="text textSubheading">Subheading variant</span>
  <span class="text textBody">Body variant — the default agent-emitted text.</span>
  <span class="text">Plain .text — inherits --font-sans</span>
  <span class="text textCode">variant: "code" — still --font-mono</span>
</div>
<span class="y-label">Buttons &amp; inputs in a 2-col grid</span>
<div class="componentRoot" style="display:grid;grid-template-columns:repeat(2, 1fr);gap:var(--space-3)">
  <button class="button buttonPrimary buttonSizeMd">Primary action</button>
  <button class="button buttonSecondary buttonSizeMd">Secondary</button>
  <button class="button buttonGhost buttonSizeMd">Ghost</button>
  <button class="button buttonDanger buttonSizeMd">Danger</button>
  <div class="formField">
    <label class="formLabel">Label</label>
    <input class="formInput" placeholder="Input placeholder">
  </div>
  <div class="formField">
    <label class="formLabel">Select</label>
    <select class="formSelect"><option>Option</option></select>
  </div>
</div>
<span class="y-label">Badges (finding 5 fixed: justify-self keeps pills shrink-wrapped)</span>
<div class="componentRoot" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:var(--space-3)">
  <span class="badge badgeDefault">Default</span>
  <span class="badge badgeSuccess">Success</span>
  <span class="badge badgeError">Error</span>
</div>
<span class="y-label">Unknown component (finding 6 fixed: named placeholder, not raw text)</span>
<div class="componentRoot" style="display:grid;grid-template-columns:repeat(2, 1fr);gap:var(--space-3)">
  <span class="unsupported">unsupported: gauge</span>
  <span class="text textBody">…renders beside normal content without wrecking it.</span>
</div>
<div class="componentRoot" style="display:grid;grid-template-columns:1fr;gap:var(--space-3)">
  <div class="progress">
    <div class="progressLabel">Progress</div>
    <div class="progressTrack"><div class="progressBar" style="width:60%"></div></div>
    <div class="progressValue">60%</div>
  </div>
</div>`;

const lightBody = `
<span class="y-label">Light theme — .y-light, generated from PALETTE_LIGHT</span>
<div class="demo-row">
  <button class="y-btn">Default</button>
  <button class="y-btn y-btn-primary">Primary</button>
  <span class="y-badge y-badge-success">Success</span>
  <span class="y-badge y-badge-error">Error</span>
</div>
<div class="y-card" style="max-width:360px">
  <div class="y-font-bold">Light surface</div>
  <div class="y-text-sm y-text-muted">Same tokens, remapped from the same source data.</div>
</div>
<span class="y-label">Washes — the reason they are color-mix() over the color var</span>
<div class="demo-row">
  <span class="y-badge y-wash-accent">accent</span>
  <span class="y-badge y-wash-success">success</span>
  <span class="y-badge y-wash-error">error</span>
  <span class="y-badge y-wash-warning">warning</span>
</div>
<div class="y-text-xs y-text-dim" style="max-width:360px">A baked rgba() would stay dark-tinted here; these re-mix from the light accent.</div>`;

const cards: Array<{
  file: string;
  group: string;
  title: string;
  body: string;
  w: number;
  h: number;
  light?: boolean;
}> = [
  {
    file: 'direction.html',
    group: 'Direction',
    title: 'One system: source, surfaces, rules',
    body: directionBody,
    w: 640,
    h: 460,
  },
  {
    file: 'colors.html',
    group: 'Colors',
    title: 'Color tokens (GitHub-dark)',
    body: colorBody,
    w: 560,
    h: 460,
  },
  {
    file: 'light-theme.html',
    group: 'Colors',
    title: 'Light theme (.y-light)',
    body: lightBody,
    light: true,
    w: 520,
    h: 300,
  },
  {
    file: 'shell.html',
    group: 'OS Shell',
    title: 'Shell aliases, glass tier, chrome',
    body: shellBody,
    w: 640,
    h: 560,
  },
  {
    file: 'typography.html',
    group: 'Type',
    title: 'Typography (5-step ramp)',
    body: typeBody,
    w: 520,
    h: 420,
  },
  {
    file: 'spacing.html',
    group: 'Spacing',
    title: 'Spacing, radius & shadows',
    body: spacingBody,
    w: 620,
    h: 460,
  },
  { file: 'buttons.html', group: 'Components', title: 'Buttons', body: buttonBody, w: 520, h: 260 },
  {
    file: 'inputs.html',
    group: 'Components',
    title: 'Inputs & selects',
    body: inputBody,
    w: 520,
    h: 280,
  },
  {
    file: 'badges.html',
    group: 'Components',
    title: 'Badges, cards & lists',
    body: badgeBody,
    w: 520,
    h: 320,
  },
  {
    file: 'layout.html',
    group: 'Layout',
    title: 'Toolbar, tabs, sidebar, statusbar',
    body: layoutBody,
    w: 600,
    h: 340,
  },
  {
    file: 'component-dsl.html',
    group: 'OS Shell',
    title: 'Component DSL (shell renderer)',
    body: componentDslBody,
    w: 560,
    h: 620,
  },
  {
    file: 'feedback.html',
    group: 'Feedback',
    title: 'Spinners, toasts, empty, modal',
    body: feedbackBody,
    w: 520,
    h: 540,
  },
];

for (const c of cards) {
  writeFileSync(
    join(OUT, 'previews', c.file),
    page({ title: c.title, body: c.body, light: c.light }),
  );
}

// ---- The phone shell, page two of the canvas --------------------------------

/**
 * Whole-screen mockups of the phone shell, one file each in `design-screens/`.
 *
 * Unlike the cards above these are not built from the token module — they are drawn
 * by hand, because there is no generator that can produce "the home screen". What
 * they DO take from it is every value it owns: each file names colors, type steps
 * and radii as `var(--color-*)` / `var(--text-*)` / `var(--radius-*)`, resolved by
 * the same `CARD_CSS` the cards use. So the palette still cannot drift here; change
 * the accent in tokens.ts and these recolor with everything else.
 *
 * Two kinds of value are deliberately literal, because the token module does not own
 * them. The wallpaper is one: it is store state the user picks, so the screens paint
 * the `dark-blue` preset from `constants/appearance.ts` verbatim rather than pretend a
 * token names it. The other is the handful of alpha washes the shell's own modules
 * write inline (`rgba(255, 255, 255, 0.25)` on the active monitor chip, the tab's
 * `0 1px 4px` shadow) — copied from those modules so the picture matches what ships,
 * and they move when the module does.
 *
 * The structure is copied from the components themselves, not invented: the icon grid
 * is `DesktopSurface.module.css`'s phone grid, the sheet is `NotificationShade`, the
 * bottom handle is `CommandPalette`'s collapsed sheet, the card is `WindowFrame` with
 * `isCard` geometry, and the terminal is `CliPanel` + `TerminalPane`. A structural
 * change to any of those is a change here too — verified against the running phone
 * shell, which is the only thing that can settle it.
 *
 * What stays literal is the phone's geometry — 390×844, a 44px title bar, a 62px
 * icon tile. Those are the mockup's own subject matter, not the design system's, and
 * they are also what a comment on one of these screens is usually about.
 */
const PHONE = { w: 390, h: 844 };
const SCREENS_DIR = join(import.meta.dir, 'design-screens');
const screens: Array<{ file: string; name: string; title: string }> = [
  { file: 'home.html', name: 'home.dc.html', title: 'Home' },
  { file: 'shade.html', name: 'shade.dc.html', title: 'Shade — pulled down' },
  { file: 'palette.html', name: 'palette.dc.html', title: 'Input — open' },
  { file: 'card.html', name: 'card.dc.html', title: 'Window as a card' },
  { file: 'pan.html', name: 'pan.dc.html', title: 'Pan — mid-gesture' },
  { file: 'cli.html', name: 'cli.dc.html', title: 'CLI' },
];

// ---- The same cards as a Design canvas -------------------------------------

/** Headroom under each card, so a body that grew by a line is not clipped by its frame. */
const BOARD_PAD = 24;
const COL_GAP = 80;
/** Air between rows: the canvas wants 120, and a group title needs its rise on top. */
const ROW_GAP = 380;
/** How far a title1 sits above the row it heads — the canvas asks for at least 223. */
const TITLE_RISE = 300;
/** Short group names would be shrunk to fit a narrow row; give every title this much. */
const TITLE_MIN_W = 560;
/**
 * What the canvas itself writes onto a note when it saves one. Emitted here for the
 * same reason `attachments` is below: the editor normalizes the index when it opens
 * it, and a generator that leaves its defaults out makes every republish a diff
 * against the editor rather than against the last generated index.
 */
const NOTE_W = 240;

/**
 * Pinned, not `new Date()`. This generator rewrites the whole index every run, and
 * `createdOnFiles` is a field the canvas owns — a moving value would hand it a new
 * birthday on each republish.
 */
const CANVAS_CREATED_AT = '2026-09-20T00:00:00Z';

mkdirSync(join(OUT, 'project'), { recursive: true });

/** The canvas entry has to be `Main.dc.html`; the rest keep their preview stem. */
const boardName = (c: (typeof cards)[number], i: number) =>
  i === 0 ? 'Main.dc.html' : `${c.file.replace(/\.html$/, '')}.dc.html`;

const boards: Record<string, Record<string, unknown>> = {};
const order: string[] = [];
const notes: Record<string, Record<string, unknown>> = {};

// One row per group, in the order the cards are declared, with the group name as a
// title1 above it — which is what the canvas reads as at a zoomed-out glance.
const groups = [...new Set(cards.map((c) => c.group))];
let y = 0;
for (const group of groups) {
  const row = cards.map((c, i) => ({ c, i })).filter(({ c }) => c.group === group);
  let x = 0;
  let rowH = 0;
  for (const { c, i } of row) {
    const name = boardName(c, i);
    const h = c.h + BOARD_PAD;
    writeFileSync(
      join(OUT, 'project', name),
      artboard({ title: c.title, body: c.body, w: c.w, h, light: c.light }),
    );
    boards[name] = { x, y, w: c.w, h, page: 'system', title: c.title };
    order.push(name);
    x += c.w + COL_GAP;
    rowH = Math.max(rowH, h);
  }
  notes[`g-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`] = {
    x: 0,
    y: y - TITLE_RISE,
    w: NOTE_W,
    page: 'system',
    text: group,
    kind: 'title1',
    maxW: Math.max(x - COL_GAP, TITLE_MIN_W),
  };
  y += rowH + ROW_GAP;
}

// The phone screens, on their own page: three to a row, one title over each row.
// Their own coordinate space, so this starts at the top again.
const SCREEN_ROWS: Array<{ title: string; of: string[] }> = [
  { title: 'At rest', of: ['home.dc.html', 'shade.dc.html', 'palette.dc.html'] },
  { title: 'In use', of: ['card.dc.html', 'pan.dc.html', 'cli.dc.html'] },
];
for (const screen of screens) {
  const frame = readFileSync(join(SCREENS_DIR, screen.file), 'utf8').trim();
  // The frame's size lives in the file and its entry lives here; a mismatch would
  // leave the artboard floating inside a wrong-sized frame, silently.
  if (!frame.includes(`width: ${PHONE.w}px; height: ${PHONE.h}px`)) {
    throw new Error(`${screen.file}: root element is not ${PHONE.w}x${PHONE.h}`);
  }
  writeFileSync(
    join(OUT, 'project', screen.name),
    dcPage({ title: screen.title, frame, w: PHONE.w, h: PHONE.h }),
  );
  order.push(screen.name);
}
SCREEN_ROWS.forEach((row, r) => {
  const rowY = r * (PHONE.h + ROW_GAP);
  row.of.forEach((name, i) => {
    const screen = screens.find((s) => s.name === name);
    if (!screen) throw new Error(`SCREEN_ROWS names ${name}, which no screen declares`);
    boards[name] = {
      x: i * (PHONE.w + COL_GAP),
      y: rowY,
      w: PHONE.w,
      h: PHONE.h,
      page: 'mobile',
      title: screen.title,
    };
  });
  notes[`m-row-${r}`] = {
    x: 0,
    y: rowY - TITLE_RISE,
    w: NOTE_W,
    page: 'mobile',
    text: row.title,
    kind: 'title1',
    maxW: row.of.length * (PHONE.w + COL_GAP) - COL_GAP,
  };
});

writeFileSync(
  join(OUT, 'project', 'canvas.json'),
  `${JSON.stringify(
    {
      v: 3,
      createdOnFiles: { v: 1, at: CANVAS_CREATED_AT },
      // The canvas adds this itself the first time it opens the index; emitting it
      // keeps a republish from reading as a change.
      attachments: {},
      title: 'YAAR Design System',
      launch: { view: 'canvas', page: 'system' },
      pages: [
        { id: 'system', name: 'System' },
        { id: 'mobile', name: 'Mobile' },
      ],
      designSystems: [],
      boards,
      order,
      notes,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Generated ${cards.length} cards + ${screens.length} phone screens in ${OUT} (previews/ + project/)`,
);

// Where the canvas half of that goes. Kept in .env rather than here or in the docs
// because the artifact is private — a link nobody else on the repo can open is not
// worth checking in. Bun loads .env by itself, so `make design` just prints it.
console.log(
  process.env.YAAR_DESIGN_CANVAS
    ? `Publish project/ to ${process.env.YAAR_DESIGN_CANVAS}`
    : 'Set YAAR_DESIGN_CANVAS in .env to name the canvas project/ is published to.',
);
