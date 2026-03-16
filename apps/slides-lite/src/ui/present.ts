import Prism from '@bundled/prismjs';
import {
  getDeck,
  presenting, setPresenting,
  presentIndex, setPresentIndex,
  presentStartedAt, setPresentStartedAt,
  presentTimerId, setPresentTimerId,
} from '../store';
import { renderSlideHtml } from '../slide-render';

export function startPresent() {
  setPresenting(true);
  setPresentIndex(getDeck().activeIndex);
  setPresentStartedAt(Date.now());
  renderPresentMode();
}

function renderPresentMode() {
  if (!presenting) return;
  const deck = getDeck();
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
  Prism.highlightAllUnder(wrap);

  const rerender = () => {
    const d = getDeck();
    const slot = wrap.querySelector('#presentSlideWrap') as HTMLDivElement;
    slot.innerHTML = renderSlideHtml(d.slides[presentIndex], d.themeId, d.fontSize);
    Prism.highlightAllUnder(slot);
    (wrap.querySelector('#presentProgress') as HTMLDivElement).style.width = `${((presentIndex + 1) / d.slides.length) * 100}%`;
    (wrap.querySelector('#presentCounter') as HTMLSpanElement).textContent = `${presentIndex + 1} / ${d.slides.length}`;
    (slot.querySelector('.slide') as HTMLElement | null)?.animate(
      [{ opacity: 0.3, transform: 'translateX(10px)' }, { opacity: 1, transform: 'translateX(0px)' }],
      { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  };

  const close = () => {
    setPresenting(false);
    const tid = presentTimerId;
    if (tid) window.clearInterval(tid);
    setPresentTimerId(null);
    wrap.remove();
    window.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!presenting) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight' && presentIndex < getDeck().slides.length - 1) { setPresentIndex(presentIndex + 1); rerender(); }
    if (e.key === 'ArrowLeft' && presentIndex > 0) { setPresentIndex(presentIndex - 1); rerender(); }
  };

  const tid = window.setInterval(() => {
    const timer = wrap.querySelector('#presentTimer') as HTMLSpanElement | null;
    if (!timer) return;
    const totalSec = Math.floor((Date.now() - presentStartedAt) / 1000);
    timer.textContent = `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`;
  }, 1000);
  setPresentTimerId(tid);

  window.addEventListener('keydown', onKey);
  (wrap.querySelector('#prevP') as HTMLButtonElement).onclick = () => { if (presentIndex > 0) { setPresentIndex(presentIndex - 1); rerender(); } };
  (wrap.querySelector('#nextP') as HTMLButtonElement).onclick = () => { if (presentIndex < getDeck().slides.length - 1) { setPresentIndex(presentIndex + 1); rerender(); } };
  (wrap.querySelector('#exitP') as HTMLButtonElement).onclick = close;
}
