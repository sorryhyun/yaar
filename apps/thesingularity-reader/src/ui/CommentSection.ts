import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { submitComment } from '../actions';
import type { Comment } from '../types';

/** 닉네임 타입 및지 */
function NickBadge(props: { nickType?: Comment['nickType'] }) {
  if (props.nickType === 'sub-gonick') {
    return html`<span class="nick-badge nick-badge-manager" title="운영진/매니저">★</span>`;
  }
  if (props.nickType === 'gonick') {
    return html`<span class="nick-badge nick-badge-gonick" title="고정닉">🔒</span>`;
  }
  return null;
}

function CommentItem(props: { comment: Comment }) {
  const c = props.comment;

  return html`
    <div class=${`comment-item${c.isBest ? ' comment-best' : ''}${c.isReply ? ' comment-reply' : ''}`}>
      <div class="comment-header">
        ${() => c.isBest ? html`<span class="comment-best-badge">BEST</span>` : null}
        ${() => c.isReply ? html`<span class="comment-reply-icon">↳</span>` : null}
        <${NickBadge} nickType=${c.nickType} />
        <span class=${`comment-author${c.nickType === 'sub-gonick' ? ' comment-author-manager' : c.nickType === 'nogonick' ? ' comment-author-anon' : ''}`}>${c.author}</span>
        <span class="comment-date">${c.date}</span>
        ${() => parseInt(c.recommend) > 0 ? html`
          <span class="comment-rec">👍 ${c.recommend}</span>
        ` : null}
      </div>
      <div class="comment-body">
        ${() => c.dcconSrc
          ? html`<img class="comment-dccon" src=${c.dcconSrc} alt="이모티콘" loading="lazy" />`
          : html`<span class="comment-text">${c.text}</span>`
        }
      </div>
    </div>
  `;
}

/** 댓글 작성 폼 (isLoggedIn일 때만 활성화) */
function CommentWriteForm() {
  return html`
    <div class="comment-write-wrap">
      ${() => !state.isLoggedIn ? html`
        <div class="comment-login-prompt">
          <span class="comment-login-icon">🔐</span>
          <span class="comment-login-text">댓글을 작성하려면 로그인이 필요합니다</span>
          <button
            class="y-btn y-btn-sm y-btn-primary"
            onClick=${() => { setState('showLogin', true); setState('showSettings', false); }}
          >로그인</button>
        </div>
      ` : html`
        <div class="comment-write-form">
          <div class="comment-write-user">
            <span class="comment-write-nick">👤 ${() => state.savedCredentials?.username ?? '사용자'}</span>
          </div>
          <textarea
            class="comment-write-textarea"
            placeholder="댓글을 입력하세요..."
            value=${() => state.commentText}
            onInput=${(e: Event) => setState('commentText', (e.target as HTMLTextAreaElement).value)}
            rows="3"
            disabled=${() => state.commentSubmitting}
          ></textarea>
          <div class="comment-write-actions">
            <span class="comment-write-count">${() => state.commentText.length}자</span>
            <button
              class="y-btn y-btn-primary y-btn-sm comment-submit-btn"
              onClick=${submitComment}
              disabled=${() => state.commentSubmitting || !state.commentText.trim()}
            >
              ${() => state.commentSubmitting
                ? html`<span class="y-spinner"></span>`
                : '💬 등록'}
            </button>
          </div>
        </div>
      `}
    </div>
  `;
}

export function CommentSection() {
  const bestComments = () => state.comments.filter(c => c.isBest);
  const regularComments = () => state.comments.filter(c => !c.isBest);
  const totalCount = () => state.comments.length;

  const toggleLabel = () => {
    if (state.commentsLoading) return '💬 댓글 로딩중...';
    const n = totalCount();
    if (state.showComments) return `💬 댓글 접기 (${n})`;
    return `💬 댓글 보기 (${n})`;
  };

  return html`
    <div class="comment-section">
      <button
        class=${() => 'comment-toggle-btn' + (state.showComments ? ' active' : '')}
        onClick=${() => {
          if (!state.commentsLoading) setState('showComments', !state.showComments);
        }}
        disabled=${() => state.commentsLoading}
      >
        <span innerHTML=${toggleLabel}></span>
        <span class=${() => 'comment-toggle-chevron' + (state.showComments ? ' open' : '')}>⏄</span>
      </button>

      ${() => state.showComments ? html`
        <div class="comment-list-wrap">
          ${() => state.commentsLoading ? html`
            <div class="comment-loading">
              <span class="y-spinner"></span>
              <span>댓글을 불러오는 중...</span>
            </div>
          ` : null}

          ${() => !state.commentsLoading && totalCount() === 0 ? html`
            <div class="comment-empty">
              <span>댓글이 없거나 불러올 수 없었습니다.</span>
            </div>
          ` : null}

          ${() => !state.commentsLoading && bestComments().length > 0 ? html`
            <div class="comment-group">
              <div class="comment-group-label">⭐ 베스트 댓글</div>
              <${For} each=${bestComments}>
                ${(c: Comment) => html`<${CommentItem} comment=${c} />`}
              </${For}>
            </div>
          ` : null}

          ${() => !state.commentsLoading && regularComments().length > 0 ? html`
            <div class="comment-group">
              ${() => bestComments().length > 0 ? html`
                <div class="comment-group-label">전체 댓글 (${regularComments().length})</div>
              ` : null}
              <${For} each=${regularComments}>
                ${(c: Comment) => html`<${CommentItem} comment=${c} />`}
              </${For}>
            </div>
          ` : null}

          <${CommentWriteForm} />
        </div>
      ` : null}
    </div>
  `;
}
