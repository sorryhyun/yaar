import html from '@bundled/solid-js/html';
import { onCleanup } from '@bundled/solid-js';
import { getDeck, deckVer, bumpDeck, bumpActiveIndex, filterQueryValue, setFilterQueryValue, moveSlide } from '../store';
import { newSlide } from '../deck-utils';
import {
  sidebarExpanded,
  sidebarPinned,
  openSidebar,
  scheduleSidebarClose,
  cancelSidebarClose,
  toggleSidebarPin,
} from '../sidebar';

export function createThumbnailList() {
  onCleanup(cancelSidebarClose);
  return html`
    <div
      class=${() =>
        'sidebar' +
        (sidebarExpanded() ? ' expanded' : '') +
        (sidebarPinned() ? ' pinned' : '')}
      onMouseEnter=${openSidebar}
      onMouseLeave=${scheduleSidebarClose}
    >
      ${() => renderRail()}
      <div class="sidebar-panel y-scroll">
        <div class="left-head">
          <div class="left-title">
            <span>Slides</span>
            <div class="left-title-right">
              <span class="left-count">${() => { deckVer(); return getDeck().slides.length; }}</span>
              <button
                class=${() => 'pin-btn' + (sidebarPinned() ? ' active' : '')}
                title=${() => (sidebarPinned() ? 'Unpin sidebar' : 'Keep sidebar open')}
                onClick=${() => toggleSidebarPin()}
              >${() => (sidebarPinned() ? '📌' : '📍')}</button>
            </div>
          </div>
          <input class="filter-input" placeholder="Filter slides…" onInput=${(e: Event) => {
            setFilterQueryValue((e.target as HTMLInputElement).value);
            bumpDeck();
          }} />
          <small>Tip: Alt+↑ / Alt+↓ to reorder • Ctrl/Cmd+Enter to present</small>
        </div>
        <div class="thumb-scroll">${() => renderThumbList()}</div>
      </div>
    </div>
  `;
}

// Collapsed rail: compact, always-visible slide indicators so the user knows
// slides are there and can jump to one without expanding.
function renderRail() {
  deckVer(); // track
  const deck = getDeck();
  return html`
    <div class="rail">
      <div class="rail-badge" title=${`${deck.slides.length} slides`}>${deck.slides.length}</div>
      <div class="rail-slides">
        ${deck.slides.map((s, idx) => html`
          <button
            class=${() => 'rail-chip' + (getDeck().activeIndex === idx ? ' active' : '')}
            title=${`${idx + 1}. ${s.title || 'Untitled'}`}
            onClick=${() => {
              getDeck().activeIndex = idx;
              bumpDeck();
              bumpActiveIndex();
            }}
          >${idx + 1}</button>
        `)}
      </div>
      <button class="rail-add" title="Add slide" onClick=${(e: Event) => {
        e.stopPropagation();
        const deck = getDeck();
        deck.slides.splice(deck.activeIndex + 1, 0, newSlide());
        deck.activeIndex += 1;
        bumpDeck(); bumpActiveIndex();
      }}>+</button>
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
        <h4>${idx + 1}. ${s.title || 'Untitled'}</h4>
        <p>${(s.body || '').slice(0, 72)}</p>
        <div class="thumb-badges">
          <span class="thumb-badge">${s.layout}</span>
          <div class="thumb-actions">
            <button onClick=${(e: Event) => { e.stopPropagation(); moveSlide(idx, idx - 1); }}>↑</button>
            <button onClick=${(e: Event) => { e.stopPropagation(); moveSlide(idx, idx + 1); }}>↓</button>
          </div>
        </div>
      </div>
    `);
}
