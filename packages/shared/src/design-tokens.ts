/**
 * YAAR Design Tokens — shared CSS custom properties and utility classes.
 *
 * Injected into every compiled app iframe at compile time (zero imports needed).
 * Apps can override any token via their own `:root` block.
 * All custom properties are prefixed `--yaar-*`, all classes prefixed `y-`.
 */

export const YAAR_DESIGN_TOKENS_CSS = `
:root {
  --yaar-bg: #0f1117;
  --yaar-bg-surface: #161b22;
  --yaar-bg-surface-hover: #1c2129;
  --yaar-text: #e6edf3;
  --yaar-text-muted: #8b949e;
  --yaar-text-dim: #6e7681;
  --yaar-accent: #58a6ff;
  --yaar-accent-hover: #79c0ff;
  --yaar-border: #30363d;
  --yaar-success: #3fb950;
  --yaar-error: #f85149;
  --yaar-warning: #d29922;
  --yaar-sp-1: 4px;
  --yaar-sp-2: 8px;
  --yaar-sp-3: 12px;
  --yaar-sp-4: 16px;
  --yaar-sp-5: 20px;
  --yaar-sp-6: 24px;
  --yaar-sp-8: 32px;
  --yaar-radius-sm: 4px;
  --yaar-radius: 6px;
  --yaar-radius-lg: 10px;
  --yaar-font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --yaar-font-mono: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  --yaar-text-xs: 11px;
  --yaar-text-sm: 12px;
  --yaar-text-base: 13px;
  --yaar-text-lg: 15px;
  --yaar-text-xl: 18px;
  --yaar-shadow-sm: 0 1px 2px rgba(0,0,0,.3);
  --yaar-shadow: 0 2px 8px rgba(0,0,0,.4);
  --yaar-shadow-lg: 0 8px 24px rgba(0,0,0,.5);
  --yaar-ease: 150ms ease;
}
.y-app{display:flex;flex-direction:column;height:100%;color:var(--yaar-text);background:var(--yaar-bg);font-family:var(--yaar-font);font-size:var(--yaar-text-base);line-height:1.5}
.y-flex{display:flex}.y-flex-col{display:flex;flex-direction:column}.y-flex-center{display:flex;align-items:center;justify-content:center}.y-flex-between{display:flex;align-items:center;justify-content:space-between}.y-flex-1{flex:1;min-width:0;min-height:0}
.y-gap-1{gap:var(--yaar-sp-1)}.y-gap-2{gap:var(--yaar-sp-2)}.y-gap-3{gap:var(--yaar-sp-3)}.y-gap-4{gap:var(--yaar-sp-4)}
.y-grid{display:grid}
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
.y-btn-primary{background:var(--yaar-accent);border-color:var(--yaar-accent);color:#fff}.y-btn-primary:hover{background:var(--yaar-accent-hover);border-color:var(--yaar-accent-hover)}
.y-btn-ghost{border-color:transparent;background:transparent}.y-btn-ghost:hover{background:var(--yaar-bg-surface)}
.y-btn-sm{padding:var(--yaar-sp-1) var(--yaar-sp-2);font-size:var(--yaar-text-xs)}
.y-input{width:100%;padding:var(--yaar-sp-2) var(--yaar-sp-3);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius);background:var(--yaar-bg);color:var(--yaar-text);font-size:var(--yaar-text-sm);outline:none;transition:border-color var(--yaar-ease)}
.y-input:focus{border-color:var(--yaar-accent)}.y-input::placeholder{color:var(--yaar-text-dim)}
.y-badge{display:inline-flex;align-items:center;padding:1px var(--yaar-sp-2);border-radius:10px;font-size:var(--yaar-text-xs);font-weight:500;background:var(--yaar-bg-surface);border:1px solid var(--yaar-border)}
.y-badge-success{color:var(--yaar-success);border-color:var(--yaar-success);background:rgba(63,185,80,.1)}
.y-badge-error{color:var(--yaar-error);border-color:var(--yaar-error);background:rgba(248,81,73,.1)}
.y-badge-warning{color:var(--yaar-warning);border-color:var(--yaar-warning);background:rgba(210,153,34,.1)}
.y-badge-accent{color:var(--yaar-accent);border-color:var(--yaar-accent);background:rgba(88,166,255,.1)}
@keyframes y-spin{to{transform:rotate(360deg)}}
.y-spinner{width:16px;height:16px;border:2px solid var(--yaar-border);border-top-color:var(--yaar-accent);border-radius:50%;animation:y-spin .6s linear infinite}
.y-spinner-lg{width:24px;height:24px}
.y-scroll{overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--yaar-border) transparent}
.y-scroll::-webkit-scrollbar{width:6px}.y-scroll::-webkit-scrollbar-track{background:transparent}.y-scroll::-webkit-scrollbar-thumb{background:var(--yaar-border);border-radius:3px}
.y-toast{position:fixed;bottom:var(--yaar-sp-4);left:50%;transform:translateX(-50%) translateY(20px);padding:var(--yaar-sp-2) var(--yaar-sp-4);border-radius:var(--yaar-radius);font-size:var(--yaar-text-sm);color:var(--yaar-text);background:var(--yaar-bg-surface);border:1px solid var(--yaar-border);box-shadow:var(--yaar-shadow-lg);opacity:0;transition:opacity var(--yaar-ease),transform var(--yaar-ease);pointer-events:none;z-index:9999}
.y-toast-visible{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
.y-toast-info{border-color:var(--yaar-accent)}.y-toast-success{border-color:var(--yaar-success)}.y-toast-error{border-color:var(--yaar-error)}
.y-transition{transition:all var(--yaar-ease)}
.y-overflow-hidden{overflow:hidden}
`;
