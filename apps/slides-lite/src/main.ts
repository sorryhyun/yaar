import { saveDeck, loadDeck } from './storage';
import type { Deck, Slide, SlideLayout, ThemeId } from './types';

const THEMES: Record<ThemeId, { name: string; bg: string; fg: string; accent: string }> = {
  'classic-light': { name: 'Classic Light', bg: '#ffffff', fg: '#1f2937', accent: '#2563eb' },
  'midnight-dark': { name: 'Midnight Dark', bg: '#111827', fg: '#f9fafb', accent: '#60a5fa' },
  ocean: { name: 'Ocean', bg: '#e0f2fe', fg: '#0c4a6e', accent: '#0284c7' },
  sunset: { name: 'Sunset', bg: '#fff7ed', fg: '#7c2d12', accent: '#ea580c' },
};

const app = document.getElementById('app')!;

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newSlide(layout: SlideLayout = 'title-body'): Slide {
  return { id: uid(), layout, title: 'New Slide', body: '', imageUrl: '' };
}

function newDeck(): Deck {
  return {
    title: 'Untitled Deck',
    themeId: 'classic-light',
    slides: [newSlide()],
    activeIndex: 0,
  };
}

let deck: Deck = loadDeck() ?? newDeck();
let presenting = false;
let presentIndex = 0;

function clampActive() {
  if (deck.activeIndex < 0) deck.activeIndex = 0;
  if (deck.activeIndex > deck.slides.length - 1) deck.activeIndex = deck.slides.length - 1;
}

function persist() {
  saveDeck(deck);
}

function activeSlide(): Slide {
  clampActive();
  return deck.slides[deck.activeIndex];
}

function renderSlideHtml(slide: Slide, themeId: ThemeId): string {
  const t = THEMES[themeId];
  const image = slide.imageUrl
    ? `<img src="${slide.imageUrl}" style="max-width:100%; max-height:260px; border-radius:10px; margin-top:12px;"/>`
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
      ${image || '<div style="opacity:.6">No image selected</div>'}
      <p>${escapeHtml(slide.body || '')}</p>
    </div>`;
  }

  return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
    <h1>${escapeHtml(slide.title || 'Title')}</h1>
    <p>${escapeHtml(slide.body || '')}</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render() {
  if (!deck.slides.length) deck.slides.push(newSlide());
  clampActive();

  const t = THEMES[deck.themeId];
  const slide = activeSlide();

  app.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, system-ui, Arial, sans-serif; }
      .root { height: 100vh; display: grid; grid-template-rows: 56px 1fr; }
      .topbar {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid #e5e7eb; background: #f9fafb;
      }
      .topbar input, .topbar select, .topbar button, .panel input, .panel textarea, .panel select {
        border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 9px; font-size: 13px;
      }
      .topbar button { cursor: pointer; background: white; }
      .topbar button.primary { background: #111827; color: white; border-color: #111827; }
      .main { display: grid; grid-template-columns: 220px 1fr 280px; height: calc(100vh - 56px); }
      .left { border-right: 1px solid #e5e7eb; overflow: auto; padding: 10px; }
      .thumb { border: 1px solid #d1d5db; border-radius: 10px; padding: 8px; margin-bottom: 8px; cursor: pointer; background: white; }
      .thumb.active { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb inset; }
      .thumb h4 { margin: 0 0 4px; font-size: 12px; }
      .thumb p { margin: 0; font-size: 11px; color: #6b7280; }
      .thumb-actions { margin-top: 6px; display: flex; gap: 4px; }
      .thumb-actions button { font-size: 11px; padding: 4px 6px; }
      .center { display: grid; place-items: center; background: #f3f4f6; padding: 18px; }
      .slide {
        width: min(900px, 100%); aspect-ratio: 16 / 9; border-radius: 14px;
        padding: 36px; overflow: auto; box-shadow: 0 10px 40px rgba(0,0,0,.12);
      }
      .slide h1 { margin-top: 0; margin-bottom: 14px; font-size: clamp(24px, 4vw, 44px); }
      .slide p { font-size: clamp(14px, 1.7vw, 26px); line-height: 1.35; white-space: pre-wrap; }
      .panel { border-left: 1px solid #e5e7eb; padding: 12px; overflow: auto; }
      .field { margin-bottom: 10px; display: grid; gap: 6px; }
      .field label { font-size: 12px; color: #4b5563; font-weight: 600; }
      .panel textarea { min-height: 140px; resize: vertical; }
      .muted { font-size: 12px; color: #6b7280; }
      .present {
        position: fixed; inset: 0; z-index: 9999; background: #0b1020; display: grid; place-items: center;
      }
      .present-ui { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); display:flex; gap:8px; }
      .present-ui button { border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
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
        <button id="dupBtn">Duplicate Slide</button>
        <button id="addBtn">Add Slide</button>
        <button id="saveBtn">Save</button>
        <button class="primary" id="presentBtn">Present</button>
        <button id="exportBtn">Export PDF</button>
        <span class="muted" style="margin-left:auto;">${deck.slides.length} slides</span>
      </div>
      <div class="main">
        <div class="left" id="thumbs"></div>
        <div class="center" id="canvas"></div>
        <div class="panel">
          <div class="field"><label>Layout</label>
            <select id="layoutSel">
              <option value="title-body" ${slide.layout === 'title-body' ? 'selected' : ''}>Title + Body</option>
              <option value="title-image" ${slide.layout === 'title-image' ? 'selected' : ''}>Title + Image</option>
              <option value="section" ${slide.layout === 'section' ? 'selected' : ''}>Section</option>
            </select>
          </div>
          <div class="field"><label>Title</label><input id="titleIn" value="${escapeHtml(slide.title)}"></div>
          <div class="field"><label>Body</label><textarea id="bodyIn">${escapeHtml(slide.body)}</textarea></div>
          <div class="field"><label>Image URL</label><input id="imgIn" placeholder="https://..." value="${escapeHtml(slide.imageUrl)}"></div>
          <div class="field"><button id="delBtn">Delete Slide</button></div>
          <div class="muted">Autosave is on. Tip: Ctrl/Cmd+S to save manually.</div>
        </div>
      </div>
    </div>
  `;

  const thumbs = app.querySelector('#thumbs') as HTMLDivElement;
  thumbs.innerHTML = '';
  deck.slides.forEach((s, idx) => {
    const el = document.createElement('div');
    el.className = `thumb ${idx === deck.activeIndex ? 'active' : ''}`;
    el.innerHTML = `<h4>${idx + 1}. ${escapeHtml(s.title || 'Untitled')}</h4><p>${escapeHtml((s.body || '').slice(0, 60))}</p>
      <div class="thumb-actions">
        <button data-act="up" data-idx="${idx}">↑</button>
        <button data-act="down" data-idx="${idx}">↓</button>
      </div>`;
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
        if (b.dataset.act === 'up' && i > 0) {
          [deck.slides[i - 1], deck.slides[i]] = [deck.slides[i], deck.slides[i - 1]];
          deck.activeIndex = i - 1;
        }
        if (b.dataset.act === 'down' && i < deck.slides.length - 1) {
          [deck.slides[i + 1], deck.slides[i]] = [deck.slides[i], deck.slides[i + 1]];
          deck.activeIndex = i + 1;
        }
        persist();
        render();
      });
    });
    thumbs.appendChild(el);
  });

  (app.querySelector('#canvas') as HTMLDivElement).innerHTML = renderSlideHtml(slide, deck.themeId);

  bindUi();
  persist();
}

function bindUi() {
  const slide = activeSlide();

  (app.querySelector('#deckTitle') as HTMLInputElement).oninput = (e) => {
    deck.title = (e.target as HTMLInputElement).value;
    persist();
  };

  (app.querySelector('#themeSelect') as HTMLSelectElement).onchange = (e) => {
    deck.themeId = (e.target as HTMLSelectElement).value as ThemeId;
    render();
  };

  (app.querySelector('#layoutSel') as HTMLSelectElement).onchange = (e) => {
    slide.layout = (e.target as HTMLSelectElement).value as SlideLayout;
    render();
  };

  (app.querySelector('#titleIn') as HTMLInputElement).oninput = (e) => {
    slide.title = (e.target as HTMLInputElement).value;
    render();
  };

  (app.querySelector('#bodyIn') as HTMLTextAreaElement).oninput = (e) => {
    slide.body = (e.target as HTMLTextAreaElement).value;
    render();
  };

  (app.querySelector('#imgIn') as HTMLInputElement).oninput = (e) => {
    slide.imageUrl = (e.target as HTMLInputElement).value;
    render();
  };

  (app.querySelector('#addBtn') as HTMLButtonElement).onclick = () => {
    deck.slides.splice(deck.activeIndex + 1, 0, newSlide());
    deck.activeIndex += 1;
    render();
  };

  (app.querySelector('#dupBtn') as HTMLButtonElement).onclick = () => {
    const s = activeSlide();
    deck.slides.splice(deck.activeIndex + 1, 0, { ...s, id: uid(), title: `${s.title} (copy)` });
    deck.activeIndex += 1;
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
    render();
  };

  (app.querySelector('#newDeckBtn') as HTMLButtonElement).onclick = () => {
    deck = newDeck();
    render();
  };

  (app.querySelector('#saveBtn') as HTMLButtonElement).onclick = () => {
    persist();
    flash('Saved');
  };

  (app.querySelector('#presentBtn') as HTMLButtonElement).onclick = () => {
    presenting = true;
    presentIndex = deck.activeIndex;
    renderPresent();
  };

  (app.querySelector('#exportBtn') as HTMLButtonElement).onclick = exportPdf;
}

function flash(msg: string) {
  const n = document.createElement('div');
  n.textContent = msg;
  n.style.cssText = 'position:fixed;top:14px;right:14px;background:#111827;color:white;padding:8px 10px;border-radius:8px;z-index:99999';
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 1000);
}

function renderPresent() {
  if (!presenting) return;
  const s = deck.slides[presentIndex];
  const wrap = document.createElement('div');
  wrap.className = 'present';
  wrap.innerHTML = `
    <div style="width:min(1200px,96vw);">${renderSlideHtml(s, deck.themeId)}</div>
    <div class="present-ui">
      <button id="prevP">Prev</button>
      <button id="nextP">Next</button>
      <button id="exitP">Exit</button>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => {
    presenting = false;
    wrap.remove();
    window.removeEventListener('keydown', onKey);
  };

  const rerenderPresent = () => {
    wrap.querySelector('div')!.innerHTML = renderSlideHtml(deck.slides[presentIndex], deck.themeId);
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
  if (!w) return alert('Popup blocked. Please allow popups to export PDF.');
  w.document.open();
  w.document.write(html);
  w.document.close();
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    persist();
    flash('Saved');
  }
});

render();
