import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from '../store';

function CommentItem(props: { comment: any }) {
  const c = props.comment;
  return html`
    <div class=${`comment-item${c.isBest ? ' comment-best' : ''}${c.isReply ? ' comment-reply' : ''}`}>
      <div class="comment-header">
        ${() => c.isBest ? html`<span class="comment-best-badge">BEST</span>` : null}
        ${() => c.isReply ? html`<span class="comment-reply-icon">↳</span>` : null}
        <span class=${`comment-author${c.author === '익명' ? ' comment-author-anon' : ''}`}>${c.author}</span>
        ${() => parseInt(c.recommend) > 0 ? html`<span class="comment-rec">❤ ${c.recommend}</span>` : null}
        <span class="comment-date">${c.date}</span>
      </div>
      <div class="comment-body">
        ${() => c.dcconSrc
          ? html`<img class="comment-dccon" src=${c.dcconSrc} alt="이모티콘" />`
          : html`<span class="comment-text">${c.text}</span>`}
      </div>
    </div>
  `;
}

export function CommentSection() {
  const toggle = () => setState('showComments', !state.showComments);

  return html`
    <div class="comment-section">
      <button
        class=${() => `comment-toggle-btn${state.showComments ? ' active' : ''}`}
        onclick=${toggle}
      >
        <span>댓글 ${() => state.comments.length > 0 ? `(${state.comments.length})` : ''}</span>
        <span class=${() => `comment-toggle-chevron${state.showComments ? ' open' : ''}`}>⌃</span>
      </button>

      ${() => state.showComments
        ? html`
          <div class="comment-list-wrap">
            ${() => state.comments.length === 0
              ? html`<div class="comment-empty">댓글이 없습니다.</div>`
              : null}
            <${For} each=${() => state.comments}>
              ${(c: any) => html`<${CommentItem} comment=${c} />`}
            </${For}>
          </div>`
        : null}
    </div>
  `;
}
