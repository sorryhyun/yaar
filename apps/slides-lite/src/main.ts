import { saveDeck, loadDeck } from './storage';

const uuid = () =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function formatDistanceToNow(ts: number, opts?: { addSuffix?: boolean }) {
  const delta = Date.now() - ts;
  const sec = Math.max(1, Math.floor(Math.abs(delta) / 1000));
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let n = sec;
  let label = 'second';
  for (const [base, name] of units) {
    label = name;
    if (n < base) break;
    n = Math.floor(n / base);
  }
  const txt = `${n} ${label}${n === 1 ? '' : 's'}`;
  if (!opts?.addSuffix) return txt;
  return delta >= 0 ? `${txt} ago` : `in ${txt}`;
}
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

const RATIO_PRESETS = ['16:9', '4:3', '1:1'] as const;
type RatioPreset = (typeof RATIO_PRESETS)[number] | 'custom';

function normalizeAspectRatio(value: unknown): string {
  return parseAspectRatio(typeof value === 'string' ? value : '16:9').normalized;
}

function parseAspectRatio(value: string): {
  width: number;
  height: number;
  cssValue: string;
  normalized: string;
  preset: RatioPreset;
} {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  const width = m ? Number(m[1]) : 16;
  const height = m ? Number(m[2]) : 9;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 16, height: 9, cssValue: '16 / 9', normalized: '16:9', preset: '16:9' };
  }

  const normWidth = Number(width.toFixed(3));
  const normHeight = Number(height.toFixed(3));
  const normalized = `${normWidth}:${normHeight}`;
  const preset = (RATIO_PRESETS.includes(normalized as (typeof RATIO_PRESETS)[number])
    ? normalized
    : 'custom') as RatioPreset;

  return {
    width: normWidth,
    height: normHeight,
    cssValue: `${normWidth} / ${normHeight}`,
    normalized,
    preset,
  };
}

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
    aspectRatio: normalizeAspectRatio(raw.aspectRatio),
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
    aspectRatio: '16:9',
  };
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEMES;
}

function isSlideLayout(value: unknown): value is SlideLayout {
  return value === 'title-body' || value === 'title-image' || value === 'section';
}

function normalizeSlideInput(raw: Partial<Slide> | null | undefined): Slide {
  const source = raw ?? {};
  return {
    id: source.id || uuid(),
    layout: isSlideLayout(source.layout) ? source.layout : 'title-body',
    title: source.title || '',
    body: source.body || '',
    imageUrl: source.imageUrl || '',
    notes: source.notes || '',
  };
}

function cloneDeckValue() {
  return JSON.parse(JSON.stringify(deck)) as Deck;
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

function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function renderInlineMarkdown(raw: string): string {
  const tokens: string[] = [];
  const token = (html: string) => {
    tokens.push(html);
    return `@@TOK${tokens.length - 1}@@`;
  };

  let working = raw
    .replace(/`([^`\n]+)`/g, (_m, code: string) => token(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_m, text: string, href: string) => {
      const safeHref = sanitizeUrl(href);
      if (!safeHref) return token(escapeHtml(text));
      return token(
        `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`,
      );
    });

  working = escapeHtml(working)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');

  return working.replace(/@@TOK(\d+)@@/g, (_m, idx: string) => tokens[Number(idx)] ?? '');
}

function containsMarkdownSyntax(text: string): boolean {
  return /(^#{1,6}\s)|(^>\s)|(^\s*[-*+]\s)|(^\s*\d+\.\s)|(\*\*)|(\*)|(`)|\[[^\]]+\]\([^\)]+\)|(^```)|(^---\s*$)/m.test(
    text,
  );
}

function renderBodyContent(raw: string): string {
  const text = raw || '';
  if (!containsMarkdownSyntax(text)) {
    return `<p>${escapeHtml(text).replaceAll('\n', '<br/>')}</p>`;
  }

  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeLines: string[] = [];

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  const flushCode = () => {
    if (!inCode) return;
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    inCode = false;
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeLists();
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeLists();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${renderInlineMarkdown(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${renderInlineMarkdown(ol[1])}</li>`);
      continue;
    }

    if (/^---\s*$/.test(line)) {
      closeLists();
      out.push('<hr/>');
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      closeLists();
      out.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    closeLists();
    out.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeLists();
  flushCode();

  return out.length ? out.join('') : '<p></p>';
}

function renderSlideHtml(slide: Slide, themeId: ThemeId): string {
  const t = THEMES[themeId];
  const image = slide.imageUrl
    ? `<img src="${slide.imageUrl}" style="max-width:100%; max-height:260px; border-radius:12px; margin-top:12px; box-shadow:0 8px 20px rgba(0,0,0,.15);"/>`
    : '';

  if (slide.layout === 'section') {
    return `<div class="slide section" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Section')}</h1>
      <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
    </div>`;
  }

  if (slide.layout === 'title-image') {
    return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Title')}</h1>
      ${image || '<div style="opacity:.65; padding:8px 0;">No image selected</div>'}
      <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
    </div>`;
  }

  return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
    <h1>${escapeHtml(slide.title || 'Title')}</h1>
    <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
  </div>`;
}

function render() {
  if (!deck.slides.length) deck.slides.push(newSlide());
  clampActive();

  const t = THEMES[deck.themeId];
  const slide = activeSlide();
  const ratio = parseAspectRatio(deck.aspectRatio);

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
        width: min(980px, 100%); aspect-ratio: ${ratio.cssValue}; border-radius: 16px;
        padding: 38px; overflow: auto; box-shadow: 0 16px 42px rgba(0,0,0,.18);
      }
      .slide h1 { margin-top: 0; margin-bottom: 14px; font-size: clamp(24px, 4vw, 44px); }
      .slide-body { font-size: clamp(14px, 1.7vw, 26px); line-height: 1.35; }
      .slide-body p { margin: 0 0 10px; }
      .slide-body ul, .slide-body ol { margin: 0 0 12px 1.2em; padding: 0; }
      .slide-body li { margin: 0 0 6px; }
      .slide-body h2, .slide-body h3, .slide-body h4, .slide-body h5, .slide-body h6 { margin: 8px 0 8px; }
      .slide-body blockquote { margin: 8px 0; padding: 6px 12px; border-left: 4px solid ${t.accent}; opacity: 0.92; }
      .slide-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(148, 163, 184, 0.18); border-radius: 5px; padding: 0 4px; }
      .slide-body pre { margin: 10px 0; padding: 10px 12px; border-radius: 10px; background: rgba(15, 23, 42, 0.08); overflow: auto; }
      .slide-body pre code { background: transparent; padding: 0; }
      .slide-body hr { border: 0; border-top: 1px solid rgba(100, 116, 139, 0.45); margin: 12px 0; }
      .slide-body a { color: ${t.accent}; text-decoration: underline; }
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
        <select id="ratioSel" title="Slide ratio">
          ${RATIO_PRESETS.map((r) => `<option value="${r}" ${ratio.preset === r ? 'selected' : ''}>${r}</option>`).join('')}
          <option value="custom" ${ratio.preset === 'custom' ? 'selected' : ''}>Custom</option>
        </select>
        <input id="ratioW" type="number" min="0.1" step="0.1" value="${ratio.width}" style="width:72px;" ${ratio.preset === 'custom' ? '' : 'disabled'} />
        <span>:</span>
        <input id="ratioH" type="number" min="0.1" step="0.1" value="${ratio.height}" style="width:72px;" ${ratio.preset === 'custom' ? '' : 'disabled'} />
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
          <div class="field"><label>Body (Markdown supported) <span class="small">${slide.body.length} chars</span></label><textarea id="bodyIn">${escapeHtml(slide.body)}</textarea></div>
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
      slideEl.animate(
        [
          { opacity: 0, transform: 'translateY(16px)' },
          { opacity: 1, transform: 'translateY(0px)' },
        ],
        { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
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

  const ratioSel = app.querySelector('#ratioSel') as HTMLSelectElement;
  const ratioW = app.querySelector('#ratioW') as HTMLInputElement;
  const ratioH = app.querySelector('#ratioH') as HTMLInputElement;

  ratioSel.onchange = (e) => {
    const value = (e.target as HTMLSelectElement).value as RatioPreset;
    if (value === 'custom') {
      ratioW.disabled = false;
      ratioH.disabled = false;
      const parsed = parseAspectRatio(deck.aspectRatio);
      deck.aspectRatio = `${parsed.width}:${parsed.height}`;
    } else {
      ratioW.disabled = true;
      ratioH.disabled = true;
      deck.aspectRatio = value;
    }
    markDirty();
    render();
  };

  const updateCustomRatio = () => {
    if (ratioSel.value !== 'custom') return;
    const w = Number(ratioW.value);
    const h = Number(ratioH.value);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    deck.aspectRatio = `${Number(w.toFixed(3))}:${Number(h.toFixed(3))}`;
    markDirty();
    render();
  };

  ratioW.oninput = updateCustomRatio;
  ratioH.oninput = updateCustomRatio;

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
  n.animate(
    [
      { opacity: 0, transform: 'translateY(-10px)' },
      { opacity: 1, transform: 'translateY(0px)' },
    ],
    { duration: 220, easing: 'ease-out' },
  );
  setTimeout(() => {
    const anim = n.animate(
      [
        { opacity: 1, transform: 'translateY(0px)' },
        { opacity: 0, transform: 'translateY(-6px)' },
      ],
      { duration: 180, easing: 'ease-in' },
    );
    anim.onfinish = () => n.remove();
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
    (slot.querySelector('.slide') as HTMLElement | null)?.animate(
      [
        { opacity: 0.3, transform: 'translateX(10px)' },
        { opacity: 1, transform: 'translateX(0px)' },
      ],
      { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
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
  const ratio = parseAspectRatio(deck.aspectRatio);
  const html = `
    <html>
      <head>
        <title>${escapeHtml(deck.title)}</title>
        <style>
          body { margin:0; font-family: Inter, Arial, sans-serif; }
          .page { page-break-after: always; padding: 24px; }
          .slide { width: 100%; aspect-ratio: ${ratio.cssValue}; border-radius: 12px; padding: 32px; box-sizing: border-box; }
          .slide h1 { margin:0 0 12px; font-size: 42px; }
          .slide-body { font-size: 24px; line-height: 1.35; }
          .slide-body p { margin: 0 0 10px; }
          .slide-body ul, .slide-body ol { margin: 0 0 12px 1.2em; padding: 0; }
          .slide-body li { margin: 0 0 6px; }
          .slide-body blockquote { margin: 8px 0; padding: 6px 12px; border-left: 4px solid #475569; }
          .slide-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
          .slide-body pre { margin: 10px 0; padding: 10px 12px; border-radius: 8px; background: rgba(15, 23, 42, 0.08); overflow: auto; }
          .slide-body a { color: #1d4ed8; text-decoration: underline; }
          @media print { .page:last-child { page-break-after: auto; } }
        </style>
      </head>
      <body>
        ${deck.slides.map((s) => `<div class="page">${renderSlideHtml(s, deck.themeId)}</div>`).join('')}
        <script>window.onload = () => window.print();<\/script>
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

// ── App Protocol ───────────────────────────────────────────────────────────────
const appApi = (window as any).yaar?.app;

type StorageReadMode = 'text' | 'json' | 'auto';
type StorageMergeMode = 'replace' | 'append';

function parseDeckOrSlidesFromStorage(raw: string, fallbackTitle: string): { title: string; slides: Slide[] } {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      const slides = parsed.map((item) => normalizeSlideInput(item as Partial<Slide>));
      return { title: fallbackTitle, slides: slides.length ? slides : [newSlide()] };
    }

    if (parsed && typeof parsed === 'object') {
      const maybeDeck = parsed as Partial<Deck>;
      if (Array.isArray(maybeDeck.slides)) {
        const normalized = normalizeDeck({
          title: maybeDeck.title || fallbackTitle,
          themeId: isThemeId(maybeDeck.themeId) ? maybeDeck.themeId : 'classic-light',
          slides: maybeDeck.slides.map((s) => normalizeSlideInput(s)),
          activeIndex: typeof maybeDeck.activeIndex === 'number' ? maybeDeck.activeIndex : 0,
          aspectRatio: normalizeAspectRatio((maybeDeck as Deck).aspectRatio),
        });
        return { title: normalized.title, slides: normalized.slides };
      }
    }
  } catch {
    // non-json input -> plain text slide
  }

  return {
    title: fallbackTitle,
    slides: [
      normalizeSlideInput({
        title: fallbackTitle,
        body: raw,
      }),
    ],
  };
}

if (appApi) {
  appApi.register({
    appId: 'slides-lite',
    name: 'Slides Lite',
    state: {
      deck: {
        description: 'Current full deck object',
        handler: () => cloneDeckValue(),
      },
      activeSlide: {
        description: 'Currently selected slide',
        handler: () => ({ ...activeSlide() }),
      },
      title: {
        description: 'Current deck title',
        handler: () => deck.title,
      },
      theme: {
        description: 'Current deck theme id',
        handler: () => deck.themeId,
      },
      aspectRatio: {
        description: 'Current slide aspect ratio (e.g., 16:9)',
        handler: () => deck.aspectRatio,
      },
      activeIndex: {
        description: 'Current active slide index',
        handler: () => deck.activeIndex,
      },
      slideCount: {
        description: 'Number of slides in the deck',
        handler: () => deck.slides.length,
      },
    },
    commands: {
      setDeck: {
        description: 'Replace entire deck. Params: { deck: Deck }',
        params: {
          type: 'object',
          properties: {
            deck: { type: 'object' },
          },
          required: ['deck'],
        },
        handler: (p: { deck: Deck }) => {
          deck = normalizeDeck(p.deck);
          filterQuery = '';
          persist(false);
          render();
          return { ok: true, slideCount: deck.slides.length };
        },
      },
      setSlides: {
        description: 'Set slides in replace/append mode. Params: { slides: Slide[], mode?: "replace"|"append" }',
        params: {
          type: 'object',
          properties: {
            slides: { type: 'array', items: { type: 'object' } },
            mode: { type: 'string', enum: ['replace', 'append'] },
          },
          required: ['slides'],
        },
        handler: (p: { slides: Partial<Slide>[]; mode?: StorageMergeMode }) => {
          const slides = (Array.isArray(p.slides) ? p.slides : []).map((s) => normalizeSlideInput(s));
          const mode = p.mode || 'replace';

          if (mode === 'append') {
            if (slides.length) deck.slides.push(...slides);
            deck.activeIndex = Math.max(0, deck.slides.length - 1);
          } else {
            deck.slides = slides.length ? slides : [newSlide()];
            deck.activeIndex = 0;
          }

          clampActive();
          persist(false);
          render();
          return { ok: true, mode, slideCount: deck.slides.length };
        },
      },
      appendSlides: {
        description: 'Append many slides at once. Params: { slides: Slide[] }',
        params: {
          type: 'object',
          properties: {
            slides: { type: 'array', items: { type: 'object' } },
          },
          required: ['slides'],
        },
        handler: (p: { slides: Partial<Slide>[] }) => {
          const slides = (Array.isArray(p.slides) ? p.slides : []).map((s) => normalizeSlideInput(s));
          if (slides.length) {
            deck.slides.push(...slides);
            deck.activeIndex = deck.slides.length - 1;
            clampActive();
            persist(false);
            render();
          }
          return { ok: true, appended: slides.length, slideCount: deck.slides.length };
        },
      },
      setActiveIndex: {
        description: 'Set active slide index. Params: { index: number }',
        params: {
          type: 'object',
          properties: {
            index: { type: 'number' },
          },
          required: ['index'],
        },
        handler: (p: { index: number }) => {
          deck.activeIndex = Math.max(0, Math.min(Math.floor(p.index), deck.slides.length - 1));
          render();
          return { ok: true, activeIndex: deck.activeIndex };
        },
      },
      setTheme: {
        description: 'Set deck theme. Params: { themeId: ThemeId }',
        params: {
          type: 'object',
          properties: {
            themeId: { type: 'string' },
          },
          required: ['themeId'],
        },
        handler: (p: { themeId: ThemeId }) => {
          if (!isThemeId(p.themeId)) {
            return { ok: false, error: `Invalid themeId: ${String(p.themeId)}` };
          }
          deck.themeId = p.themeId;
          persist(false);
          render();
          return { ok: true, themeId: deck.themeId };
        },
      },
      setAspectRatio: {
        description: 'Set deck aspect ratio. Params: { aspectRatio: string }',
        params: {
          type: 'object',
          properties: {
            aspectRatio: { type: 'string' },
          },
          required: ['aspectRatio'],
        },
        handler: (p: { aspectRatio: string }) => {
          deck.aspectRatio = normalizeAspectRatio(p.aspectRatio);
          persist(false);
          render();
          return { ok: true, aspectRatio: deck.aspectRatio };
        },
      },
      saveToStorage: {
        description: 'Save current deck JSON to YAAR storage. Params: { path: string }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
        handler: async (p: { path: string }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const json = JSON.stringify(deck, null, 2);
          await storage.save(p.path, json);
          return { ok: true, path: p.path, slideCount: deck.slides.length };
        },
      },
      loadFromStorage: {
        description: 'Load one/many files from YAAR storage and merge into deck. Params: { path?: string, paths?: string[], mode?: "replace"|"append" }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['replace', 'append'] },
          },
        },
        handler: async (p: { path?: string; paths?: string[]; mode?: StorageMergeMode }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const candidatePaths = [
            ...(p.path ? [p.path] : []),
            ...(Array.isArray(p.paths) ? p.paths : []),
          ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

          if (!candidatePaths.length) {
            return { ok: false, error: 'Provide path or paths' };
          }

          const loadedSlides: Slide[] = [];
          let firstTitle = deck.title;

          for (const path of candidatePaths) {
            const raw: string = await storage.read(path, { as: 'text' });
            const fallbackTitle = (path.split('/').pop() || path).replace(/\.[^/.]+$/, '') || 'Imported Deck';
            const parsed = parseDeckOrSlidesFromStorage(raw, fallbackTitle);
            if (!firstTitle || firstTitle === 'Untitled Deck') firstTitle = parsed.title || firstTitle;
            loadedSlides.push(...parsed.slides);
          }

          const mode = p.mode || 'replace';
          if (mode === 'append') {
            if (loadedSlides.length) deck.slides.push(...loadedSlides);
            deck.activeIndex = Math.max(0, deck.slides.length - 1);
          } else {
            deck.slides = loadedSlides.length ? loadedSlides : [newSlide()];
            deck.activeIndex = 0;
            deck.title = firstTitle || deck.title;
          }

          clampActive();
          persist(false);
          render();
          return { ok: true, mode, loaded: loadedSlides.length, paths: candidatePaths };
        },
      },
      readStorageFile: {
        description: 'Read one file from YAAR storage. Params: { path: string, as?: "text"|"json"|"auto" }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            as: { type: 'string', enum: ['text', 'json', 'auto'] },
          },
          required: ['path'],
        },
        handler: async (p: { path: string; as?: StorageReadMode }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const readAs = p.as || 'text';
          const content = await storage.read(p.path, { as: readAs });
          return { ok: true, path: p.path, as: readAs, content };
        },
      },
      readStorageFiles: {
        description: 'Read many files from YAAR storage. Params: { paths: string[], as?: "text"|"json"|"auto" }',
        params: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
            as: { type: 'string', enum: ['text', 'json', 'auto'] },
          },
          required: ['paths'],
        },
        handler: async (p: { paths: string[]; as?: StorageReadMode }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const readAs = p.as || 'text';
          const paths = (Array.isArray(p.paths) ? p.paths : []).filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          );
          const files = await Promise.all(
            paths.map(async (path) => ({
              path,
              content: await storage.read(path, { as: readAs }),
            })),
          );
          return { ok: true, as: readAs, files };
        },
      },
    },
  });
}
