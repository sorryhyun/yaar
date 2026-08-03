/**
 * Generator for the app-iframe stylesheet (`--yaar-*` tokens + `y-*` utility classes).
 *
 * The compiler injects this into every compiled app as `YAAR_DESIGN_TOKENS_CSS`.
 * Structure constraints:
 *   - the FIRST `:root { ... }` block must declare every `--yaar-*` token, one per
 *     line — `describeDesignTokens()` and the compiler's design-token-guard parse it
 *   - class names are extracted with /\.(y-[a-z0-9-]+)/ — keep them literal
 */
import {
  PALETTE_DARK as D,
  PALETTE_LIGHT as L,
  SPACING,
  RADIUS,
  TYPE_SCALE,
  FONT_SANS,
  FONT_MONO,
  SHADOWS_DARK,
  SHADOWS_LIGHT,
  PRISM_PALETTE as P,
  OVERLAYS as O,
  FONT_FACE_CSS,
} from './tokens.js';

/**
 * The tinted-background scale, as `color-mix()` over the *cascading* color var.
 *
 * Apps kept hand-writing `rgba(88,166,255,.1)` for a tinted accent background —
 * 60+ sites, and that literal is GitHub's blue, not `--yaar-accent` (`#539bf5`),
 * so the fleet already disagreed with the token layer. Worse, a baked rgba can
 * never follow a theme: `.y-light` swaps every color token and a hardcoded wash
 * stays dark-tinted on a white surface.
 *
 * Written against `var(--yaar-<color>)` rather than a baked value so an app that
 * overrides its accent gets matching washes for free. Three strengths, taken
 * from where the fleet's hand-rolled alphas actually clustered (0.08-0.16):
 * `base` for a resting fill, `strong` for a pressed/selected one, `border` for
 * a tinted edge.
 *
 * `base` and `strong` exist for all four semantic colors even though the chrome
 * below consumes only some of them. The first adoption pass shipped `strong` for
 * accent and warning alone, and two apps immediately had to improvise around the
 * hole in the scale: session-logs rendered sibling provider chips at 16% accent
 * and 10% success because only one had a `strong` tier, and devtools collapsed
 * two 0.15 diff highlights to 10%. An incomplete scale does not save surface, it
 * relocates the decision into every app. `border` stays accent-only because a
 * tinted *edge* has one call site; the house pattern for a bordered wash is an
 * opaque color token beside it, as `.y-badge-*` shows.
 *
 * **Needing a strength this scale does not have** is expected — a 4% gradient
 * stop, a 40% cast glow. Write it as an app-local `color-mix()` over the color
 * var, never as a baked `rgba()` (which cannot follow `.y-light`), and never
 * under a `--yaar-`-prefixed name — that would shadow a shipped token rather
 * than extend it. The same form covers an app's own brand hue: dc-comics and
 * thesingularity-reader each keep a `#f7b731` editorial amber that is
 * deliberately not `--yaar-warning`, and mix its tints off that var so the hue
 * has one source. Mint a property only for a hue used more than once; a single
 * call site reads better inline.
 *
 * Two failure modes the `user-apps/` migration hit, worth knowing before a
 * sweep: an app can hide baked channels behind indirection
 * (`--x-accent-rgb: 83, 155, 245` fed to `rgba(var(--x-accent-rgb), .14)`),
 * which no `rgba(<digit>` scan finds; and an app's *own* palette can sit a few
 * points off a token on purpose, so an exact bit-for-bit match to a token is
 * evidence of a mistake while a near miss usually is not.
 */
const WASH = { base: 10, strong: 16, border: 35 } as const;
const wash = (color: string, pct: number) =>
  `color-mix(in srgb, var(--yaar-${color}) ${pct}%, transparent)`;

/**
 * The wash declarations, emitted one per line (the `:root` parser requires it).
 *
 * Repeated verbatim inside `.y-light`, which is not redundant: a custom property
 * substitutes its `var()`s at computed-value time *on the element it is declared
 * on*, and descendants inherit the already-substituted value. So a `.y-light`
 * that only re-declares `--yaar-accent` would leave the washes still mixed from
 * the dark accent — the exact defect these tokens exist to remove.
 */
const WASH_DECLS = [
  `--yaar-wash-accent: ${wash('accent', WASH.base)};`,
  `--yaar-wash-accent-strong: ${wash('accent', WASH.strong)};`,
  `--yaar-wash-accent-border: ${wash('accent', WASH.border)};`,
  `--yaar-wash-success: ${wash('success', WASH.base)};`,
  `--yaar-wash-success-strong: ${wash('success', WASH.strong)};`,
  `--yaar-wash-error: ${wash('error', WASH.base)};`,
  `--yaar-wash-error-strong: ${wash('error', WASH.strong)};`,
  `--yaar-wash-warning: ${wash('warning', WASH.base)};`,
  `--yaar-wash-warning-strong: ${wash('warning', WASH.strong)};`,
];

const washDecls = () => WASH_DECLS.map((d) => `  ${d}`).join('\n');

export function buildAppTokensCss(): string {
  return `
${FONT_FACE_CSS}
:root {
  --yaar-bg: ${D.bg};
  --yaar-bg-surface: ${D.bgSurface};
  --yaar-bg-surface-hover: ${D.bgSurfaceHover};
  --yaar-text: ${D.text};
  --yaar-text-muted: ${D.textMuted};
  --yaar-text-dim: ${D.textDim};
  --yaar-accent: ${D.accent};
  --yaar-accent-hover: ${D.accentHover};
  --yaar-accent-emphasis: ${D.accentEmphasis};
  --yaar-accent-emphasis-hover: ${D.accentEmphasisHover};
  --yaar-border: ${D.border};
  --yaar-success: ${D.success};
  --yaar-error: ${D.error};
  --yaar-warning: ${D.warning};
${washDecls()}
  --yaar-sp-1: ${SPACING['1']}px;
  --yaar-sp-2: ${SPACING['2']}px;
  --yaar-sp-3: ${SPACING['3']}px;
  --yaar-sp-4: ${SPACING['4']}px;
  --yaar-sp-5: ${SPACING['5']}px;
  --yaar-sp-6: ${SPACING['6']}px;
  --yaar-sp-8: ${SPACING['8']}px;
  --yaar-sp-10: ${SPACING['10']}px;
  --yaar-sp-12: ${SPACING['12']}px;
  --yaar-radius-sm: ${RADIUS.sm}px;
  --yaar-radius: ${RADIUS.md}px;
  --yaar-radius-lg: ${RADIUS.lg}px;
  --yaar-radius-full: ${RADIUS.full}px;
  --yaar-font: ${FONT_SANS};
  --yaar-font-mono: ${FONT_MONO};
  --yaar-text-xs: ${TYPE_SCALE.xs}px;
  --yaar-text-sm: ${TYPE_SCALE.sm}px;
  --yaar-text-base: ${TYPE_SCALE.base}px;
  --yaar-text-lg: ${TYPE_SCALE.lg}px;
  --yaar-text-xl: ${TYPE_SCALE.xl}px;
  --yaar-shadow-sm: ${SHADOWS_DARK.sm};
  --yaar-shadow: ${SHADOWS_DARK.md};
  --yaar-shadow-lg: ${SHADOWS_DARK.lg};
  --yaar-ease: 150ms ease;
}
button,input,select,textarea{font-family:inherit}
.y-app{display:flex;flex-direction:column;height:100%;color:var(--yaar-text);background:var(--yaar-bg);font-family:var(--yaar-font);font-size:var(--yaar-text-base);line-height:1.5}
.y-flex{display:flex}.y-flex-col{display:flex;flex-direction:column}.y-flex-center{display:flex;align-items:center;justify-content:center}.y-flex-between{display:flex;align-items:center;justify-content:space-between}.y-flex-1{flex:1;min-width:0;min-height:0}
.y-gap-1{gap:var(--yaar-sp-1)}.y-gap-2{gap:var(--yaar-sp-2)}.y-gap-3{gap:var(--yaar-sp-3)}.y-gap-4{gap:var(--yaar-sp-4)}
.y-p-1{padding:var(--yaar-sp-1)}.y-p-2{padding:var(--yaar-sp-2)}.y-p-3{padding:var(--yaar-sp-3)}.y-p-4{padding:var(--yaar-sp-4)}
.y-px-2{padding-left:var(--yaar-sp-2);padding-right:var(--yaar-sp-2)}.y-px-3{padding-left:var(--yaar-sp-3);padding-right:var(--yaar-sp-3)}.y-px-4{padding-left:var(--yaar-sp-4);padding-right:var(--yaar-sp-4)}
.y-py-2{padding-top:var(--yaar-sp-2);padding-bottom:var(--yaar-sp-2)}.y-py-3{padding-top:var(--yaar-sp-3);padding-bottom:var(--yaar-sp-3)}
.y-text-xs{font-size:var(--yaar-text-xs)}.y-text-sm{font-size:var(--yaar-text-sm)}.y-text-base{font-size:var(--yaar-text-base)}.y-text-lg{font-size:var(--yaar-text-lg)}.y-text-xl{font-size:var(--yaar-text-xl)}
.y-text-muted{color:var(--yaar-text-muted)}.y-text-dim{color:var(--yaar-text-dim)}.y-text-accent{color:var(--yaar-accent)}
.y-font-bold{font-weight:600}.y-font-mono{font-family:var(--yaar-font-mono)}
.y-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.y-border{border:1px solid var(--yaar-border)}.y-border-b{border-bottom:1px solid var(--yaar-border)}.y-border-t{border-top:1px solid var(--yaar-border)}
.y-rounded{border-radius:var(--yaar-radius)}.y-rounded-lg{border-radius:var(--yaar-radius-lg)}
.y-card{background:var(--yaar-bg-surface);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);padding:var(--yaar-sp-3)}
.y-surface{background:var(--yaar-bg-surface)}
.y-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--yaar-sp-2);padding:var(--yaar-sp-2) var(--yaar-sp-3);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);background:var(--yaar-bg-surface);color:var(--yaar-text);font-size:var(--yaar-text-sm);cursor:pointer;transition:background var(--yaar-ease),border-color var(--yaar-ease);user-select:none;white-space:nowrap}
.y-btn:hover{background:var(--yaar-bg-surface-hover)}.y-btn:active{opacity:.8}
.y-btn-primary{background:var(--yaar-accent-emphasis);border-color:var(--yaar-accent-emphasis);color:#fff}.y-btn-primary:hover{background:var(--yaar-accent-emphasis-hover);border-color:var(--yaar-accent-emphasis-hover)}
.y-btn-ghost{border-color:transparent;background:transparent}.y-btn-ghost:hover{background:var(--yaar-bg-surface)}
.y-btn-sm{padding:var(--yaar-sp-1) var(--yaar-sp-2);font-size:var(--yaar-text-xs)}
.y-input{width:100%;padding:var(--yaar-sp-2) var(--yaar-sp-3);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);background:var(--yaar-bg);color:var(--yaar-text);font-size:var(--yaar-text-sm);outline:none;transition:border-color var(--yaar-ease)}
.y-input:focus{border-color:var(--yaar-accent)}.y-input::placeholder{color:var(--yaar-text-dim)}
.y-badge{display:inline-flex;align-items:center;padding:1px var(--yaar-sp-2);border-radius:10px;font-size:var(--yaar-text-xs);font-weight:500;background:var(--yaar-bg-surface);border:1px solid var(--yaar-border)}
.y-badge-success{color:var(--yaar-success);border-color:var(--yaar-success);background:var(--yaar-wash-success)}
.y-badge-error{color:var(--yaar-error);border-color:var(--yaar-error);background:var(--yaar-wash-error)}
.y-badge-warning{color:var(--yaar-warning);border-color:var(--yaar-warning);background:var(--yaar-wash-warning)}
.y-badge-accent{color:var(--yaar-accent);border-color:var(--yaar-accent);background:var(--yaar-wash-accent)}
@keyframes y-spin{to{transform:rotate(360deg)}}
.y-spinner{width:16px;height:16px;border:2px solid var(--yaar-border);border-top-color:var(--yaar-accent);border-radius:50%;animation:y-spin .6s linear infinite}
.y-spinner-lg{width:24px;height:24px}
.y-scroll{overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--yaar-border) transparent}
.y-scroll::-webkit-scrollbar{width:6px}.y-scroll::-webkit-scrollbar-track{background:transparent}.y-scroll::-webkit-scrollbar-thumb{background:var(--yaar-border);border-radius:3px}
.y-toast{position:fixed;bottom:var(--yaar-sp-4);left:50%;transform:translateX(-50%) translateY(20px);padding:var(--yaar-sp-2) var(--yaar-sp-4);border-radius:var(--yaar-radius);font-size:var(--yaar-text-sm);color:var(--yaar-text);background:var(--yaar-bg-surface);border:1px solid var(--yaar-border);box-shadow:var(--yaar-shadow-lg);opacity:0;transition:opacity var(--yaar-ease),transform var(--yaar-ease);pointer-events:none;z-index:9999}
.y-toast-visible{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
.y-toast-info{border-color:var(--yaar-accent)}.y-toast-success{border-color:var(--yaar-success)}.y-toast-error{border-color:var(--yaar-error)}
.y-light{--yaar-bg:${L.bg};--yaar-bg-surface:${L.bgSurface};--yaar-bg-surface-hover:${L.bgSurfaceHover};--yaar-text:${L.text};--yaar-text-muted:${L.textMuted};--yaar-text-dim:${L.textDim};--yaar-accent:${L.accent};--yaar-accent-hover:${L.accentHover};--yaar-accent-emphasis:${L.accentEmphasis};--yaar-accent-emphasis-hover:${L.accentEmphasisHover};--yaar-border:${L.border};--yaar-success:${L.success};--yaar-error:${L.error};--yaar-warning:${L.warning};--yaar-shadow-sm:${SHADOWS_LIGHT.sm};--yaar-shadow:${SHADOWS_LIGHT.md};--yaar-shadow-lg:${SHADOWS_LIGHT.lg};${WASH_DECLS.join('')}color-scheme:light}
.y-toolbar{display:flex;align-items:center;gap:var(--yaar-sp-2);padding:var(--yaar-sp-2) var(--yaar-sp-3);background:var(--yaar-bg-surface);border-bottom:1px solid var(--yaar-border);flex-shrink:0}
.y-sidebar{display:flex;flex-direction:column;border-right:1px solid var(--yaar-border);overflow:hidden;background:var(--yaar-bg);flex-shrink:0}
@keyframes y-fade{from{opacity:0}}
@keyframes y-pop{from{opacity:0;transform:scale(.96)}}
.y-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;animation:y-fade var(--yaar-ease)}
.y-modal{width:min(520px,calc(100vw - 32px));background:var(--yaar-bg-surface);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius-lg);padding:var(--yaar-sp-4);box-shadow:var(--yaar-shadow-lg);animation:y-pop var(--yaar-ease)}
.y-modal-title{font-size:var(--yaar-text-lg);font-weight:700;margin-bottom:var(--yaar-sp-2)}
.y-modal-msg{color:var(--yaar-text-muted);font-size:var(--yaar-text-sm);white-space:pre-wrap;word-break:break-word}
.y-modal-actions{display:flex;justify-content:flex-end;gap:var(--yaar-sp-2);margin-top:var(--yaar-sp-4)}
.y-statusbar{display:flex;justify-content:space-between;align-items:center;padding:var(--yaar-sp-2) var(--yaar-sp-3);background:var(--yaar-bg-surface);border-top:1px solid var(--yaar-border);color:var(--yaar-text-muted);font-size:var(--yaar-text-xs);flex-shrink:0}
.y-tabs{display:flex;border-bottom:1px solid var(--yaar-border);gap:0;overflow-x:auto}
.y-tab{padding:var(--yaar-sp-2) var(--yaar-sp-3);font-size:var(--yaar-text-sm);color:var(--yaar-text-muted);cursor:pointer;border-bottom:2px solid transparent;transition:color var(--yaar-ease),border-color var(--yaar-ease);white-space:nowrap;user-select:none;background:none;border-top:none;border-left:none;border-right:none}
.y-tab:hover{color:var(--yaar-text)}
.y-tab.active,.y-tab[aria-selected="true"]{color:var(--yaar-accent);border-bottom-color:var(--yaar-accent)}
.y-select{padding:var(--yaar-sp-2) var(--yaar-sp-3);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);background:var(--yaar-bg);color:var(--yaar-text);font-size:var(--yaar-text-sm);outline:none;cursor:pointer;transition:border-color var(--yaar-ease)}
.y-select:focus{border-color:var(--yaar-accent)}
.y-divider{border:none;border-top:1px solid var(--yaar-border);margin:var(--yaar-sp-2) 0}
.y-list-item{display:flex;align-items:center;gap:var(--yaar-sp-2);padding:var(--yaar-sp-2) var(--yaar-sp-3);cursor:pointer;border-left:2px solid transparent;transition:background var(--yaar-ease)}
.y-list-item:hover{background:var(--yaar-bg-surface-hover)}
.y-list-item.active,.y-list-item[aria-selected="true"]{background:var(--yaar-wash-accent);border-left-color:var(--yaar-accent)}
.y-label{font-size:var(--yaar-text-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--yaar-text-muted)}
.y-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--yaar-sp-2);color:var(--yaar-text-muted);padding:var(--yaar-sp-8);text-align:center}
.y-empty-icon{font-size:40px;opacity:.25}
.y-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.y-clamp-3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.y-btn-danger{color:var(--yaar-error);border-color:var(--yaar-error)}.y-btn-danger:hover{background:var(--yaar-wash-error)}
.y-btn-warning{color:var(--yaar-warning);border-color:var(--yaar-warning)}.y-btn-warning:hover{background:var(--yaar-wash-warning)}
/* ── Status primitives ────────────────────────────────────────────────
   Washes, dots and progress bars: three shapes every app re-derived by
   hand. The wash classes exist beside the tokens because roughly half the
   sites that need a tint need it inside their own compound selector
   (a hover, a border), where only a var() can reach.

   The y-prefixed @keyframes names are part of the injected surface, not
   private: an app whose element is positioned differently may reference the
   animation without the classes (apps/browser drives its trackless 2px
   page-load sliver from y-progress-slide). Renaming one silently stops such an
   animation -- describeDesignTokens advertises tokens and classes only, so no
   guard sees it. */
.y-wash-accent{background:var(--yaar-wash-accent)}
.y-wash-success{background:var(--yaar-wash-success)}
.y-wash-error{background:var(--yaar-wash-error)}
.y-wash-warning{background:var(--yaar-wash-warning)}
.y-dot{width:8px;height:8px;border-radius:var(--yaar-radius-full);background:var(--yaar-text-dim);display:inline-block;flex-shrink:0}
.y-dot-ok{background:var(--yaar-success)}.y-dot-warn{background:var(--yaar-warning)}.y-dot-err{background:var(--yaar-error)}.y-dot-accent{background:var(--yaar-accent)}
@keyframes y-pulse{50%{opacity:.4}}
.y-dot-pulse{animation:y-pulse 1s ease-in-out infinite}
.y-progress{height:4px;border-radius:var(--yaar-radius-full);background:var(--yaar-border);overflow:hidden;flex-shrink:0}
.y-progress-fill{height:100%;width:0;border-radius:inherit;background:var(--yaar-accent);transition:width 120ms linear}
/* Indeterminate: the fill's width is ignored and a fixed-size block slides. */
@keyframes y-progress-slide{from{transform:translateX(-100%)}to{transform:translateX(400%)}}
.y-progress-indeterminate .y-progress-fill{width:25%;transition:none;animation:y-progress-slide 1.2s ease-in-out infinite}
/* ── Document-app chrome ──────────────────────────────────────────────
   The appbar + editable title + formatting toolbar + save chip shared by
   the document apps (word-lite, slides-lite). Extracted from near-identical
   per-app CSS; the raw GitHub blues those apps hardcoded are re-derived here
   from the accent tokens, so this chrome recolors with the palette. Brand
   badges keep an accent-emphasis default and let the app override the fill. */
.y-appbar{display:flex;align-items:center;gap:var(--yaar-sp-4);padding:0 var(--yaar-sp-4);height:52px;background:linear-gradient(180deg,var(--yaar-bg),var(--yaar-bg-surface));border-bottom:1px solid var(--yaar-border);flex-shrink:0}
.y-appbar-actions{display:inline-flex;align-items:center;gap:var(--yaar-sp-1);flex-shrink:0}
.y-brand{display:flex;align-items:center;gap:var(--yaar-sp-2);flex-shrink:0}
.y-brand-badge{width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:var(--yaar-accent-emphasis);color:#fff;font-weight:800;font-size:15px;box-shadow:var(--yaar-shadow-sm)}
.y-brand-name{font-weight:700;font-size:var(--yaar-text-lg);letter-spacing:.2px;color:var(--yaar-text)}
.y-doc-field{display:inline-flex;align-items:center;gap:var(--yaar-sp-2);flex:1;max-width:460px;padding:6px var(--yaar-sp-3);background:${O.light};border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);transition:border-color var(--yaar-ease),background var(--yaar-ease)}
.y-doc-field:focus-within{border-color:var(--yaar-accent);background:var(--yaar-wash-accent)}
.y-doc-icon{display:inline-flex;align-items:center;color:var(--yaar-text-dim);flex-shrink:0}
.y-doc-field:focus-within .y-doc-icon{color:var(--yaar-accent)}
.y-doc-input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--yaar-text);font-family:var(--yaar-font);font-size:var(--yaar-text-base);font-weight:600}
.y-doc-input::placeholder{color:var(--yaar-text-dim);font-weight:500}
.y-editbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--yaar-sp-1);padding:var(--yaar-sp-2) var(--yaar-sp-3);background:var(--yaar-bg-surface);border-bottom:1px solid var(--yaar-border);flex-shrink:0}
.y-tgroup{display:inline-flex;align-items:center;gap:2px}
.y-tsep{width:1px;height:22px;margin:0 var(--yaar-sp-1);background:var(--yaar-border);flex-shrink:0}
.y-tbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;min-width:32px;padding:0 7px;border:1px solid transparent;border-radius:var(--yaar-radius);background:transparent;color:var(--yaar-text-muted);font-family:var(--yaar-font);font-size:var(--yaar-text-sm);font-weight:600;cursor:pointer;transition:background var(--yaar-ease),color var(--yaar-ease),border-color var(--yaar-ease)}
.y-tbtn svg{display:block}
.y-tbtn:hover{background:var(--yaar-bg-surface-hover);color:var(--yaar-text);border-color:var(--yaar-border)}
.y-tbtn:active{background:var(--yaar-wash-accent-strong);color:var(--yaar-accent)}
.y-tbtn-text{padding:0 12px}
.y-tlabel{font-size:var(--yaar-text-sm);font-weight:600}
.y-tbtn-primary{background:var(--yaar-accent-emphasis);color:#fff;border-color:var(--yaar-accent-emphasis)}
.y-tbtn-primary:hover{background:var(--yaar-accent-emphasis-hover);border-color:var(--yaar-accent-emphasis-hover);color:#fff}
.y-tbtn-active{background:var(--yaar-wash-accent-strong);color:var(--yaar-accent);border-color:var(--yaar-wash-accent-border)}
/* chevron is a data: URI and cannot resolve var(); hex is --yaar-text-dim (${D.textDim}) */
.y-tselect{height:32px;padding:0 28px 0 10px;border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);background-color:${O.light};background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b98a5' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;color:var(--yaar-text);font-family:var(--yaar-font);font-size:var(--yaar-text-sm);font-weight:600;cursor:pointer;-webkit-appearance:none;appearance:none;transition:border-color var(--yaar-ease),background-color var(--yaar-ease)}
.y-tselect:hover{border-color:var(--yaar-text-dim);background-color:var(--yaar-bg-surface-hover)}
.y-tselect:focus{outline:none;border-color:var(--yaar-accent)}
.y-tselect option{background:var(--yaar-bg-surface);color:var(--yaar-text)}
.y-chip{display:inline-flex;align-items:center;gap:6px;font-size:var(--yaar-text-xs);font-weight:600;border-radius:var(--yaar-radius-full);padding:5px 11px;background:var(--yaar-wash-accent);color:var(--yaar-accent);white-space:nowrap}
.y-chip-warning{background:var(--yaar-wash-warning-strong);color:var(--yaar-warning)}
.y-chip-muted{background:${O.light};color:var(--yaar-text-dim)}
/* ── Nav-overlay chrome ────────────────────────────────────────────────
   The hover-open + pin + resize left panel shared verbatim by storage and
   thesingularity-reader (their navOverlay.ts state machines are identical).
   The root is zero-footprint — every child is absolutely positioned, so
   opening the panel never reflows the content behind it. Panel width comes
   from an inline --panel-w the app sets from its persisted layout. The
   body-level .nav-resizing class (toggled by the app during a width drag)
   suppresses the slide transition and locks the cursor document-wide; it is
   left unprefixed because it is a body-state flag the app owns, not chrome. */
.y-nav-root{position:absolute;inset:0;pointer-events:none;z-index:50}
.y-nav-hover-zone{position:absolute;left:0;top:0;bottom:0;width:28px;pointer-events:auto}
.y-nav-hamburger{position:absolute;left:8px;top:8px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:var(--yaar-radius);border:1px solid var(--yaar-border);background:var(--yaar-bg-surface);color:var(--yaar-text-muted);font-size:var(--yaar-text-base);cursor:pointer;pointer-events:auto;opacity:.75;transition:opacity var(--yaar-ease),background var(--yaar-ease),color var(--yaar-ease)}
.y-nav-hamburger:hover{opacity:1;background:var(--yaar-bg-surface-hover);color:var(--yaar-text)}
.y-nav-hamburger-pinned{opacity:1;border-color:var(--yaar-accent);color:var(--yaar-accent)}
.y-nav-hamburger-hidden{opacity:0;pointer-events:none}
.y-nav-resizer{position:absolute;top:0;bottom:0;right:-3px;width:10px;cursor:col-resize;pointer-events:auto;touch-action:none;background:transparent;transition:background var(--yaar-ease);z-index:2}
.y-nav-resizer:hover,body.nav-resizing .y-nav-resizer{background:var(--yaar-accent);opacity:.55}
body.nav-resizing{cursor:col-resize;user-select:none}
body.nav-resizing .y-nav-panel{transition:none}
.y-nav-panel{position:absolute;left:0;top:0;bottom:0;width:var(--panel-w,340px);max-width:90%;display:flex;flex-direction:column;background:var(--yaar-bg-surface);border-right:1px solid var(--yaar-border);box-shadow:var(--yaar-shadow-lg);transform:translateX(-100%);opacity:0;pointer-events:none;transition:transform 180ms ease,opacity 180ms ease}
.y-nav-panel-open{transform:translateX(0);opacity:1;pointer-events:auto}
.y-nav-header{display:flex;align-items:center;justify-content:space-between;padding:var(--yaar-sp-2) var(--yaar-sp-3);border-bottom:1px solid var(--yaar-border);flex-shrink:0}
.y-nav-title{font-size:var(--yaar-text-sm);font-weight:600;color:var(--yaar-text-muted);letter-spacing:.04em}
.y-nav-count{color:var(--yaar-accent);font-variant-numeric:tabular-nums}
.y-nav-pin{border:1px solid transparent;background:transparent;border-radius:var(--yaar-radius-sm);padding:2px 6px;cursor:pointer;font-size:var(--yaar-text-base);line-height:1;transition:background var(--yaar-ease),border-color var(--yaar-ease)}
.y-nav-pin:hover{background:var(--yaar-bg-surface-hover)}
.y-nav-pin-active{border-color:var(--yaar-accent)}
pre[class*="language-"],code[class*="language-"]{color:${P.plain};background:var(--yaar-bg-surface);font-family:var(--yaar-font-mono);font-size:var(--yaar-text-sm);border-radius:var(--yaar-radius)}
pre[class*="language-"]{padding:var(--yaar-sp-3);overflow:auto;margin:var(--yaar-sp-2) 0}
.token.comment,.token.prolog,.token.doctype,.token.cdata{color:${P.comment};font-style:italic}
.token.punctuation{color:${P.punctuation}}
.token.property,.token.tag,.token.boolean,.token.number,.token.constant,.token.symbol,.token.deleted{color:${P.property}}
.token.selector,.token.attr-name,.token.string,.token.char,.token.builtin,.token.inserted{color:${P.string}}
.token.operator,.token.entity,.token.url{color:${P.operator}}
.token.atrule,.token.attr-value,.token.keyword{color:${P.keyword}}
.token.function,.token.class-name{color:${P.function}}
.token.regex,.token.important,.token.variable{color:${P.variable}}
.token.important,.token.bold{font-weight:bold}
.token.italic{font-style:italic}
`;
}

/** Built once — this is what the compiler re-exports as `YAAR_DESIGN_TOKENS_CSS`. */
export const YAAR_APP_TOKENS_CSS = buildAppTokensCss();
