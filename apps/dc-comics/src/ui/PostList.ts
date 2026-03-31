import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state } from '../store';
import { selectPost, setPage } from '../actions';
import { PostItem } from './PostItem';

export function PostList() {
  return html`
    <div class="post-list-panel">
      ${() => state.loading && state.posts.length === 0
        ? html`<div class="loading-center"><div class="y-spinner"></div><span>로딩 중...</span></div>`
        : null}

      ${() => !state.loading && state.error
        ? html`
          <div class="error-center">
            <div class="error-icon">⚠️</div>
            <div class="error-msg">${() => state.error}</div>
            <button class="y-btn y-btn-primary" onclick=${() => { /* doRefresh handled elsewhere */ }}>다시 시도</button>
          </div>`
        : null}

      ${() => !state.loading || state.posts.length > 0
        ? html`
          <div class="post-list-scroll">
            <${For} each=${() => state.posts}>
              ${(post: any) => html`
                <${PostItem}
                  post=${post}
                  selected=${() => state.selectedPost?.id === post.id}
                  onClick=${() => selectPost(post)}
                />`}
            </${For}>
            ${() => state.posts.length === 0 && !state.loading
              ? html`<div class="empty-state">
                  <div class="empty-icon">📬</div>
                  <div class="empty-msg">글이 없습니다</div>
                </div>`
              : null}
          </div>
          <div class="page-nav">
            <button
              class="y-btn y-btn-ghost"
              disabled=${() => state.page <= 1}
              onclick=${() => setPage(state.page - 1)}
            >‹ 이전</button>
            <span class="page-indicator">${() => state.page} 페이지</span>
            <button
              class="y-btn y-btn-ghost"
              onclick=${() => setPage(state.page + 1)}
            >다음 ›</button>
          </div>`
        : null}
    </div>
  `;
}
