import { createEffect } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import Prism from '@bundled/prismjs';
import './styles.css';
import { loadDeck } from './storage';
import { normalizeDeck } from './deck-utils';
import { parseAspectRatio } from './aspect-ratio';
import { renderSlideHtml } from './slide-render';
import { THEMES } from './theme';
import {
  getDeck, setDeck, deckVer,
  activeSlide, clampActive, persist, markDirty, moveSlide,
  bumpDeck, bumpActiveIndex,
  isPresenting,
  filterQueryValue, setFilterQueryValue,
} from './store';
import { createTopbar } from './ui/topbar';
import { createThumbnailList } from './ui/thumbnail-list';
import { createEditorPanel } from './ui/editor-panel';
import { startPresent } from './ui/present';
import { registerProtocol } from './protocol';
import type { Deck } from './types';

// DOM ref for canvas
let canvasEl!: HTMLDivElement;

// Mount
render(() => html`
  <div class="root y-light">
    ${createTopbar()}
    <div class="main">
      ${createThumbnailList()}
      <div
        class="center"
        ref=${(el: HTMLDivElement) => { canvasEl = el; }}
        style=${() => { deckVer(); return `background:${THEMES[getDeck().themeId].canvas}`; }}
      ></div>
      ${createEditorPanel()}
    </div>
  </div>
`, document.getElementById('app')!);

// Reactive canvas update
createEffect(() => {
  deckVer();
  if (!canvasEl) return;
  canvasEl.innerHTML = renderSlideHtml(activeSlide(), getDeck().themeId, getDeck().fontSize);
  Prism.highlightAllUnder(canvasEl);
  const slideEl = canvasEl.querySelector('.slide') as HTMLElement | null;
  if (slideEl) {
    const ratio = parseAspectRatio(getDeck().aspectRatio);
    slideEl.style.aspectRatio = ratio.cssValue;
    slideEl.animate(
      [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0px)' }],
      { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); persist(true);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !isPresenting()) {
    e.preventDefault(); startPresent();
  }
  const deck = getDeck();
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveSlide(deck.activeIndex, deck.activeIndex - 1); }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveSlide(deck.activeIndex, deck.activeIndex + 1); }
});

// Async initialization
(async () => {
  const saved = await loadDeck();
  if (saved) {
    setDeck(normalizeDeck(saved as Partial<Deck> & Pick<Deck, 'slides'>));
    bumpDeck();
    bumpActiveIndex();
  }
  persist(false);
})();

// App Protocol
registerProtocol({
  getDeck,
  setDeck,
  getFilterQuery: () => filterQueryValue,
  setFilterQuery: (q: string) => setFilterQueryValue(q),
  activeSlide,
  clampActive,
  persist,
  bumpDeck,
  bumpActiveIndex,
});
