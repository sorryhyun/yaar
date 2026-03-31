import html from '@bundled/solid-js/html';
import { state } from '../store';
import { CommentSection } from './CommentSection';

function fmtNum(n: string): string {
  const num = parseInt(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + '만';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function EmptyState() {
  return html`
    <div class="detail-empty y-flex-col y-items-center y-justify-center">
      <div class="detail-empty-icon">📚</div>
      <p style="color:var(--yaar-text-muted);font-size:13px;margin-top:8px">글을 선택하마세요</p>
    </div>
  `;
}

export function DetailPanel() {
  return html`
    <div class="detail-panel">
      ${() => !state.selectedPost ? EmptyState() : html`
        <div class="detail-header">
          <div class="detail-title">
            ${() => state.selectedPost!.category
              ? html`<span class="post-category" style="margin-right:6px">${() => state.selectedPost!.category}</span>`
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
            >DC에서 보기 ↗</a>
          </div>
        </div>

        <div class="detail-content">
          ${() => state.postLoading
            ? html`<div class="loading-center"><div class="y-spinner"></div><span>불러오는 중...</span></div>`
            : null}
          ${() => state.postError
            ? html`<div class="error-center">
                <div class="error-icon">⚠️</div>
                <div class="error-msg">${() => state.postError}</div>
              </div>`
            : null}
          ${() => state.postContent && !state.postLoading
            ? html`<div class="post-body" innerHTML=${() => state.postContent!}></div>`
            : null}

          ${() => !state.postLoading ? html`<${CommentSection} />` : null}
        </div>
      `}
    </div>
  `;
}
