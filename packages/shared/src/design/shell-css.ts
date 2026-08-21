/**
 * Generator for the OS shell stylesheet (`packages/frontend/src/styles/base/tokens.css`).
 *
 * The emitted file is checked in but GENERATED — regenerate with
 * `bun scripts/codegen/design-tokens.ts`; a frontend test asserts it is in sync.
 *
 * Shell CSS addresses color only through the semantic names emitted here
 * (`--color-accent`, `--color-danger`, …) plus the explicitly decorative
 * `--hue-*` namespace. A raw hue name (`--color-blue`) or a legacy type step
 * (`--text-md`, `--text-2xl`) appearing in shell CSS is by definition a bug.
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
  DURATIONS,
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
 * Regenerate with: bun scripts/codegen/design-tokens.ts
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

  /* === Semantics — the only color names shell CSS may use ===
     \`--color-accent\` is also written at runtime by the accent-preset picker
     (DesktopSurface), so it must hold a real value, not a var() indirection. */
  --color-bg: var(--color-base);
  --color-accent: ${D.accent};
  --color-accent-hover: ${D.accentHover};
  --color-primary: var(--color-accent);
  --color-primary-hover: var(--color-accent-hover);
  --color-info: var(--color-accent);
  --color-success: ${D.success};
  --color-success-dim: ${alpha(D.success, 0.3)};
  --color-danger: ${D.error};
  --color-danger-hover: ${D.errorHover};
  --color-warning: ${D.warning};

  /* Emphasis fills — solid backgrounds under white text. The plain hues above
     are text/link colors and fail contrast as fills; use these for filled
     buttons only. The accent pair is re-derived at runtime by the accent-preset
     picker so filled buttons follow the chosen accent. */
  --color-accent-emphasis: ${D.accentEmphasis};
  --color-accent-emphasis-hover: ${D.accentEmphasisHover};
  --color-success-emphasis: ${D.successEmphasis};
  --color-success-emphasis-hover: ${D.successEmphasisHover};
  --color-danger-emphasis: ${D.dangerEmphasis};
  --color-danger-emphasis-hover: ${D.dangerEmphasisHover};

  /* Decorative hues — no semantic meaning, never stand in for a semantic above */
  --hue-lavender: ${accent('lavender').color};
  --hue-peach: ${accent('peach').color};
  --hue-pink: ${accent('pink').color};
  --hue-mauve: ${accent('mauve').color};

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
  /* --duration-* exists because animations cannot take their duration from --transition-*:
     a var() inside an \`animation:\` shorthand stops the CSS-modules pass from scoping the
     keyframe name, and the animation then never runs. See DURATIONS in tokens.ts. */
  --duration-fast: ${DURATIONS.fast};
  --duration-normal: ${DURATIONS.normal};
  --duration-slow: ${DURATIONS.slow};
  --transition-fast: ${TRANSITIONS.fast};
  --transition-normal: ${TRANSITIONS.normal};
  --transition-slow: ${TRANSITIONS.slow};

  /* === Typography === */
  --font-mono: ${FONT_MONO};
  --font-sans: ${FONT_SANS};

  /* Font sizes — canonical 5-step ramp */
  --text-xs: ${TYPE_SCALE.xs}px;
  --text-sm: ${TYPE_SCALE.sm}px;
  --text-base: ${TYPE_SCALE.base}px;
  --text-lg: ${TYPE_SCALE.lg}px;
  --text-xl: ${TYPE_SCALE.xl}px;

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
   Only raw values are overridden; every alias (\`--color-primary\`, \`--color-info\`,
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

  --color-accent: ${L.accent};
  --color-accent-hover: ${L.accentHover};
  --color-success: ${L.success};
  --color-success-dim: ${alpha(L.success, 0.3)};
  --color-danger: ${L.error};
  --color-danger-hover: ${L.errorHover};
  --color-warning: ${L.warning};

  --color-accent-emphasis: ${L.accentEmphasis};
  --color-accent-emphasis-hover: ${L.accentEmphasisHover};
  --color-success-emphasis: ${L.successEmphasis};
  --color-success-emphasis-hover: ${L.successEmphasisHover};
  --color-danger-emphasis: ${L.dangerEmphasis};
  --color-danger-emphasis-hover: ${L.dangerEmphasisHover};

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
