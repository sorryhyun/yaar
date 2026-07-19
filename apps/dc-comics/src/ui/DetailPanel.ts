import { createSignal, createEffect, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showConfirm } from '@bundled/yaar';
import { state } from '../store';
import { CommentSection } from './CommentSection';
import { subscribeSeries, unsubscribeSeries } from '../actions';
import {
  processImages,
  attachImageErrorFallbacks,
  fetchImageAsBlobUrl,
  replaceWithFailurePlaceholder,
} from '../helpers';
import type { SeriesLink } from '../types';

function fmtNum(n: string): string {
  const num = parseInt(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + '만';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function extractSeriesLinks(htmlStr: string): SeriesLink[] {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlStr, 'text/html');
    const links = Array.from(
      doc.querySelectorAll('a[href*="s_type=series"], a[href*="gall.dcinside.com/board/lists"]'),
    );
    const seen = new Set<string>();
    const result: SeriesLink[] = [];
    for (const a of links) {
      const href =
        (a as HTMLAnchorElement).href || (a as HTMLAnchorElement).getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const title = (a.textContent ?? '').trim() || '시리즈 보기';
      result.push({ title, url: href });
    }
    return result;
  } catch {
    return [];
  }
}

function SubscribeButton(props: { link: SeriesLink }) {
  const [loading, setLoading] = createSignal(false);
  const isSub = () => state.subscriptions.some((s) => s.url === props.link.url);
  const subObj = () => state.subscriptions.find((s) => s.url === props.link.url);

  const handleClick = async (e: Event) => {
    e.stopPropagation();
    if (loading()) return;
    setLoading(true);
    try {
      if (isSub()) {
        const s = subObj();
        if (s && (await showConfirm(`'${s.title}' 구독을 취소하시겠습니까?`, { danger: true }))) {
          await unsubscribeSeries(s.id);
        }
      } else {
        await subscribeSeries(props.link);
      }
    } finally {
      setLoading(false);
    }
  };

  return html`
    <button
      class=${() => (isSub() ? 'subscribe-btn subscribe-btn-active' : 'subscribe-btn')}
      onclick=${handleClick}
      disabled=${loading}
    >
      ${() =>
        loading()
          ? html`<span class="y-spinner" style="width:10px;height:10px"></span>`
          : isSub()
            ? '구독 중 ✓'
            : '+ 구독'}
    </button>
  `;
}

function EmptyState() {
  return html`
    <div class="detail-empty y-flex-col y-items-center y-justify-center">
      <div class="detail-empty-icon">📚</div>
      <p style="color:var(--yaar-text-muted);font-size:13px;margin-top:8px">글을 선택하세요</p>
    </div>
  `;
}

export function DetailPanel() {
  // ref signal so createEffect can track when the body element mounts/remounts.
  const [contentBodyEl, setContentBodyEl] = createSignal<HTMLDivElement | null>(null);

  // Progressive image loader. processImages() marks every image past the first
  // two with class "deferred-img" and stashes the real URL in data-deferred-src.
  // We swap data-deferred-src -> src as each image scrolls into view so
  // image-heavy posts don't decode/paint everything at once.
  let observer: IntersectionObserver | null = null;

  // Blob URLs minted by fetchImageAsBlobUrl. Held so they can be revoked when
  // the body is replaced or the panel unmounts -- an image-heavy comic post
  // would otherwise leak every decoded image for the lifetime of the app.
  const blobUrls = new Set<string>();
  const revokeBlobUrls = () => {
    for (const u of blobUrls) URL.revokeObjectURL(u);
    blobUrls.clear();
  };

  // Fetch through the yaar://http proxy with a dcinside Referer. A direct
  // <img src> is refused by DC's hotlink protection, so the bytes have to come
  // back through the proxy and be rendered from a same-origin blob URL.
  const loadImg = async (img: HTMLImageElement) => {
    const real = img.getAttribute('data-deferred-src');
    img.removeAttribute('data-deferred-src');
    img.classList.remove('deferred-img');
    if (!real) return;
    try {
      const objUrl = await fetchImageAsBlobUrl(real);
      // The body may have been swapped out while this fetch was in flight.
      if (!img.isConnected) {
        URL.revokeObjectURL(objUrl);
        return;
      }
      blobUrls.add(objUrl);
      img.setAttribute('src', objUrl);
    } catch {
      // A proxy failure dispatches no 'error' event (src stays the placeholder),
      // so the fallback has to be applied directly rather than via the listener.
      if (img.isConnected) replaceWithFailurePlaceholder(img);
    }
  };

  const setupLazyImages = (el: HTMLElement) => {
    observer?.disconnect();
    observer = null;
    // Attach the image load-failure fallback. This replaces the generated
    // inline `onerror=` attribute, which DOMPurify now strips. Runs
    // synchronously right after innerHTML assignment, so it is always in place
    // before any error event can be dispatched.
    attachImageErrorFallbacks(el);

    const pending = Array.from(
      el.querySelectorAll('img[data-deferred-src]'),
    ) as HTMLImageElement[];
    // Eager images carry no `deferred-img` class -- fetch them straight away.
    pending.filter((i) => !i.classList.contains('deferred-img')).forEach(loadImg);

    const deferred = pending.filter((i) => i.classList.contains('deferred-img'));
    if (deferred.length === 0) return;

    if (typeof IntersectionObserver === 'undefined') {
      deferred.forEach(loadImg);
      return;
    }

    observer = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          loadImg(entry.target as HTMLImageElement);
          obs.unobserve(entry.target);
        }
      },
      {
        root: el.closest('.detail-content'),
        rootMargin: '600px 0px',
        threshold: 0.01,
      },
    );
    deferred.forEach((img) => observer!.observe(img));
  };

  // Re-render body innerHTML whenever postContent or the mounted element changes.
  createEffect(() => {
    const el = contentBodyEl();
    if (!el) {
      observer?.disconnect();
      observer = null;
      revokeBlobUrls();
      return;
    }
    const content = state.postContent;
    // Drop the previous post's blob URLs before the DOM referencing them goes.
    revokeBlobUrls();
    el.innerHTML = content && !state.postLoading ? processImages(content) : '';
    setupLazyImages(el);
  });

  onCleanup(() => {
    observer?.disconnect();
    observer = null;
    revokeBlobUrls();
  });

  return html`
    <div class="detail-panel">
      ${() =>
        !state.selectedPost
          ? EmptyState()
          : html`
              <div class="detail-header">
                <div class="detail-title">
                  ${() =>
                    state.selectedPost!.category
                      ? html`<span class="post-category" style="margin-right:6px"
                          >${() => state.selectedPost!.category}</span
                        >`
                      : null}
                  ${() => state.selectedPost!.title}
                </div>
                <div class="detail-meta">
                  <span>✍️ ${() => state.selectedPost!.author}</span>
                  <span class="divider">·</span>
                  <span>${() => state.selectedPost!.date}</span>
                  <span class="divider">·</span>
                  <span>👁 ${() => fmtNum(state.selectedPost!.views)}</span>
                  <span>❤ ${() => fmtNum(state.selectedPost!.recommend)}</span>
                  <a
                    class="detail-open-link"
                    href=${() => state.selectedPost!.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >DC에서 보기 ↗</a
                  >
                </div>
              </div>

              <div class="detail-content">
                ${() =>
                  state.postLoading
                    ? html`<div class="loading-center">
                        <div class="y-spinner"></div>
                        <span>불러오는 중...</span>
                      </div>`
                    : null}
                ${() =>
                  state.postError
                    ? html`<div class="error-center">
                        <div class="error-icon">⚠️</div>
                        <div class="error-msg">${() => state.postError}</div>
                      </div>`
                    : null}

                <div
                  class="post-body post-content-body"
                  style=${() => (state.postLoading || state.postError ? 'display:none' : '')}
                  ref=${(el: HTMLDivElement) => setContentBodyEl(el)}
                ></div>

                ${() => {
                  if (state.postLoading || !state.postContent) return null;
                  const links = extractSeriesLinks(state.postContent);
                  return links.length > 0
                    ? html`
                        <div class="series-link-section">
                          <span class="y-label" style="padding:0 12px">시리즈</span>
                          ${links.map(
                            (link) => html`
                              <div class="series-link-row">
                                <a
                                  class="series-link-title"
                                  href=${link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  >${link.title}</a
                                >
                                <${SubscribeButton} link=${link} />
                              </div>
                            `,
                          )}
                        </div>
                      `
                    : null;
                }}

                ${() => (!state.postLoading ? html`<${CommentSection} />` : null)}
              </div>
            `}
    </div>
  `;
}
