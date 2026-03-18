import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { comments, commentsLoading, showComments, setShowComments } from './store';
import type { Comment } from './types';

function CommentItem(props: { comment: Comment }) {
  const c = props.comment;
  return html`
    <div class=${`comment-item${c.isBest ? ' comment-best' : ''}${c.isReply ? ' comment-reply' : ''}`}>
      <div class="comment-header">
        ${() => c.isBest ? html`<span class="comment-best-badge">BEST</span>` : null}
        ${() => c.isReply ? html`<span class="comment-reply-icon">&#x21B3;</span>` : null}
        <span class="comment-author">${c.author}</span>
        <span class="comment-date">${c.date}</span>
        ${() => parseInt(c.recommend) > 0 ? html`
          <span class="comment-rec">&#128077; ${c.recommend}</span>
        ` : null}
      </div>
      <div class="comment-text">${c.text}</div>
    </div>
  `;
}

export function CommentSection() {
  const bestComments = () => comments().filter(c => c.isBest);
  const regularComments = () => comments().filter(c => !c.isBest);
  const totalCount = () => comments().length;

  const toggleLabel = () => {
    if (commentsLoading()) return '&#128172; 댓글 로딩중...';
    const n = totalCount();
    if (showComments()) return `&#128172; 댓글 접기 (${n})`;
    return `&#128172; 댓글 보기 (${n})`;
  };

  return html`
    <div class="comment-section">
      <button
        class=${() => 'comment-toggle-btn' + (showComments() ? ' active' : '')}
        onClick=${() => {
          if (!commentsLoading()) setShowComments(!showComments());
        }}
        disabled=${() => commentsLoading()}
      >
        <span innerHTML=${toggleLabel}></span>
        <span class=${() => 'comment-toggle-chevron' + (showComments() ? ' open' : '')}>&#8964;</span>
      </button>

      ${() => showComments() ? html`
        <div class="comment-list-wrap">
          ${() => commentsLoading() ? html`
            <div class="comment-loading">
              <span class="y-spinner"></span>
              <span>댓글을 불러오는 중...</span>
            </div>
          ` : null}

          ${() => !commentsLoading() && totalCount() === 0 ? html`
            <div class="comment-empty">
              <span>댓글이 없거나 불러올 수 없었습니다.</span>
            </div>
          ` : null}

          ${() => !commentsLoading() && bestComments().length > 0 ? html`
            <div class="comment-group">
              <div class="comment-group-label">&#11088; 베스트 댓글</div>
              <${For} each=${bestComments}>
                ${(c: Comment) => html`<${CommentItem} comment=${c} />`}
              </${For}>
            </div>
          ` : null}

          ${() => !commentsLoading() && regularComments().length > 0 ? html`
            <div class="comment-group">
              ${() => bestComments().length > 0 ? html`
                <div class="comment-group-label">전체 댓글 (${regularComments().length})</div>
              ` : null}
              <${For} each=${regularComments}>
                ${(c: Comment) => html`<${CommentItem} comment=${c} />`}
              </${For}>
            </div>
          ` : null}
        </div>
      ` : null}
    </div>
  `;
}
