import anime from '@bundled/anime';
import { formatDistanceToNow } from '@bundled/date-fns';
import { v4 as uuid } from '@bundled/uuid';
import { saveDeck, loadDeck } from './storage';
import type { Deck, Slide, SlideLayout, ThemeId } from './types';

const THEMES: Record<ThemeId, { name: string; bg: string; fg: string; accent: string; canvas: string }> = {
  'classic-light': {
    name: 'Classic Light',
    bg: '#ffffff',
    fg: '#1f2937',
    accent: '#2563eb',
    canvas: 'linear-gradient(180deg, #eef2ff 0%, #f8fafc 100%)',
  },
  'midnight-dark': {
    name: 'Midnight Dark',
    bg: '#111827',
    fg: '#f9fafb',
    accent: '#60a5fa',
    canvas: 'linear-gradient(180deg, #0f172a 0%, #111827 100%)',
  },
  ocean: {
    name: 'Ocean',
    bg: '#e0f2fe',
    fg: '#0c4a6e',
    accent: '#0284c7',
    canvas: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 100%)',
  },
  sunset: {
    name: 'Sunset',
    bg: '#fff7ed',
    fg: '#7c2d12',
    accent: '#ea580c',
    canvas: 'linear-gradient(180deg, #ffedd5 0%, #fff7ed 100%)',
  },
};

const app = document.getElementById('app')!;

let deck = normalizeDeck(loadDeck() ?? newDeck());
let presenting = false;
let presentIndex = 0;
let presentStartedAt = 0;
let presentTimer: number | null = null;
let filterQuery = '';

const saveState = {
  dirty: false,
  lastSavedAt: Date.now(),
};

const debouncedSave = debounce(() => persist(false), 700);

function debounce<T extends (...args: never[]) => void>(fn: T, wait = 300) {
  let t: number | null = null;
  return (...args: Parameters<T>) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), wait);
  };
}

function normalizeDeck(raw: Deck): Deck {
  const slides = (raw.slides?.length ? raw.slides : [newSlide()]).map((s) => ({
    id: s.id || uuid(),
    layout: s.layout || 'title-body',
    title: s.title || '',
    body: s.body || '',
    imageUrl: s.imageUrl || '',
    notes: (s as Slide & { notes?: string }).notes || '',
  }));
  return {
    title: raw.title || 'Untitled Deck',
    themeId: THEMES[raw.themeId] ? raw.themeId : 'classic-light',
    slides,
    activeIndex: Math.min(Math.max(raw.activeIndex ?? 0, 0), slides.length - 1),
  };
}

function newSlide(layout: SlideLayout = 'title-body'): Slide {
  return { id: uuid(), layout, title: 'New Slide', body: '', imageUrl: '', notes: '' };
}

function newDeck(): Deck {
  return {
    title: 'Untitled Deck',
    themeId: 'classic-light',
    slides: [newSlide()],
    activeIndex: 0,
  };
}

function clampActive() {
  if (deck.activeIndex < 0) deck.activeIndex = 0;
  if (deck.activeIndex > deck.slides.length - 1) deck.activeIndex = deck.slides.length - 1;
}

function activeSlide(): Slide {
  clampActive();
  return deck.slides[deck.activeIndex];
}

function markDirty() {
  saveState.dirty = true;
  updateSaveBadge();
  debouncedSave();
}

function persist(showToast = false) {
  saveDeck(deck);
  saveState.dirty = false;
  saveState.lastSavedAt = Date.now();
  updateSaveBadge();
  if (showToast) flash('Saved');
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSlideHtml(slide: Slide, themeId: ThemeId): string {
  const t = THEMES[themeId];
  const image = slide.imageUrl
    ? `<img src="${slide.imageUrl}" style="max-width:100%; max-height:260px; border-radius:12px; margin-top:12px; box-shadow:0 8px 20px rgba(0,0,0,.15);"/>`
    : '';

  if (slide.layout === 'section') {
    return `<div class="slide section" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Section')}</h1>
      <p>${escapeHtml(slide.body || '')}</p>
    </div>`;
  }

  if (slide.layout === 'title-image') {
    return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Title')}</h1>
      ${image || '<div style="opacity:.65; padding:8px 0;">No image selected</div>'}
      <p>${escapeHtml(slide.body || '')}</p>
    </div>`;
  }

  return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
    <h1>${escapeHtml(slide.title || 'Title')}</h1>
    <p>${escapeHtml(slide.body || '')}</p>
  </div>`;
}

function render() {
  if (!deck.slides.length) deck.slides.push(newSlide());
  clampActive();

  const t = THEMES[deck.themeId];
  const slide = activeSlide();

  app.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, system-ui, Arial, sans-serif; color: #111827; }
      input, textarea, select, button { font: inherit; }
      .root { height: 100vh; display: grid; grid-template-rows: 62px 1fr; background: #f8fafc; }
      .topbar {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid #e5e7eb; background: rgba(255,255,255,0.92); backdrop-filter: blur(6px);
      }
      .topbar input, .topbar select, .topbar button, .panel input, .panel textarea, .panel select, .left input {
        border: 1px solid #d1d5db; border-radius: 10px; padding: 8px 10px; font-size: 13px;
      }
      .topbar button, .panel button, .thumb-actions button { cursor: pointer; background: white; }
      .topbar button.primary { background: #111827; color: white; border-color: #111827; }
      .topbar button:focus-visible, .panel button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
      .chip { font-size: 12px; border-radius: 999px; padding: 5px 10px; background: #eef2ff; color: #1d4ed8; }
      .chip.dirty { background: #fef3c7; color: #92400e; }
      .main { display: grid; grid-template-columns: 260px 1fr 320px; height: calc(100vh - 62px); }
      .left { border-right: 1px solid #e5e7eb; overflow: auto; padding: 10px; background: #ffffff; }
      .left-head { display:grid; gap:8px; margin-bottom: 8px; }
      .left small { color:#6b7280; font-size:11px; }
      .thumb {
        border: 1px solid #d1d5db; border-radius: 12px; padding: 10px; margin-bottom: 8px; cursor: pointer;
        background: white; transition: transform .12s ease, box-shadow .12s ease;
      }
      .thumb:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.07); }
      .thumb.active { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb inset; }
      .thumb h4 { margin: 0 0 4px; font-size: 12px; }
      .thumb p { margin: 0; font-size: 11px; color: #6b7280; min-height: 28px; }
      .thumb-badges { margin-top:6px; display:flex; align-items:center; justify-content:space-between; }
      .thumb-badge { font-size: 10px; color:#334155; background:#e2e8f0; border-radius:999px; padding:2px 6px; }
      .thumb-actions { display: flex; gap: 4px; }
      .thumb-actions button { font-size: 11px; padding: 3px 6px; }
      .center { display: grid; place-items: center; background: ${t.canvas}; padding: 18px; transition: background .18s ease; }
      .slide {
        width: min(980px, 100%); aspect-ratio: 16 / 9; border-radius: 16px;
        padding: 38px; overflow: auto; box-shadow: 0 16px 42px rgba(0,0,0,.18);
      }
      .slide h1 { margin-top: 0; margin-bottom: 14px; font-size: clamp(24px, 4vw, 44px); }
      .slide p { font-size: clamp(14px, 1.7vw, 26px); line-height: 1.35; white-space: pre-wrap; }
      .panel { border-left: 1px solid #e5e7eb; padding: 12px; overflow: auto; background: #ffffff; }
      .field { margin-bottom: 10px; display: grid; gap: 6px; }
      .field label { font-size: 12px; color: #4b5563; font-weight: 600; display:flex; justify-content:space-between; }
      .panel textarea { min-height: 120px; resize: vertical; }
      .small { font-size: 11px; color: #64748b; }
      .present { position: fixed; inset: 0; z-index: 9999; background: #0b1020; display: grid; place-items: center; }
      .present-ui { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); display:flex; gap:8px; align-items:center; }
      .present-ui button { border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
      .present-pill { color: #e2e8f0; font-size: 12px; background: rgba(30,41,59,.7); border-radius:999px; padding:6px 10px; }
      .progress { position: fixed; top: 0; left: 0; height: 4px; background: #38bdf8; transition: width .15s linear; }
    </style>
    <div class="root">
      <div class="topbar">
        <input id="deckTitle" value="${escapeHtml(deck.title)}" style="min-width:220px;" />
        <select id="themeSelect">
          ${Object.entries(THEMES)
            .map(([id, meta]) => `<option value="${id}" ${id === deck.themeId ? 'selected' : ''}>${meta.name}</option>`)
            .join('')}
        </select>
        <button id="newDeckBtn">New</button>
        <button id="dupBtn">Duplicate</button>
        <button id="addBtn">Add Slide</button>
        <button id="saveBtn">Save</button>
        <button class="primary" id="presentBtn">Present</button>
        <button id="exportBtn">Export PDF</button>
        <span class="chip" id="saveBadge"></span>
      </div>
      <div class="main">
        <div class="left">
          <div class="left-head">
            <input id="filterIn" placeholder="Filter slides…" value="${escapeHtml(filterQuery)}" />
            <small>Tip: Alt+↑ / Alt+↓ to reorder • Ctrl/Cmd+Enter to present</small>
          </div>
          <div id="thumbs"></div>
        </div>
        <div class="center" id="canvas"></div>
        <div class="panel">
          <div class="field"><label>Layout</label>
            <select id="layoutSel">
              <option value="title-body" ${slide.layout === 'title-body' ? 'selected' : ''}>Title + Body</option>
              <option value="title-image" ${slide.layout === 'title-image' ? 'selected' : ''}>Title + Image</option>
              <option value="section" ${slide.layout === 'section' ? 'selected' : ''}>Section</option>
            </select>
          </div>
          <div class="field"><label>Title <span class="small">${slide.title.length} chars</span></label><input id="titleIn" value="${escapeHtml(slide.title)}"></div>
          <div class="field"><label>Body <span class="small">${slide.body.length} chars</span></label><textarea id="bodyIn">${escapeHtml(slide.body)}</textarea></div>
          <div class="field"><label>Speaker Notes</label><textarea id="notesIn" placeholder="Private presenter notes…">${escapeHtml(slide.notes)}</textarea></div>
          <div class="field"><label>Image URL</label><input id="imgIn" placeholder="https://..." value="${escapeHtml(slide.imageUrl)}"></div>
          <div class="field" style="display:flex; gap:8px;"><button id="delBtn">Delete Slide</button><button id="sectionBtn">Quick Section</button></div>
          <div class="small">Autosave enabled. Notes are hidden in exported slides.</div>
        </div>
      </div>
    </div>
  `;

  renderThumbs();
  renderCanvas(true);
  bindUi();
  updateSaveBadge();
}

function renderThumbs() {
  const thumbs = app.querySelector('#thumbs') as HTMLDivElement;
  const query = filterQuery.trim().toLowerCase();
  thumbs.innerHTML = '';

  deck.slides.forEach((s, idx) => {
    const searchable = `${s.title} ${s.body} ${s.notes}`.toLowerCase();
    if (query && !searchable.includes(query)) return;

    const el = document.createElement('div');
    el.className = `thumb ${idx === deck.activeIndex ? 'active' : ''}`;
    el.innerHTML = `
      <h4>${idx + 1}. ${escapeHtml(s.title || 'Untitled')}</h4>
      <p>${escapeHtml((s.body || '').slice(0, 72))}</p>
      <div class="thumb-badges">
        <span class="thumb-badge">${escapeHtml(s.layout)}</span>
        <div class="thumb-actions">
          <button data-act="up" data-idx="${idx}">↑</button>
          <button data-act="down" data-idx="${idx}">↓</button>
        </div>
      </div>
    `;

    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName.toLowerCase() === 'button') return;
      deck.activeIndex = idx;
      render();
    });

    el.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const b = e.currentTarget as HTMLButtonElement;
        const i = Number(b.dataset.idx);
        if (b.dataset.act === 'up') moveSlide(i, i - 1);
        if (b.dataset.act === 'down') moveSlide(i, i + 1);
      });
    });

    thumbs.appendChild(el);
  });
}

function moveSlide(from: number, to: number) {
  if (to < 0 || to >= deck.slides.length || from === to) return;
  const [item] = deck.slides.splice(from, 1);
  deck.slides.splice(to, 0, item);
  deck.activeIndex = to;
  markDirty();
  render();
}

function renderCanvas(withAnimation = false) {
  const canvas = app.querySelector('#canvas') as HTMLDivElement;
  canvas.innerHTML = renderSlideHtml(activeSlide(), deck.themeId);

  if (withAnimation) {
    const slideEl = canvas.querySelector('.slide') as HTMLElement | null;
    if (slideEl) {
      anime({
        targets: slideEl,
        opacity: [0, 1],
        translateY: [16, 0],
        duration: 260,
        easing: 'easeOutCubic',
      });
    }
  }
}

function bindUi() {
  const slide = activeSlide();

  (app.querySelector('#deckTitle') as HTMLInputElement).oninput = (e) => {
    deck.title = (e.target as HTMLInputElement).value;
    markDirty();
  };

  (app.querySelector('#themeSelect') as HTMLSelectElement).onchange = (e) => {
    deck.themeId = (e.target as HTMLSelectElement).value as ThemeId;
    markDirty();
    render();
  };

  (app.querySelector('#layoutSel') as HTMLSelectElement).onchange = (e) => {
    slide.layout = (e.target as HTMLSelectElement).value as SlideLayout;
    markDirty();
    render();
  };

  (app.querySelector('#titleIn') as HTMLInputElement).oninput = (e) => {
    slide.title = (e.target as HTMLInputElement).value;
    markDirty();
    renderCanvas();
    renderThumbs();
  };

  (app.querySelector('#bodyIn') as HTMLTextAreaElement).oninput = (e) => {
    slide.body = (e.target as HTMLTextAreaElement).value;
    markDirty();
    renderCanvas();
    renderThumbs();
  };

  (app.querySelector('#notesIn') as HTMLTextAreaElement).oninput = (e) => {
    slide.notes = (e.target as HTMLTextAreaElement).value;
    markDirty();
    renderThumbs();
  };

  (app.querySelector('#imgIn') as HTMLInputElement).oninput = (e) => {
    slide.imageUrl = (e.target as HTMLInputElement).value;
    markDirty();
    renderCanvas();
  };

  (app.querySelector('#filterIn') as HTMLInputElement).oninput = (e) => {
    filterQuery = (e.target as HTMLInputElement).value;
    renderThumbs();
  };

  (app.querySelector('#addBtn') as HTMLButtonElement).onclick = () => {
    deck.slides.splice(deck.activeIndex + 1, 0, newSlide());
    deck.activeIndex += 1;
    markDirty();
    render();
  };

  (app.querySelector('#sectionBtn') as HTMLButtonElement).onclick = () => {
    const s = newSlide('section');
    s.title = 'Section Title';
    s.body = 'Add key message';
    deck.slides.splice(deck.activeIndex + 1, 0, s);
    deck.activeIndex += 1;
    markDirty();
    render();
  };

  (app.querySelector('#dupBtn') as HTMLButtonElement).onclick = () => {
    const s = activeSlide();
    deck.slides.splice(deck.activeIndex + 1, 0, { ...s, id: uuid(), title: `${s.title} (copy)` });
    deck.activeIndex += 1;
    markDirty();
    render();
  };

  (app.querySelector('#delBtn') as HTMLButtonElement).onclick = () => {
    if (deck.slides.length === 1) {
      deck.slides[0] = newSlide();
      deck.activeIndex = 0;
    } else {
      deck.slides.splice(deck.activeIndex, 1);
      clampActive();
    }
    markDirty();
    render();
  };

  (app.querySelector('#newDeckBtn') as HTMLButtonElement).onclick = () => {
    deck = newDeck();
    filterQuery = '';
    markDirty();
    render();
  };

  (app.querySelector('#saveBtn') as HTMLButtonElement).onclick = () => persist(true);

  (app.querySelector('#presentBtn') as HTMLButtonElement).onclick = () => {
    presenting = true;
    presentIndex = deck.activeIndex;
    presentStartedAt = Date.now();
    renderPresent();
  };

  (app.querySelector('#exportBtn') as HTMLButtonElement).onclick = exportPdf;
}

function updateSaveBadge() {
  const el = app.querySelector('#saveBadge') as HTMLSpanElement | null;
  if (!el) return;

  if (saveState.dirty) {
    el.classList.add('dirty');
    el.textContent = 'Saving…';
    return;
  }

  el.classList.remove('dirty');
  el.textContent = `Saved ${formatDistanceToNow(saveState.lastSavedAt, { addSuffix: true })}`;
}

function flash(msg: string) {
  const n = document.createElement('div');
  n.textContent = msg;
  n.style.cssText = 'position:fixed;top:14px;right:14px;background:#111827;color:white;padding:9px 12px;border-radius:10px;z-index:99999';
  document.body.appendChild(n);
  anime({
    targets: n,
    opacity: [0, 1],
    translateY: [-10, 0],
    duration: 220,
    easing: 'easeOutQuad',
  });
  setTimeout(() => {
    anime({
      targets: n,
      opacity: [1, 0],
      translateY: [0, -6],
      duration: 180,
      easing: 'easeInQuad',
      complete: () => n.remove(),
    });
  }, 900);
}

function renderPresent() {
  if (!presenting) return;

  const s = deck.slides[presentIndex];
  const wrap = document.createElement('div');
  wrap.className = 'present';
  wrap.innerHTML = `
    <div class="progress" id="presentProgress" style="width:${((presentIndex + 1) / deck.slides.length) * 100}%"></div>
    <div style="width:min(1200px,96vw);" id="presentSlideWrap">${renderSlideHtml(s, deck.themeId)}</div>
    <div class="present-ui">
      <span class="present-pill" id="presentCounter">${presentIndex + 1} / ${deck.slides.length}</span>
      <span class="present-pill" id="presentTimer">00:00</span>
      <button id="prevP">Prev</button>
      <button id="nextP">Next</button>
      <button id="exitP">Exit</button>
    </div>
  `;
  document.body.appendChild(wrap);

  const rerenderPresent = () => {
    const slot = wrap.querySelector('#presentSlideWrap') as HTMLDivElement;
    slot.innerHTML = renderSlideHtml(deck.slides[presentIndex], deck.themeId);
    const progress = wrap.querySelector('#presentProgress') as HTMLDivElement;
    progress.style.width = `${((presentIndex + 1) / deck.slides.length) * 100}%`;
    const counter = wrap.querySelector('#presentCounter') as HTMLSpanElement;
    counter.textContent = `${presentIndex + 1} / ${deck.slides.length}`;
    anime({ targets: slot.querySelector('.slide'), opacity: [0.3, 1], translateX: [10, 0], duration: 200, easing: 'easeOutCubic' });
  };

  const close = () => {
    presenting = false;
    if (presentTimer) window.clearInterval(presentTimer);
    presentTimer = null;
    wrap.remove();
    window.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!presenting) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight' && presentIndex < deck.slides.length - 1) {
      presentIndex += 1;
      rerenderPresent();
    }
    if (e.key === 'ArrowLeft' && presentIndex > 0) {
      presentIndex -= 1;
      rerenderPresent();
    }
  };

  presentTimer = window.setInterval(() => {
    const timer = wrap.querySelector('#presentTimer') as HTMLSpanElement | null;
    if (!timer) return;
    const totalSec = Math.floor((Date.now() - presentStartedAt) / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    timer.textContent = `${mm}:${ss}`;
  }, 1000);

  window.addEventListener('keydown', onKey);
  (wrap.querySelector('#prevP') as HTMLButtonElement).onclick = () => {
    if (presentIndex > 0) presentIndex -= 1;
    rerenderPresent();
  };
  (wrap.querySelector('#nextP') as HTMLButtonElement).onclick = () => {
    if (presentIndex < deck.slides.length - 1) presentIndex += 1;
    rerenderPresent();
  };
  (wrap.querySelector('#exitP') as HTMLButtonElement).onclick = close;
}

function exportPdf() {
  const html = `
    <html>
      <head>
        <title>${escapeHtml(deck.title)}</title>
        <style>
          body { margin:0; font-family: Inter, Arial, sans-serif; }
          .page { page-break-after: always; padding: 24px; }
          .slide { width: 100%; aspect-ratio: 16/9; border-radius: 12px; padding: 32px; box-sizing: border-box; }
          .slide h1 { margin:0 0 12px; font-size: 42px; }
          .slide p { font-size: 24px; white-space: pre-wrap; }
          @media print { .page:last-child { page-break-after: auto; } }
        </style>
      </head>
      <body>
        ${deck.slides.map((s) => `<div class="page">${renderSlideHtml(s, deck.themeId)}</div>`).join('')}
        <script>window.onload = () => window.print();</script>
      </body>
    </html>
  `;

  const w = window.open('', '_blank');
  if (!w) {
    alert('Popup blocked. Please allow popups to export PDF.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    persist(true);
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !presenting) {
    e.preventDefault();
    presenting = true;
    presentIndex = deck.activeIndex;
    presentStartedAt = Date.now();
    renderPresent();
  }

  if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    moveSlide(deck.activeIndex, deck.activeIndex - 1);
  }

  if (e.altKey && e.key === 'ArrowDown') {
    e.preventDefault();
    moveSlide(deck.activeIndex, deck.activeIndex + 1);
  }
});

render();
persist(false);
