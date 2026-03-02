import { signal, html, mount, effect } from '@bundled/yaar';
import './styles.css';
import { saveDeck, loadDeck } from './storage';
import { normalizeAspectRatio, parseAspectRatio, RATIO_PRESETS, type RatioPreset } from './aspect-ratio';
import { newDeck, newSlide, normalizeDeck, isFontSize } from './deck-utils';
import { escapeHtml } from './markdown';
import { renderSlideHtml } from './slide-render';
import { THEMES } from './theme';
import type { Deck, FontSize, Slide, SlideLayout, ThemeId } from './types';
import { debounce, formatDistanceToNow, uuid } from './utils';
import { registerProtocol } from './protocol';

// === Mutable deck state ===
let deck = normalizeDeck(newDeck());

// === Signals for reactive UI ===
const deckVer = signal(0);        // bumps on content changes (thumbs + canvas update)
const activeIndexVer = signal(0); // bumps on slide switch (editor panel rebuilds)
const dirty = signal(false);
const lastSavedAt = signal(Date.now());

// === Presenting state (kept mutable) ===
let presenting = false;
let presentIndex = 0;
let presentStartedAt = 0;
let presentTimerId: number | null = null;

// === Misc ===
let filterQueryValue = '';

// === DOM refs ===
let canvasEl!: HTMLDivElement;

// === Helpers ===
function bumpDeck() { deckVer(deckVer() + 1); }
function bumpActiveIndex() { activeIndexVer(activeIndexVer() + 1); }

function clampActive() {
  if (deck.activeIndex < 0) deck.activeIndex = 0;
  if (deck.activeIndex > deck.slides.length - 1) deck.activeIndex = deck.slides.length - 1;
}

function activeSlide(): Slide {
  clampActive();
  return deck.slides[deck.activeIndex];
}

const debouncedSave = debounce(() => { dirty(false); lastSavedAt(Date.now()); void saveDeck(deck); }, 700);

function markDirty() {
  dirty(true);
  debouncedSave();
}

function persist(showToast = false) {
  void saveDeck(deck);
  dirty(false);
  lastSavedAt(Date.now());
  if (showToast) flash('Saved');
}

function moveSlide(from: number, to: number) {
  if (to < 0 || to >= deck.slides.length || from === to) return;
  const [item] = deck.slides.splice(from, 1);
  deck.slides.splice(to, 0, item);
  deck.activeIndex = to;
  markDirty();
  bumpDeck();
  bumpActiveIndex();
}

function flash(msg: string) {
  const n = document.createElement('div');
  n.textContent = msg;
  n.style.cssText = 'position:fixed;top:14px;right:14px;background:#111827;color:white;padding:9px 12px;border-radius:10px;z-index:99999';
  document.body.appendChild(n);
  n.animate([{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'translateY(0px)' }], { duration: 220, easing: 'ease-out' });
  setTimeout(() => {
    const anim = n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' });
    anim.onfinish = () => n.remove();
  }, 900);
}

// === Render helpers (for thumbs) ===
function renderThumbList() {
  deckVer(); // track
  const q = filterQueryValue.trim().toLowerCase();
  return deck.slides
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !q || `${s.title} ${s.body} ${s.notes}`.toLowerCase().includes(q))
    .map(({ s, idx }) => html`
      <div
        class=${() => `thumb${deck.activeIndex === idx ? ' active' : ''}`}
        onClick=${(e: Event) => {
          if ((e.target as HTMLElement).tagName === 'BUTTON') return;
          deck.activeIndex = idx;
          bumpDeck();
          bumpActiveIndex();
        }}
      >
        <h4>${idx + 1}. ${escapeHtml(s.title || 'Untitled')}</h4>
        <p>${escapeHtml((s.body || '').slice(0, 72))}</p>
        <div class="thumb-badges">
          <span class="thumb-badge">${escapeHtml(s.layout)}</span>
          <div class="thumb-actions">
            <button onClick=${(e: Event) => { e.stopPropagation(); moveSlide(idx, idx - 1); }}>↑</button>
            <button onClick=${(e: Event) => { e.stopPropagation(); moveSlide(idx, idx + 1); }}>↓</button>
          </div>
        </div>
      </div>
    `);
}

// === Editor panel (rebuilds when active slide changes) ===
function renderEditorPanel() {
  activeIndexVer(); // track — panel rebuilds only on slide switch
  const slide = activeSlide();

  return html`
    <div class="field">
      <label>Layout</label>
      <select
        onchange=${(e: Event) => {
          slide.layout = (e.target as HTMLSelectElement).value as SlideLayout;
          markDirty(); bumpDeck();
        }}
      >
        <option value="title-body" selected=${slide.layout === 'title-body'}>Title + Body</option>
        <option value="title-image" selected=${slide.layout === 'title-image'}>Title + Image</option>
        <option value="section" selected=${slide.layout === 'section'}>Section</option>
      </select>
    </div>
    <div class="field">
      <label>Title <span class="small">${slide.title.length} chars</span></label>
      <input value=${slide.title} onInput=${(e: Event) => {
        slide.title = (e.target as HTMLInputElement).value;
        markDirty(); bumpDeck();
      }} />
    </div>
    <div class="field">
      <label>Body (Markdown) <span class="small">${slide.body.length} chars</span></label>
      <textarea onInput=${(e: Event) => {
        slide.body = (e.target as HTMLTextAreaElement).value;
        markDirty(); bumpDeck();
      }}>${slide.body}</textarea>
    </div>
    <div class="field">
      <label>Speaker Notes</label>
      <textarea placeholder="Private presenter notes…" onInput=${(e: Event) => {
        slide.notes = (e.target as HTMLTextAreaElement).value;
        markDirty();
      }}>${slide.notes}</textarea>
    </div>
    <div class="field">
      <label>Image URL</label>
      <input placeholder="https://..." value=${slide.imageUrl} onInput=${(e: Event) => {
        slide.imageUrl = (e.target as HTMLInputElement).value;
        markDirty(); bumpDeck();
      }} />
    </div>
    <div class="field">
      <label>Font Size <span class="small">overrides deck setting</span></label>
      <select
        onchange=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          if (val === '') {
            delete slide.fontSize;
          } else if (isFontSize(val)) {
            slide.fontSize = val;
          }
          markDirty(); bumpDeck();
        }}
      >
        <option value="" selected=${!slide.fontSize}>Default (deck)</option>
        ${(['sm', 'md', 'lg', 'xl'] as FontSize[]).map(s => html`<option value=${s} selected=${slide.fontSize === s}>${s.toUpperCase()}</option>`)}
      </select>
    </div>
    <div class="field" style="display:flex;gap:8px">
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        if (deck.slides.length === 1) { deck.slides[0] = newSlide(); deck.activeIndex = 0; }
        else { deck.slides.splice(deck.activeIndex, 1); clampActive(); }
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>Delete Slide</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        const s = newSlide('section');
        s.title = 'Section Title'; s.body = 'Add key message';
        deck.slides.splice(deck.activeIndex + 1, 0, s);
        deck.activeIndex += 1;
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>Quick Section</button>
    </div>
    <div class="small">Autosave enabled. Notes are hidden in exported slides.</div>
  `;
}

// === Ratio controls ===
function renderRatioControls() {
  activeIndexVer(); deckVer();
  const ratio = parseAspectRatio(deck.aspectRatio);
  return html`
    <select
      title="Slide ratio"
      onchange=${(e: Event) => {
        const value = (e.target as HTMLSelectElement).value as RatioPreset;
        if (value !== 'custom') {
          deck.aspectRatio = value;
        } else {
          const p = parseAspectRatio(deck.aspectRatio);
          deck.aspectRatio = `${p.width}:${p.height}`;
        }
        markDirty(); bumpDeck();
      }}
    >
      ${RATIO_PRESETS.map(r => html`<option value=${r} selected=${ratio.preset === r}>${r}</option>`)}
      <option value="custom" selected=${ratio.preset === 'custom'}>Custom</option>
    </select>
    <input type="number" min="0.1" step="0.1" value=${ratio.width} style="width:72px"
      disabled=${ratio.preset !== 'custom'}
      onInput=${(e: Event) => {
        const w = Number((e.target as HTMLInputElement).value);
        const p = parseAspectRatio(deck.aspectRatio);
        if (w > 0) { deck.aspectRatio = `${Number(w.toFixed(3))}:${p.height}`; markDirty(); bumpDeck(); }
      }}
    />
    <span>:</span>
    <input type="number" min="0.1" step="0.1" value=${ratio.height} style="width:72px"
      disabled=${ratio.preset !== 'custom'}
      onInput=${(e: Event) => {
        const h = Number((e.target as HTMLInputElement).value);
        const p = parseAspectRatio(deck.aspectRatio);
        if (h > 0) { deck.aspectRatio = `${p.width}:${Number(h.toFixed(3))}`; markDirty(); bumpDeck(); }
      }}
    />
  `;
}

// === Font size controls ===
function renderFontSizeControl() {
  deckVer(); // track so it re-renders when deck.fontSize changes via protocol
  const sizes: FontSize[] = ['sm', 'md', 'lg', 'xl'];
  return html`
    <select
      title="Font size"
      onchange=${(e: Event) => {
        const val = (e.target as HTMLSelectElement).value as FontSize;
        if (isFontSize(val)) {
          deck.fontSize = val;
          markDirty(); bumpDeck();
        }
      }}
    >
      ${sizes.map(s => html`<option value=${s} selected=${deck.fontSize === s}>${s.toUpperCase()}</option>`)}
    </select>
  `;
}

// === Presentation mode (kept imperative) ===
function startPresent() {
  presenting = true;
  presentIndex = deck.activeIndex;
  presentStartedAt = Date.now();
  renderPresent();
}

function renderPresent() {
  if (!presenting) return;
  const s = deck.slides[presentIndex];
  const wrap = document.createElement('div');
  wrap.className = 'present';
  wrap.innerHTML = `
    <div class="progress" id="presentProgress" style="width:${((presentIndex + 1) / deck.slides.length) * 100}%"></div>
    <div style="width:min(1200px,96vw);" id="presentSlideWrap">${renderSlideHtml(s, deck.themeId, deck.fontSize)}</div>
    <div class="present-ui">
      <span class="present-pill" id="presentCounter">${presentIndex + 1} / ${deck.slides.length}</span>
      <span class="present-pill" id="presentTimer">00:00</span>
      <button id="prevP">Prev</button>
      <button id="nextP">Next</button>
      <button id="exitP">Exit</button>
    </div>
  `;
  document.body.appendChild(wrap);

  const rerender = () => {
    const slot = wrap.querySelector('#presentSlideWrap') as HTMLDivElement;
    slot.innerHTML = renderSlideHtml(deck.slides[presentIndex], deck.themeId, deck.fontSize);
    (wrap.querySelector('#presentProgress') as HTMLDivElement).style.width = `${((presentIndex + 1) / deck.slides.length) * 100}%`;
    (wrap.querySelector('#presentCounter') as HTMLSpanElement).textContent = `${presentIndex + 1} / ${deck.slides.length}`;
    (slot.querySelector('.slide') as HTMLElement | null)?.animate(
      [{ opacity: 0.3, transform: 'translateX(10px)' }, { opacity: 1, transform: 'translateX(0px)' }],
      { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  };

  const close = () => {
    presenting = false;
    if (presentTimerId) window.clearInterval(presentTimerId);
    presentTimerId = null;
    wrap.remove();
    window.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!presenting) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight' && presentIndex < deck.slides.length - 1) { presentIndex++; rerender(); }
    if (e.key === 'ArrowLeft' && presentIndex > 0) { presentIndex--; rerender(); }
  };

  presentTimerId = window.setInterval(() => {
    const timer = wrap.querySelector('#presentTimer') as HTMLSpanElement | null;
    if (!timer) return;
    const totalSec = Math.floor((Date.now() - presentStartedAt) / 1000);
    timer.textContent = `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`;
  }, 1000);

  window.addEventListener('keydown', onKey);
  (wrap.querySelector('#prevP') as HTMLButtonElement).onclick = () => { if (presentIndex > 0) { presentIndex--; rerender(); } };
  (wrap.querySelector('#nextP') as HTMLButtonElement).onclick = () => { if (presentIndex < deck.slides.length - 1) { presentIndex++; rerender(); } };
  (wrap.querySelector('#exitP') as HTMLButtonElement).onclick = close;
}

// === PDF Export ===
function exportPdf() {
  const ratio = parseAspectRatio(deck.aspectRatio);
  const htmlStr = `<html><head><title>${escapeHtml(deck.title)}</title><style>
    body{margin:0;font-family:Inter,Arial,sans-serif;}
    .page{page-break-after:always;padding:24px;}
    .slide{width:100%;aspect-ratio:${ratio.cssValue};border-radius:12px;padding:32px;box-sizing:border-box;}
    .slide h1{margin:0 0 12px;font-size:42px;}
    .slide-body{font-size:24px;line-height:1.35;}
    .slide-body p{margin:0 0 10px;}
    .slide-body ul,.slide-body ol{margin:0 0 12px 1.2em;padding:0;}
    .slide-body li{margin:0 0 6px;}
    .slide-body blockquote{margin:8px 0;padding:6px 12px;border-left:4px solid #475569;}
    .slide-body code{font-family:ui-monospace,Menlo,Consolas,monospace;}
    .slide-body pre{margin:10px 0;padding:10px 12px;border-radius:8px;background:rgba(15,23,42,.08);overflow:auto;}
    .slide-body a{color:#1d4ed8;text-decoration:underline;}
    @media print{.page:last-child{page-break-after:auto;}}
  </style></head><body>
    ${deck.slides.map((s) => `<div class="page">${renderSlideHtml(s, deck.themeId, deck.fontSize)}</div>`).join('')}
    <script>window.onload=()=>window.print();<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Popup blocked. Please allow popups to export PDF.'); return; }
  w.document.open(); w.document.write(htmlStr); w.document.close();
}

// === Mount the app ===
mount(html`
  <div class="root">
    <!-- Topbar -->
    <div class="topbar">
      <input
        value=${() => { deckVer(); return deck.title; }}
        style="min-width:220px"
        onInput=${(e: Event) => { deck.title = (e.target as HTMLInputElement).value; markDirty(); }}
      />
      <select
        onchange=${(e: Event) => {
          deck.themeId = (e.target as HTMLSelectElement).value as ThemeId;
          markDirty(); bumpDeck();
        }}
      >
        ${Object.entries(THEMES).map(([id, meta]) => html`<option value=${id} selected=${deck.themeId === id}>${meta.name}</option>`)}
      </select>
      ${() => renderRatioControls()}
      ${() => renderFontSizeControl()}
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        deck = newDeck(); filterQueryValue = '';
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>New</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        const s = activeSlide();
        deck.slides.splice(deck.activeIndex + 1, 0, { ...s, id: uuid(), title: `${s.title} (copy)` });
        deck.activeIndex += 1;
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>Duplicate</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        deck.slides.splice(deck.activeIndex + 1, 0, newSlide());
        deck.activeIndex += 1;
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>Add Slide</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => persist(true)}>Save</button>
      <button class="y-btn y-btn-sm y-btn-primary" onClick=${startPresent}>Present</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${exportPdf}>Export PDF</button>
      <span class=${() => `chip${dirty() ? ' dirty' : ''}`}>
        ${() => dirty() ? 'Saving\u2026' : `Saved ${formatDistanceToNow(lastSavedAt(), { addSuffix: true })}`}
      </span>
    </div>
    <!-- Main -->
    <div class="main">
      <!-- Left: thumbnails -->
      <div class="left y-scroll">
        <div class="left-head">
          <input placeholder="Filter slides\u2026" onInput=${(e: Event) => {
            filterQueryValue = (e.target as HTMLInputElement).value;
            bumpDeck();
          }} />
          <small>Tip: Alt+\u2191 / Alt+\u2193 to reorder \u2022 Ctrl/Cmd+Enter to present</small>
        </div>
        <div>${() => renderThumbList()}</div>
      </div>
      <!-- Center: slide canvas -->
      <div
        class="center"
        ref=${(el: HTMLDivElement) => { canvasEl = el; }}
        style=${() => { deckVer(); return `background:${THEMES[deck.themeId].canvas}`; }}
      ></div>
      <!-- Right: editor -->
      <div class="panel">
        ${() => renderEditorPanel()}
      </div>
    </div>
  </div>
`);

// === Reactive canvas update via effect ===
effect(() => {
  deckVer(); // track any deck content changes
  if (!canvasEl) return;
  canvasEl.innerHTML = renderSlideHtml(activeSlide(), deck.themeId, deck.fontSize);
  // Apply aspect ratio and animate slide-in
  const slideEl = canvasEl.querySelector('.slide') as HTMLElement | null;
  if (slideEl) {
    const ratio = parseAspectRatio(deck.aspectRatio);
    slideEl.style.aspectRatio = ratio.cssValue;
    slideEl.animate(
      [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0px)' }],
      { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }
});

// === Keyboard shortcuts ===
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); persist(true);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !presenting) {
    e.preventDefault(); startPresent();
  }
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveSlide(deck.activeIndex, deck.activeIndex - 1); }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveSlide(deck.activeIndex, deck.activeIndex + 1); }
});

// === Async initialization ===
(async () => {
  const saved = await loadDeck();
  if (saved) {
    deck = normalizeDeck(saved as Partial<Deck> & Pick<Deck, 'slides'>);
    bumpDeck();
    bumpActiveIndex();
  }
  persist(false);
})();

// === App Protocol ===
registerProtocol({
  getDeck: () => deck,
  setDeck: (d: Deck) => { deck = d; },
  getFilterQuery: () => filterQueryValue,
  setFilterQuery: (q: string) => { filterQueryValue = q; },
  activeSlide,
  clampActive,
  persist,
  bumpDeck,
  bumpActiveIndex,
});
