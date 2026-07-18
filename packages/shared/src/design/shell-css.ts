/**
 * Generator for the OS shell stylesheet (`packages/frontend/src/styles/base/tokens.css`).
 *
 * The emitted file is checked in but GENERATED — regenerate with
 * `bun scripts/gen-design-tokens.ts`; a frontend test asserts it is in sync.
 *
 * Legacy `--color-*` / `--space-*` / `--text-*` names are kept as aliases of the
 * canonical values so existing CSS modules keep working. The legacy 8-step type
 * ramp collapses onto the canonical 5-step ramp (some adjacent names now share a
 * value on purpose).
 */
import {
  PALETTE_DARK as D,
  PALETTE_LIGHT as L,
  ACCENT_PRESETS_DATA,
  SPACING,
  RADIUS,
  TYPE_SCALE,
  FONT_SANS,
  FONT_MONO,
  SHADOWS_DARK,
  SHADOWS_LIGHT,
  TRANSITIONS,
  Z_INDEX,
  OVERLAYS,
  FONT_FACE_CSS,
  alpha,
} from './tokens.js';

const accent = (key: string) => {
  const p = ACCENT_PRESETS_DATA.find((a) => a.key === key);
  if (!p) throw new Error(`unknown accent preset: ${key}`);
  return p;
};

export function buildShellTokensCss(): string {
  return `/**
 * Design Tokens — GENERATED FILE, DO NOT EDIT.
 *
 * Source of truth: packages/shared/src/design/tokens.ts (GitHub-dark palette).
 * Regenerate with: bun scripts/gen-design-tokens.ts
 */

${FONT_FACE_CSS}

:root {
  /* === Surfaces === */
  --color-base: ${D.bg};
  --color-mantle: ${D.bgInset};
  --color-surface: ${D.bgSurface};
  --color-surface-hover: ${D.bgSurfaceHover};
  --color-overlay: ${D.border};

  /* Text tiers */
  --color-text: ${D.text};
  --color-subtext: ${D.textSubtle};
  --color-subtext-muted: ${D.textMuted};
  --color-muted: ${D.textDim};
  --color-text-muted: var(--color-subtext-muted);

  /* Accent hues */
  --color-blue: ${D.accent};
  --color-blue-hover: ${D.accentHover};
  --color-lavender: ${accent('lavender').color};
  --color-green: ${D.success};
  --color-green-dim: ${alpha(D.success, 0.3)};
  --color-red: ${D.error};
  --color-red-hover: ${D.errorHover};
  --color-yellow: ${D.warning};
  --color-peach: ${accent('peach').color};
  --color-pink: ${accent('pink').color};
  --color-mauve: ${accent('mauve').color};

  /* Semantic aliases — style with these, not the hues above */
  --color-bg: var(--color-base);
  --color-accent: var(--color-blue);
  --color-accent-hover: var(--color-blue-hover);
  --color-primary: var(--color-blue);
  --color-primary-hover: var(--color-blue-hover);
  --color-success: var(--color-green);
  --color-danger: var(--color-red);
  --color-danger-hover: var(--color-red-hover);
  --color-warning: var(--color-yellow);
  --color-info: var(--color-blue);

  /* Button aliases (legacy names used by the component-DSL renderers) */
  --color-btn-primary: var(--color-primary);
  --color-btn-primary-hover: var(--color-primary-hover);
  --color-btn-danger: var(--color-danger);
  --color-btn-danger-hover: var(--color-danger-hover);
  --color-btn-success: var(--color-success);
  --color-btn-warning: var(--color-warning);

  /* === Spacing Scale === */
${Object.entries(SPACING)
  .map(([k, v]) => `  --space-${k}: ${v}px;`)
  .join('\n')}

  /* === Border Radius === */
  --radius-xs: ${RADIUS.xs}px;
  --radius-sm: ${RADIUS.sm}px;
  --radius-md: ${RADIUS.md}px;
  --radius-lg: ${RADIUS.lg}px;
  --radius-xl: ${RADIUS.xl}px;
  --radius-full: ${RADIUS.full}px;

  /* === Shadows === */
  --shadow-sm: ${SHADOWS_DARK.sm};
  --shadow-md: ${SHADOWS_DARK.md};
  --shadow-lg: ${SHADOWS_DARK.lg};
  --shadow-xl: ${SHADOWS_DARK.xl};
  --shadow-2xl: ${SHADOWS_DARK['2xl']};

  /* === Borders (opaque color tokens + shorthands) === */
  --color-border: ${D.border};
  --color-border-muted: ${D.borderMuted};
  --color-border-hover: ${D.borderHover};
  --color-border-strong: ${D.borderStrong};
  --border-subtle: 1px solid var(--color-border);
  --border-muted: 1px solid var(--color-border-muted);
  --border-hover: 1px solid var(--color-border-hover);
  --border-strong: 1px solid var(--color-border-strong);

  /* === Transitions === */
  --transition-fast: ${TRANSITIONS.fast};
  --transition-normal: ${TRANSITIONS.normal};
  --transition-slow: ${TRANSITIONS.slow};

  /* === Typography === */
  --font-mono: ${FONT_MONO};
  --font-sans: ${FONT_SANS};

  /* Font sizes — legacy 8-step names collapsed onto the canonical 5-step ramp */
  --text-xs: ${TYPE_SCALE.xs}px;
  --text-sm: ${TYPE_SCALE.sm}px;
  --text-base: ${TYPE_SCALE.base}px;
  --text-md: ${TYPE_SCALE.base}px;
  --text-lg: ${TYPE_SCALE.lg}px;
  --text-xl: ${TYPE_SCALE.lg}px;
  --text-2xl: ${TYPE_SCALE.xl}px;
  --text-3xl: ${TYPE_SCALE.xl}px;

  /* === Z-Index Scale === */
  --z-window: ${Z_INDEX.window};
  --z-panel: ${Z_INDEX.panel};
  --z-modal: ${Z_INDEX.modal};
  --z-toast: ${Z_INDEX.toast};
  --z-drawing: ${Z_INDEX.drawing};
  --z-cursor: ${Z_INDEX.cursor};

  /* === Opacity === */
  --opacity-disabled: 0.5;
  --opacity-hover: 0.95;

  /* === Background Overlays (alpha "glass" tier) === */
  --bg-overlay-light: ${OVERLAYS.light};
  --bg-overlay-medium: ${OVERLAYS.medium};
  --bg-overlay-strong: ${OVERLAYS.strong};
  --bg-overlay-hover: ${OVERLAYS.hover};
  --bg-dark-overlay: ${OVERLAYS.dark};
  --bg-dark-overlay-medium: ${OVERLAYS.darkMedium};
  --bg-dark-overlay-strong: ${OVERLAYS.darkStrong};
  --bg-modal-backdrop: ${OVERLAYS.modalBackdrop};

  /* Glass surfaces — translucent chrome floating over the wallpaper */
  --bg-glass: ${alpha(D.bg, 0.8)};
  --bg-glass-strong: ${alpha(D.bg, 0.95)};
  --bg-glass-inset: ${alpha(D.bgInset, 0.92)};

  color-scheme: dark;
}

/* Light theme — toggled via the \`theme\` setting (settingsSlice sets data-theme).
   Only raw values are overridden; every alias (\`--color-accent\`, \`--color-btn-*\`,
   \`--border-*\`) follows automatically through var(). */
:root[data-theme='light'] {
  --color-base: ${L.bg};
  --color-mantle: ${L.bgInset};
  --color-surface: ${L.bgSurface};
  --color-surface-hover: ${L.bgSurfaceHover};
  --color-overlay: ${L.border};

  --color-text: ${L.text};
  --color-subtext: ${L.textSubtle};
  --color-subtext-muted: ${L.textMuted};
  --color-muted: ${L.textDim};

  --color-blue: ${L.accent};
  --color-blue-hover: ${L.accentHover};
  --color-green: ${L.success};
  --color-green-dim: ${alpha(L.success, 0.3)};
  --color-red: ${L.error};
  --color-red-hover: ${L.errorHover};
  --color-yellow: ${L.warning};

  --color-border: ${L.border};
  --color-border-muted: ${L.borderMuted};
  --color-border-hover: ${L.borderHover};
  --color-border-strong: ${L.borderStrong};

  --shadow-sm: ${SHADOWS_LIGHT.sm};
  --shadow-md: ${SHADOWS_LIGHT.md};
  --shadow-lg: ${SHADOWS_LIGHT.lg};
  --shadow-xl: ${SHADOWS_LIGHT.xl};
  --shadow-2xl: ${SHADOWS_LIGHT['2xl']};

  /* Glass and overlay washes invert: white-alpha reads as nothing on a light bg */
  --bg-overlay-light: rgba(0,0,0,0.04);
  --bg-overlay-medium: rgba(0,0,0,0.06);
  --bg-overlay-strong: rgba(0,0,0,0.08);
  --bg-overlay-hover: rgba(0,0,0,0.12);
  --bg-modal-backdrop: rgba(0,0,0,0.4);
  --bg-glass: ${alpha(L.bg, 0.8)};
  --bg-glass-strong: ${alpha(L.bg, 0.95)};
  --bg-glass-inset: ${alpha(L.bgInset, 0.92)};

  color-scheme: light;
}
`;
}
