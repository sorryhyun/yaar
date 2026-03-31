import html from '@bundled/solid-js/html';
import type { Post } from '../types';

function fmtNum(n: string): string {
  const num = parseInt(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + '만';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

export function PostItem(props: { post: Post; selected: boolean; onClick: () => void }) {
  const isHot = () => parseInt(props.post.recommend) >= 20;

  return html`
    <button
      class=${() => `post-item${props.selected ? ' selected' : ''}${isHot() ? ' hot' : ''}`}
      onclick=${props.onClick}
    >
      <div class="post-title-row">
        ${() => props.post.category ? html`<span class="post-category">${props.post.category}</span>` : null}
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
