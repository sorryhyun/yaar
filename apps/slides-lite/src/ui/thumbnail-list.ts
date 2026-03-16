import html from '@bundled/solid-js/html';
import { getDeck, deckVer, bumpDeck, bumpActiveIndex, filterQueryValue, setFilterQueryValue, moveSlide } from '../store';
import { escapeHtml } from '../markdown';

export function createThumbnailList() {
  return html`
    <div class="left y-scroll">
      <div class="left-head">
        <input placeholder="Filter slides\u2026" onInput=${(e: Event) => {
          setFilterQueryValue((e.target as HTMLInputElement).value);
          bumpDeck();
        }} />
        <small>Tip: Alt+↑ / Alt+↓ to reorder • Ctrl/Cmd+Enter to present</small>
      </div>
      <div>${() => renderThumbList()}</div>
    </div>
  `;
}

function renderThumbList() {
  deckVer(); // track
  const deck = getDeck();
  const q = filterQueryValue.trim().toLowerCase();
  return deck.slides
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !q || `${s.title} ${s.body} ${s.notes}`.toLowerCase().includes(q))
    .map(({ s, idx }) => html`
      <div
        class=${() => `thumb${getDeck().activeIndex === idx ? ' active' : ''}`}
        onClick=${(e: Event) => {
          if ((e.target as HTMLElement).tagName === 'BUTTON') return;
          getDeck().activeIndex = idx;
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
