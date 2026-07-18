/**
 * Generates preview cards for the "YAAR Design System" project on claude.ai/design.
 *
 *   bun scripts/gen-design-previews.ts     → dist/design-previews/
 *
 * Renders from the SAME generators that style the product (@yaar/shared design
 * module), so the published previews cannot drift from what ships. Upload is done
 * via Claude Code's DesignSync tool (see docs/architecture/design_system.md);
 * dist/design-previews/cards.json carries the card metadata for registration.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAppTokensCss } from '../packages/shared/src/design/app-css.ts';
import { buildShellTokensCss } from '../packages/shared/src/design/shell-css.ts';

const OUT = join(import.meta.dir, '../dist/design-previews');
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
  readFileSync(join(import.meta.dir, '..', p), 'utf8'),
).join('\n');

function page(opts: { group: string; title: string; body: string; light?: boolean }): string {
  const { group, title, body, light } = opts;
  return `<!-- @dsCard group="${group}" -->
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${shellCss}
${appCss}
${shellModuleCss}
html,body{margin:0;height:100%}
body{background:var(--yaar-bg);color:var(--yaar-text);font-family:var(--yaar-font);font-size:var(--yaar-text-base);line-height:1.5}
.demo{padding:var(--yaar-sp-4);display:flex;flex-direction:column;gap:var(--yaar-sp-4)}
.demo-row{display:flex;align-items:center;gap:var(--yaar-sp-3);flex-wrap:wrap}
.demo-note{font-family:var(--yaar-font-mono);font-size:var(--yaar-text-xs);color:var(--yaar-text-dim)}
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
<span class="y-label">Window chrome mock — elevation: desktop on base, window on surface</span>
<div style="background:var(--color-base);border-radius:var(--radius-lg);padding:var(--space-4)">
  <div style="background:var(--color-surface);outline:1px solid var(--color-border);outline-offset:-1px;border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);overflow:hidden;max-width:420px">
    <div style="display:flex;align-items:center;gap:var(--space-2);height:36px;box-sizing:border-box;padding:0 var(--space-3);background:var(--color-surface);border-bottom:1px solid var(--color-border-muted)">
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
<span class="y-label">Text variants (finding 3: .text is monospace by default)</span>
<div class="componentRoot" style="display:grid;grid-template-columns:1fr;gap:var(--space-3)">
  <span class="text textHeading">Heading variant</span>
  <span class="text textSubheading">Subheading variant</span>
  <span class="text textBody">Body variant — the default agent-emitted text.</span>
  <span class="text">Plain .text — inherits --font-mono</span>
</div>
<span class="y-label">Buttons &amp; inputs in a 2-col grid</span>
<div class="componentRoot" style="display:grid;grid-template-columns:repeat(2, 1fr);gap:var(--space-3)">
  <button class="button">Primary action</button>
  <button class="button buttonDisabled" disabled>Disabled</button>
  <div class="formField">
    <label class="formLabel">Label</label>
    <input class="formInput" placeholder="Input placeholder">
  </div>
  <div class="formField">
    <label class="formLabel">Select</label>
    <select class="formSelect"><option>Option</option></select>
  </div>
</div>
<span class="y-label">Badges &amp; progress (finding 5: badges stretch to the grid cell)</span>
<div class="componentRoot" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:var(--space-3)">
  <span class="badge badgeDefault">Default</span>
  <span class="badge badgeSuccess">Success</span>
  <span class="badge badgeError">Error</span>
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
</div>`;

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
    page({ group: c.group, title: c.title, body: c.body, light: c.light }),
  );
}

writeFileSync(
  join(OUT, 'cards.json'),
  JSON.stringify(
    cards.map((c) => ({
      name: c.title,
      path: `previews/${c.file}`,
      group: c.group,
      viewport: { width: c.w, height: c.h },
    })),
    null,
    2,
  ),
);

console.log(`Generated ${cards.length} preview cards in ${OUT}`);
