import { createSignal, createEffect } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  selectedPost,
  postContent,
  postLoading,
  showOriginal,
  setShowOriginal,
  screenshotSrc,
  screenshotLoading,
} from './store';
import { takeScreenshot } from './actions';
import { stripImages } from './helpers';
import { CommentSection } from './CommentSection';

export function DetailPanel() {
  // ref 시그널: createEffect가 할당 시점을 추적할 수 있도록 signal로 관리
  const [contentBodyEl, setContentBodyEl] = createSignal<HTMLDivElement | null>(null);

  // postContent() 또는 contentBodyEl()이 변경될 때마다 innerHTML 갱신
  createEffect(() => {
    const el = contentBodyEl();
    if (!el) return;
    const content = postContent();
    el.innerHTML = content ? stripImages(content) : '';
  });

  return html`
    <div class="detail-panel">
      ${() => {
        const post = selectedPost();
        if (!post)
          return html`
            <div class="detail-empty">
              <span class="detail-empty-icon">&#9889;</span>
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
              <span>&#128065; ${post.views}</span>
              <span>&#128077; ${post.recommend}</span>
            </div>
            <div class="detail-actions">
              <button
                class=${() => 'y-btn y-btn-sm ' + (showOriginal() ? 'y-btn-primary' : 'y-btn-ghost')}
                onClick=${() => {
                  const next = !showOriginal();
                  setShowOriginal(next);
                  if (next && !screenshotSrc() && !screenshotLoading()) {
                    takeScreenshot(post);
                  }
                }}
                title="브라우저 스크린셛으로 원본 보기"
              >
                ${() => (showOriginal() ? '📷 원본 보는 중' : '📷 원본 보기')}
              </button>
              <a
                href=${post.url}
                target="_blank"
                rel="noopener noreferrer"
                class="detail-open-link"
              >
                DC에서 보기 &#8599;
              </a>
            </div>
          </div>
          <div class="detail-content">
            ${() => {
              if (showOriginal()) {
                if (screenshotLoading())
                  return html`
                    <div class="loading-center">
                      <span class="y-spinner"></span>
                      <span>원본 페이지 로딩 중... (약 3초 소요)</span>
                    </div>
                  `;
                const src = screenshotSrc();
                if (src)
                  return html`
                    <div class="screenshot-wrap">
                      <div class="screenshot-notice">&#128247; 브라우저 스크린셛</div>
                      <img
                        src=${src}
                        style="width:100%;border-radius:6px;display:block"
                        alt="원본 페이지"
                      />
                    </div>
                  `;
                return html`
                  <div class="loading-center">
                    <span style="color:var(--yaar-text-muted)">스크린셛 실패</span>
                  </div>
                `;
              }
              if (postLoading())
                return html`
                  <div class="loading-center">
                    <span class="y-spinner"></span>
                    <span>내용 불러오는 중...</span>
                  </div>
                `;
              return null;
            }}
            ${() => {
              const hidden = showOriginal() || postLoading();
              return html`
                <div
                  class="post-content-body"
                  style=${hidden ? 'display:none' : ''}
                  ref=${(el: HTMLDivElement) => setContentBodyEl(el)}
                ></div>
              `;
            }}
            ${() => {
              const hidden = showOriginal() || postLoading();
              if (hidden) return null;
              return html`<${CommentSection} />`;
            }}
          </div>
        `;
      }}
    </div>
  `;
}
