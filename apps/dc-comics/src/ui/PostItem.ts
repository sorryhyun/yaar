import { createMemo } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state } from '../store';
import type { Post } from '../types';

function fmtNum(n: string): string {
  const num = parseInt(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + '만';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

// PostItem takes only `post`. Click handling is delegated to the parent
// container in PostList (which reads data-post-num) — passing a handler as a
// component prop makes solid-js/html evaluate the thunk during render
// (auto-opening posts) and mis-bind delegated events.
export function PostItem(props: { post: Post }) {
  const isSelected = createMemo(() => state.selectedPost?.id === props.post.id);
  const isHot = createMemo(() => parseInt(props.post.recommend) >= 20);

  return html`
    <button
      class=${() =>
        `post-item${isSelected() ? ' selected' : ''}${isHot() ? ' hot' : ''}`}
      data-post-num=${props.post.num}
    >
      <div class="post-title-row">
        ${() => props.post.category ? html`<span class="post-category">${() => props.post.category}</span>` : null}
        ${() => props.post.hasImage ? html`<span class="post-img-icon">🖼️</span>` : null}
        <span class="post-title">${() => props.post.title}</span>
      </div>
      <div class="post-meta">
        <span class="post-author">${() => props.post.author}</span>
        <span class="divider">·</span>
        <span class="post-date">${() => props.post.date}</span>
        <span class="post-stats">
          <span class="stat" title="조회">👁 ${() => fmtNum(props.post.views)}</span>
          <span class=${() => `stat${isHot() ? ' recommend-hot' : ''}`} title="추천">❤ ${() => fmtNum(props.post.recommend)}</span>
          ${() => parseInt(props.post.comments) > 0
            ? html`<span class="stat" title="댓글">💬 ${() => props.post.comments}</span>`
            : null}
        </span>
      </div>
    </button>
  `;
}
