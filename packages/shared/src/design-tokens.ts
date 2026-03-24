/**
 * YAAR Design Tokens — shared CSS custom properties and utility classes.
 *
 * Injected into every compiled app iframe at compile time (zero imports needed).
 * Apps can override any token via their own `:root` block.
 * All custom properties are prefixed `--yaar-*`, all classes prefixed `y-`.
 */

export const YAAR_DESIGN_TOKENS_CSS = `
@font-face{font-family:'NanumSquareNeo';src:url('/NanumSquareNeoOTF-Lt.otf') format('opentype');font-weight:300;font-style:normal;font-display:swap}
@font-face{font-family:'NanumSquareNeo';src:url('/NanumSquareNeoOTF-Rg.otf') format('opentype');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'NanumSquareNeo';src:url('/NanumSquareNeoOTF-Bd.otf') format('opentype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:'NanumSquareNeo';src:url('/NanumSquareNeoOTF-Eb.otf') format('opentype');font-weight:800;font-style:normal;font-display:swap}
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
  --yaar-sp-8: 32px;
  --yaar-radius: 6px;
  --yaar-radius-lg: 10px;
  --yaar-font: 'NanumSquareNeo', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
.y-light{--yaar-bg:#f8f9fa;--yaar-bg-surface:#ffffff;--yaar-bg-surface-hover:#f0f1f3;--yaar-text:#1f2328;--yaar-text-muted:#656d76;--yaar-text-dim:#8b949e;--yaar-accent:#0969da;--yaar-accent-hover:#0550ae;--yaar-border:#d0d7de;--yaar-success:#1a7f37;--yaar-error:#cf222e;--yaar-warning:#9a6700;--yaar-shadow-sm:0 1px 2px rgba(0,0,0,.08);--yaar-shadow:0 2px 8px rgba(0,0,0,.1);--yaar-shadow-lg:0 8px 24px rgba(0,0,0,.15);color-scheme:light}
.y-toolbar{display:flex;align-items:center;gap:var(--yaar-sp-2);padding:var(--yaar-sp-2) var(--yaar-sp-3);background:var(--yaar-bg-surface);border-bottom:1px solid var(--yaar-border);flex-shrink:0}
.y-sidebar{display:flex;flex-direction:column;border-right:1px solid var(--yaar-border);overflow:hidden;background:var(--yaar-bg);flex-shrink:0}
.y-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100}
.y-modal{width:min(520px,calc(100vw - 32px));background:var(--yaar-bg-surface);border:1px solid var(--yaar-border);border-radius:var(--yaar-radius-lg);padding:var(--yaar-sp-4);box-shadow:var(--yaar-shadow-lg)}
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
.y-list-item.active,.y-list-item[aria-selected="true"]{background:rgba(88,166,255,.08);border-left-color:var(--yaar-accent)}
.y-label{font-size:var(--yaar-text-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--yaar-text-muted)}
.y-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--yaar-sp-2);color:var(--yaar-text-muted);padding:var(--yaar-sp-8);text-align:center}
.y-empty-icon{font-size:40px;opacity:.25}
.y-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.y-clamp-3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.y-btn-danger{color:var(--yaar-error);border-color:var(--yaar-error)}.y-btn-danger:hover{background:rgba(248,81,73,.1)}
pre[class*="language-"],code[class*="language-"]{color:#e6edf3;background:var(--yaar-bg-surface);font-family:var(--yaar-font-mono);font-size:var(--yaar-text-sm);border-radius:var(--yaar-radius)}
pre[class*="language-"]{padding:var(--yaar-sp-3);overflow:auto;margin:var(--yaar-sp-2) 0}
.token.comment,.token.prolog,.token.doctype,.token.cdata{color:#6e7781;font-style:italic}
.token.punctuation{color:#8b949e}
.token.property,.token.tag,.token.boolean,.token.number,.token.constant,.token.symbol,.token.deleted{color:#79c0ff}
.token.selector,.token.attr-name,.token.string,.token.char,.token.builtin,.token.inserted{color:#a5d6ff}
.token.operator,.token.entity,.token.url{color:#d2a8ff}
.token.atrule,.token.attr-value,.token.keyword{color:#ff7b72}
.token.function,.token.class-name{color:#d2a8ff}
.token.regex,.token.important,.token.variable{color:#ffa657}
.token.important,.token.bold{font-weight:bold}
.token.italic{font-style:italic}
`;
