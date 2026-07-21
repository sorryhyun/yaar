import html from '@bundled/solid-js/html';
import { getDeck, setDeck, deckVer, activeIndexVer, dirty, saveFailed, lastSavedAt, markDirty, persist, bumpDeck, bumpActiveIndex, activeSlide, setFilterQueryValue } from '../store';
import { newDeck, newSlide, isFontSize, FONT_SIZES } from '../deck-utils';
import { THEMES } from '../theme';
import { parseAspectRatio, RATIO_PRESETS, type RatioPreset } from '../aspect-ratio';
import { v4 as uuidv4 } from '@bundled/uuid';
import { formatDistanceToNow } from '@bundled/date-fns';
import { startPresent } from './present';
import { exportPdf } from './export';
import type { ThemeId } from '../types';

const DECK_ICON = html`<svg class="doc-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;

export function createTopbar() {
  return html`
    <div class="topbar">
      <div class="brand">
        <span class="brand-badge">S</span>
        <span class="brand-name">Slides Lite</span>
      </div>
      <div class="doc-meta">
        ${DECK_ICON}
        <input
          class="doc-title-input"
          placeholder="Untitled deck"
          value=${() => { deckVer(); return getDeck().title; }}
          onInput=${(e: Event) => { getDeck().title = (e.target as HTMLInputElement).value; markDirty(); }}
        />
      </div>
      <div class="header-actions">
        <button class="tb-btn tb-btn-text" onClick=${exportPdf}>Export PDF</button>
        <button class="tb-btn tb-btn-text tb-btn-primary" onClick=${startPresent}>Present</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="tb-group">
        <select class="tb-select" title="Theme" onchange=${(e: Event) => {
          getDeck().themeId = (e.target as HTMLSelectElement).value as ThemeId;
          markDirty(); bumpDeck();
        }}>
          ${Object.entries(THEMES).map(([id, meta]) => html`<option value=${id} selected=${() => getDeck().themeId === id}>${meta.name}</option>`)}
        </select>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-group">${() => renderRatioControls()}</div>
      <div class="tb-sep"></div>
      <div class="tb-group">${() => renderFontSizeControl()}</div>
      <div class="tb-sep"></div>
      <div class="tb-group">
        <button class="tb-btn tb-btn-text" onClick=${() => {
          setDeck(newDeck()); setFilterQueryValue('');
          markDirty(); bumpDeck(); bumpActiveIndex();
        }}>New</button>
        <button class="tb-btn tb-btn-text" onClick=${() => {
          const deck = getDeck();
          const s = activeSlide();
          deck.slides.splice(deck.activeIndex + 1, 0, { ...s, id: uuidv4(), title: `${s.title} (copy)` });
          deck.activeIndex += 1;
          markDirty(); bumpDeck(); bumpActiveIndex();
        }}>Duplicate</button>
        <button class="tb-btn tb-btn-text" onClick=${() => {
          const deck = getDeck();
          deck.slides.splice(deck.activeIndex + 1, 0, newSlide());
          deck.activeIndex += 1;
          markDirty(); bumpDeck(); bumpActiveIndex();
        }}>Add Slide</button>
      </div>
      <div class="tb-spacer"></div>
      <button class="tb-btn tb-btn-text tb-btn-bordered" onClick=${() => persist(true)}>Save</button>
      <span class=${() => `chip${dirty() || saveFailed() ? ' dirty' : ''}`}>
        ${() => saveFailed()
          ? 'Not saved'
          : dirty()
            ? 'Saving…'
            : `Saved ${formatDistanceToNow(new Date(lastSavedAt()), { addSuffix: true })}`}
      </span>
    </div>
  `;
}

function renderRatioControls() {
  activeIndexVer(); deckVer();
  const deck = getDeck();
  const ratio = parseAspectRatio(deck.aspectRatio);
  return html`
    <select class="tb-select" title="Slide ratio" onchange=${(e: Event) => {
      const value = (e.target as HTMLSelectElement).value as RatioPreset;
      if (value !== 'custom') {
        deck.aspectRatio = value;
      } else {
        const p = parseAspectRatio(deck.aspectRatio);
        deck.aspectRatio = `${p.width}:${p.height}`;
      }
      markDirty(); bumpDeck();
    }}>
      ${RATIO_PRESETS.map(r => html`<option value=${r} selected=${ratio.preset === r}>${r}</option>`)}
      <option value="custom" selected=${ratio.preset === 'custom'}>Custom</option>
    </select>
    <input class="tb-num" type="number" min="0.1" step="0.1" value=${ratio.width}
      disabled=${ratio.preset !== 'custom'}
      onInput=${(e: Event) => {
        const w = Number((e.target as HTMLInputElement).value);
        const p = parseAspectRatio(deck.aspectRatio);
        if (w > 0) { deck.aspectRatio = `${Number(w.toFixed(3))}:${p.height}`; markDirty(); bumpDeck(); }
      }}
    />
    <span class="tb-colon">:</span>
    <input class="tb-num" type="number" min="0.1" step="0.1" value=${ratio.height}
      disabled=${ratio.preset !== 'custom'}
      onInput=${(e: Event) => {
        const h = Number((e.target as HTMLInputElement).value);
        const p = parseAspectRatio(deck.aspectRatio);
        if (h > 0) { deck.aspectRatio = `${p.width}:${Number(h.toFixed(3))}`; markDirty(); bumpDeck(); }
      }}
    />
  `;
}

function renderFontSizeControl() {
  deckVer();
  const deck = getDeck();
  return html`
    <select class="tb-select" title="Font size" onchange=${(e: Event) => {
      const val = (e.target as HTMLSelectElement).value;
      if (isFontSize(val)) { deck.fontSize = val; markDirty(); bumpDeck(); }
    }}>
      ${FONT_SIZES.map(s => html`<option value=${s} selected=${deck.fontSize === s}>${s.toUpperCase()}</option>`)}
    </select>
  `;
}
