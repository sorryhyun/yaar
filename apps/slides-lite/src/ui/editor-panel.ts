import html from '@bundled/solid-js/html';
import { getDeck, activeIndexVer, activeSlide, markDirty, bumpDeck, bumpActiveIndex, clampActive } from '../store';
import { newSlide, isFontSize, FONT_SIZES } from '../deck-utils';
import { debounce } from '../utils';
import type { SlideLayout } from '../types';

// Debounced version of bumpDeck for text input fields (350ms)
const debouncedBumpDeck = debounce(() => bumpDeck(), 350);

export function createEditorPanel() {
  return html`<div class="panel">${() => renderEditorPanel()}</div>`;
}

function renderEditorPanel() {
  activeIndexVer();
  const slide = activeSlide();
  const deck = getDeck();

  return html`
    <div class="field">
      <label>Layout</label>
      <select onchange=${(e: Event) => {
        slide.layout = (e.target as HTMLSelectElement).value as SlideLayout;
        markDirty(); bumpDeck();
      }}>
        <option value="title-body" selected=${slide.layout === 'title-body'}>Title + Body</option>
        <option value="title-image" selected=${slide.layout === 'title-image'}>Title + Image</option>
        <option value="section" selected=${slide.layout === 'section'}>Section</option>
      </select>
    </div>
    <div class="field">
      <label>Title <span class="small">${slide.title.length} chars</span></label>
      <input value=${slide.title} onInput=${(e: Event) => {
        slide.title = (e.target as HTMLInputElement).value;
        markDirty(); debouncedBumpDeck();
      }} />
    </div>
    <div class="field">
      <label>Body (Markdown) <span class="small">${slide.body.length} chars</span></label>
      <textarea onInput=${(e: Event) => {
        slide.body = (e.target as HTMLTextAreaElement).value;
        markDirty(); debouncedBumpDeck();
      }}>${slide.body}</textarea>
    </div>
    <div class="field">
      <label>Speaker Notes</label>
      <textarea placeholder="Private presenter notes..." onInput=${(e: Event) => {
        slide.notes = (e.target as HTMLTextAreaElement).value;
        markDirty();
      }}>${slide.notes}</textarea>
    </div>
    <div class="field">
      <label>Image URL</label>
      <input placeholder="https://..." value=${slide.imageUrl} onInput=${(e: Event) => {
        slide.imageUrl = (e.target as HTMLInputElement).value;
        markDirty(); debouncedBumpDeck();
      }} />
    </div>
    <div class="field">
      <label>Font Size <span class="small">overrides deck setting</span></label>
      <select onchange=${(e: Event) => {
        const val = (e.target as HTMLSelectElement).value;
        if (val === '') { delete slide.fontSize; }
        else if (isFontSize(val)) { slide.fontSize = val; }
        markDirty(); bumpDeck();
      }}>
        <option value="" selected=${!slide.fontSize}>Default (deck)</option>
        ${FONT_SIZES.map(s => html`<option value=${s} selected=${slide.fontSize === s}>${s.toUpperCase()}</option>`)}
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
