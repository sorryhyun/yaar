import { createMemo } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import type { Post } from './types';
import { selectedPost } from './store';

export function PostItem(props: { post: Post }) {
  const isSelected = createMemo(() => selectedPost()?.id === props.post.id);
  const isHot = createMemo(() => parseInt(props.post.recommend) >= 10);

  return html`
    <div
      class=${() => ['post-item', isSelected() && 'selected', isHot() && 'hot'].filter(Boolean).join(' ')}
      data-post-num=${props.post.num}
    >
      <div class="post-title-row">
        <span class="post-num">${props.post.num}</span>
        ${() => props.post.category ? html`<span class="post-category">${props.post.category}</span>` : null}
        <span class="post-title">${props.post.title}</span>
      </div>
      <div class="post-meta">
        <span class="post-author">${props.post.author}</span>
        <span class="divider">·</span>
        <span class="post-date">${props.post.date}</span>
        <div class="post-stats">
          <span class="stat">
            <span class="stat-icon">👁</span>
            <span>${props.post.views}</span>
          </span>
          <span class=${() => 'stat' + (isHot() ? ' recommend-hot' : '')}>
            <span class="stat-icon">👍</span>
            <span>${props.post.recommend}</span>
          </span>
        </div>
      </div>
    </div>
  `;
}
