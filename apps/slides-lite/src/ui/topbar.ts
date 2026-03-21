import html from '@bundled/solid-js/html';
import { getDeck, setDeck, deckVer, activeIndexVer, dirty, lastSavedAt, markDirty, persist, bumpDeck, bumpActiveIndex, activeSlide, setFilterQueryValue } from '../store';
import { newDeck, newSlide, isFontSize, FONT_SIZES } from '../deck-utils';
import { THEMES } from '../theme';
import { parseAspectRatio, RATIO_PRESETS, type RatioPreset } from '../aspect-ratio';
import { uuid, formatDistanceToNow } from '../utils';
import { startPresent } from './present';
import { exportPdf } from './export';
import type { ThemeId } from '../types';

export function createTopbar() {
  return html`
    <div class="topbar">
      <input
        value=${() => { deckVer(); return getDeck().title; }}
        style="min-width:220px"
        onInput=${(e: Event) => { getDeck().title = (e.target as HTMLInputElement).value; markDirty(); }}
      />
      <select onchange=${(e: Event) => {
        getDeck().themeId = (e.target as HTMLSelectElement).value as ThemeId;
        markDirty(); bumpDeck();
      }}>
        ${Object.entries(THEMES).map(([id, meta]) => html`<option value=${id} selected=${() => getDeck().themeId === id}>${meta.name}</option>`)}
      </select>
      ${() => renderRatioControls()}
      ${() => renderFontSizeControl()}
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        setDeck(newDeck()); setFilterQueryValue('');
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>New</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        const deck = getDeck();
        const s = activeSlide();
        deck.slides.splice(deck.activeIndex + 1, 0, { ...s, id: uuid(), title: `${s.title} (copy)` });
        deck.activeIndex += 1;
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>Duplicate</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
        const deck = getDeck();
        deck.slides.splice(deck.activeIndex + 1, 0, newSlide());
        deck.activeIndex += 1;
        markDirty(); bumpDeck(); bumpActiveIndex();
      }}>Add Slide</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => persist(true)}>Save</button>
      <button class="y-btn y-btn-sm y-btn-primary" onClick=${startPresent}>Present</button>
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${exportPdf}>Export PDF</button>
      <span class=${() => `chip${dirty() ? ' dirty' : ''}`}>
        ${() => dirty() ? 'Saving…' : `Saved ${formatDistanceToNow(lastSavedAt(), { addSuffix: true })}`}
      </span>
    </div>
  `;
}

function renderRatioControls() {
  activeIndexVer(); deckVer();
  const deck = getDeck();
  const ratio = parseAspectRatio(deck.aspectRatio);
  return html`
    <select title="Slide ratio" onchange=${(e: Event) => {
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

function renderFontSizeControl() {
  deckVer();
  const deck = getDeck();
  return html`
    <select title="Font size" onchange=${(e: Event) => {
      const val = (e.target as HTMLSelectElement).value;
      if (isFontSize(val)) { deck.fontSize = val; markDirty(); bumpDeck(); }
    }}>
      ${FONT_SIZES.map(s => html`<option value=${s} selected=${deck.fontSize === s}>${s.toUpperCase()}</option>`)}
    </select>
  `;
}
