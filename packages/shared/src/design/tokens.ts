/**
 * YAAR canonical design tokens — the single source of truth for the visual language.
 *
 * Both stylesheets that paint YAAR are generated from this data:
 *   - `buildAppTokensCss()`  → `YAAR_DESIGN_TOKENS_CSS` (compiler, injected into every app iframe)
 *   - `buildShellTokensCss()` → `packages/frontend/src/styles/base/tokens.css` (OS shell)
 *
 * Palette: GitHub-dark. Token VALUES must never be written by hand anywhere else —
 * shell CSS modules and app styles consume `var(--*)`; TS code imports from here.
 */

/**
 * Core dark palette (default theme) — GitHub **Dark Dimmed** (Primer `dark_dimmed`).
 * Every value is a literal step from that scale, not hand-tuned: the grays are
 * gray-9…gray-0, the hues blue-2/3, green-3, red-3/4, yellow-3.
 *
 * The `*Emphasis` entries are Primer's `*.emphasis` roles: a **fill under white
 * text**. They are deliberately darker than the matching `accent`/`error` hue,
 * which is an `*.fg` role — a text/link/border color that fails contrast as a
 * fill. Never swap the two.
 */
export const PALETTE_DARK = {
  bg: '#22272e',
  bgInset: '#1c2128',
  bgSurface: '#2d333b',
  bgSurfaceHover: '#373e47',
  text: '#cdd9e5',
  textSubtle: '#adbac7',
  textMuted: '#768390',
  textDim: '#636e7b',
  accent: '#539bf5',
  accentHover: '#6cb6ff',
  accentEmphasis: '#316dca',
  accentEmphasisHover: '#4184e4',
  border: '#444c56',
  borderMuted: '#373e47',
  borderHover: '#545d68',
  borderStrong: '#636e7b',
  success: '#57ab5a',
  successEmphasis: '#347d39',
  successEmphasisHover: '#46954a',
  error: '#e5534b',
  errorHover: '#f47067',
  dangerEmphasis: '#c93c37',
  dangerEmphasisHover: '#e5534b',
  warning: '#c69026',
} as const;

/** Light palette — powers the app-side `.y-light` class and the shell light theme. */
export const PALETTE_LIGHT = {
  bg: '#f8f9fa',
  bgInset: '#eff1f3',
  bgSurface: '#ffffff',
  bgSurfaceHover: '#f0f1f3',
  text: '#1f2328',
  textSubtle: '#424a53',
  textMuted: '#656d76',
  textDim: '#8b949e',
  accent: '#0969da',
  accentHover: '#0550ae',
  accentEmphasis: '#0969da',
  accentEmphasisHover: '#0860ca',
  border: '#d0d7de',
  borderMuted: '#d8dee4',
  borderHover: '#afb8c1',
  borderStrong: '#8c959f',
  success: '#1a7f37',
  successEmphasis: '#1f883d',
  successEmphasisHover: '#1a7f37',
  error: '#cf222e',
  errorHover: '#a40e26',
  dangerEmphasis: '#cf222e',
  dangerEmphasisHover: '#a40e26',
  warning: '#9a6700',
} as const;

/**
 * Accent presets for the shell accent picker. Keys are persisted in user
 * settings — never rename them; only values may change.
 */
export const ACCENT_PRESETS_DATA = [
  {
    key: 'blue',
    color: '#539bf5',
    hover: '#6cb6ff',
    emphasis: '#316dca',
    emphasisHover: '#4184e4',
  },
  {
    key: 'lavender',
    color: '#a5b4fc',
    hover: '#c7d2fe',
    emphasis: '#5155c4',
    emphasisHover: '#666bd6',
  },
  {
    key: 'mauve',
    color: '#bc8cff',
    hover: '#d2a8ff',
    emphasis: '#8256d0',
    emphasisHover: '#986ee2',
  },
  {
    key: 'pink',
    color: '#f778ba',
    hover: '#ff9bce',
    emphasis: '#bf3989',
    emphasisHover: '#d14b9a',
  },
  {
    key: 'peach',
    color: '#ffa657',
    hover: '#ffc680',
    emphasis: '#ae5622',
    emphasisHover: '#cc6b2c',
  },
  {
    key: 'yellow',
    color: '#e3b341',
    hover: '#f0d060',
    emphasis: '#8c6708',
    emphasisHover: '#a97f10',
  },
  {
    key: 'green',
    color: '#3fb950',
    hover: '#56d364',
    emphasis: '#347d39',
    emphasisHover: '#46954a',
  },
  { key: 'red', color: '#f85149', hover: '#ff7b72', emphasis: '#c93c37', emphasisHover: '#e5534b' },
] as const;

/** Spacing scale, 4px base. The app layer exposes a subset; the shell all steps. */
export const SPACING: Record<string, number> = {
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 20,
  '6': 24,
  '8': 32,
  '10': 40,
  '12': 48,
};

export const RADIUS = { xs: 3, sm: 4, md: 6, lg: 10, xl: 12, full: 9999 } as const;

/** Type ramp. Canonical steps only — shell legacy names alias into these. */
export const TYPE_SCALE = { xs: 11, sm: 12, base: 13, lg: 15, xl: 18 } as const;

export const FONT_SANS =
  "'NanumSquareNeo', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
export const FONT_MONO = "'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace";

export const SHADOWS_DARK = {
  sm: '0 1px 2px rgba(0,0,0,0.3)',
  md: '0 2px 8px rgba(0,0,0,0.4)',
  lg: '0 8px 24px rgba(0,0,0,0.5)',
  xl: '0 12px 48px rgba(0,0,0,0.5)',
  '2xl': '0 16px 48px rgba(0,0,0,0.5)',
} as const;

export const SHADOWS_LIGHT = {
  sm: '0 1px 2px rgba(0,0,0,0.08)',
  md: '0 2px 8px rgba(0,0,0,0.1)',
  lg: '0 8px 24px rgba(0,0,0,0.15)',
  xl: '0 12px 48px rgba(0,0,0,0.18)',
  '2xl': '0 16px 48px rgba(0,0,0,0.18)',
} as const;

export const TRANSITIONS = { fast: '0.15s ease', normal: '0.2s ease', slow: '0.3s ease' } as const;

/** Shell stacking order. */
export const Z_INDEX = {
  window: 9000,
  panel: 9998,
  modal: 9999,
  toast: 10000,
  drawing: 50000,
  cursor: 99999,
} as const;

/**
 * Alpha overlay tiers — the "glass" model for hover washes and translucent
 * chrome (dock). Deliberately alpha, unlike borders which are opaque tokens.
 *
 * The white tiers are one step stronger than the GitHub-dark original: on the
 * brighter Dimmed canvas a 5% white wash is very nearly invisible.
 */
export const OVERLAYS = {
  light: 'rgba(255,255,255,0.06)',
  medium: 'rgba(255,255,255,0.1)',
  strong: 'rgba(255,255,255,0.13)',
  hover: 'rgba(255,255,255,0.18)',
  dark: 'rgba(0,0,0,0.2)',
  darkMedium: 'rgba(0,0,0,0.3)',
  darkStrong: 'rgba(0,0,0,0.4)',
  modalBackdrop: 'rgba(0,0,0,0.6)',
} as const;

/** Syntax-highlighting palette (Prism token classes), GitHub-dark. */
export const PRISM_PALETTE = {
  comment: '#6e7781',
  punctuation: '#8b949e',
  property: '#79c0ff',
  string: '#a5d6ff',
  operator: '#d2a8ff',
  keyword: '#ff7b72',
  function: '#d2a8ff',
  variable: '#ffa657',
  plain: '#e6edf3',
} as const;

/** NanumSquareNeo @font-face block. The .otf files are served from the frontend web root. */
export const FONT_FACE_CSS = [
  ['Lt', 300],
  ['Rg', 400],
  ['Bd', 700],
  ['Eb', 800],
]
  .map(
    ([w, weight]) =>
      `@font-face{font-family:'NanumSquareNeo';src:url('/NanumSquareNeoOTF-${w}.otf') format('opentype');font-weight:${weight};font-style:normal;font-display:swap}`,
  )
  .join('\n');

/** `#rrggbb` + alpha → `rgba(r,g,b,a)`. For token-derived tints in generated CSS. */
export function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
