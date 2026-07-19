import { createSignal, createEffect, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { takeScreenshot } from '../actions';
import { processImages, attachImageErrorFallbacks } from '../helpers';
import { CommentSection } from './CommentSection';

export function DetailPanel() {
  // ref 시그널: createEffect가 할당 시점을 추적할 수 있도록 signal로 관리
  const [contentBodyEl, setContentBodyEl] = createSignal<HTMLDivElement | null>(null);

  // Progressive image loader. processImages() marks every image past the first
  // two with class "deferred-img" and stashes the real URL in data-deferred-src.
  // Here we swap data-deferred-src -> src as each image scrolls into view so
  // image-heavy posts don't decode/paint everything at once.
  let observer: IntersectionObserver | null = null;

  const loadImg = (img: HTMLImageElement) => {
    const real = img.getAttribute('data-deferred-src');
    if (real) img.setAttribute('src', real);
    img.removeAttribute('data-deferred-src');
    img.classList.remove('deferred-img');
  };

  const setupLazyImages = (el: HTMLElement) => {
    observer?.disconnect();
    observer = null;
    // Attach the image load-failure fallback. This replaces the generated
    // inline `onerror=` attribute, which DOMPurify now strips. Runs
    // synchronously right after innerHTML assignment, so it is always in place
    // before any error event can be dispatched.
    attachImageErrorFallbacks(el);
    const deferred = Array.from(
      el.querySelectorAll('img.deferred-img'),
    ) as HTMLImageElement[];
    if (deferred.length === 0) return;

    // Fallback: no IntersectionObserver support -> load everything.
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
        // The scroll container is .detail-content; preload a screen ahead so
        // the next image is ready by the time the user reaches it.
        root: el.closest('.detail-content'),
        rootMargin: '600px 0px',
        threshold: 0.01,
      },
    );
    deferred.forEach((img) => observer!.observe(img));
  };

  // postContent 또는 contentBodyEl()이 변경될 때마다 innerHTML 갱신
  createEffect(() => {
    const el = contentBodyEl();
    if (!el) {
      observer?.disconnect();
      observer = null;
      return;
    }
    const content = state.postContent;
    el.innerHTML = content ? processImages(content) : '';
    setupLazyImages(el);
  });

  onCleanup(() => {
    observer?.disconnect();
    observer = null;
  });

  return html`
    <div class="detail-panel">
      ${() => {
        const post = state.selectedPost;
        if (!post)
          return html`
            <div class="y-empty detail-empty">
              <span class="y-empty-icon detail-empty-icon">⚡</span>
              <span class="y-text-sm">게시물을 선택하세요</span>
            </div>
          `;

        return html`
          <div class="detail-header">
            <div class="detail-title">${post.title}</div>
            <div class="detail-meta">
              <span>${post.author}</span>
              <span class="divider">&middot;</span>
              <span>${post.date}</span>
              <span class="divider">&middot;</span>
              <span>👁 ${post.views}</span>
              <span>👍 ${post.recommend}</span>
            </div>
            <div class="detail-actions">
              <button
                class=${() => 'y-btn y-btn-sm ' + (state.showOriginal ? 'y-btn-primary' : 'y-btn-ghost')}
                onClick=${() => {
                  const next = !state.showOriginal;
                  setState('showOriginal', next);
                  if (next && !state.screenshotSrc && !state.screenshotLoading) {
                    takeScreenshot(post);
                  }
                }}
                title="브라우저 스크린쌏으로 원본 보기"
              >
                ${() => (state.showOriginal ? '📷 원본 보는 중' : '📷 원본 보기')}
              </button>
              <a
                href=${post.url}
                target="_blank"
                rel="noopener noreferrer"
                class="detail-open-link"
              >
                DC에서 보기 ↗
              </a>
            </div>
          </div>
          <div class="detail-content">
            ${() => {
              if (state.showOriginal) {
                if (state.screenshotLoading)
                  return html`
                    <div class="loading-center">
                      <span class="y-spinner"></span>
                      <span>원본 페이지 로딩 중... (약 3초 소요)</span>
                    </div>
                  `;
                const src = state.screenshotSrc;
                if (src)
                  return html`
                    <div class="screenshot-wrap">
                      <div class="screenshot-notice">📷 브라우저 스크린쌏</div>
                      <img
                        src=${src}
                        style="width:100%;border-radius:6px;display:block"
                        alt="원본 페이지"
                      />
                    </div>
                  `;
                return html`
                  <div class="loading-center">
                    <span style="color:var(--yaar-text-muted)">스크린쌏 실패</span>
                  </div>
                `;
              }
              if (state.postLoading)
                return html`
                  <div class="loading-center">
                    <span class="y-spinner"></span>
                    <span>내용 불러오는 중...</span>
                  </div>
                `;
              return null;
            }}
            ${() => {
              const hidden = state.showOriginal || state.postLoading;
              return html`
                <div
                  class="post-content-body"
                  style=${hidden ? 'display:none' : ''}
                  ref=${(el: HTMLDivElement) => setContentBodyEl(el)}
                ></div>
              `;
            }}
            ${() => {
              const hidden = state.showOriginal || state.postLoading;
              if (hidden) return null;
              return html`<${CommentSection} />`;
            }}
          </div>
        `;
      }}
    </div>
  `;
}
