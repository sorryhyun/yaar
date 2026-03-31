import { createMemo, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import type { Post } from '../types';
import { state, setState, toggleHideSpammer } from '../store';
import { selectPost, doRefresh, goToPage } from '../actions';
import { PostItem } from './PostItem';

export function PostList() {
  // 현재 포스트 목록에서 동적으로 카테고리 추출
  const availableCategories = createMemo(() => {
    const cats = new Set<string>();
    for (const p of state.posts) {
      if (p.category && !p.category.includes('도배기')) {
        cats.add(p.category);
      }
    }
    return Array.from(cats).sort();
  });

  const filteredPosts = createMemo(() => {
    let result = state.posts;
    if (state.hideSpammer) {
      result = result.filter(p => !(p.category && p.category.includes('도배기')));
    }
    const cat = state.selectedCategory;
    if (cat) {
      result = result.filter(p => p.category === cat);
    }
    const kw = state.filterKeyword;
    if (kw) {
      result = result.filter(p => p.title.includes(kw));
    }
    return result;
  });

  return html`
    <div class="post-list-panel">
      ${() => {
        const cats = availableCategories();
        if (cats.length === 0) return null;
        return html`
          <div class="category-tabs">
            <button
              class=${() => 'category-tab' + (state.selectedCategory === null ? ' active' : '')}
              onClick=${() => setState('selectedCategory', null)}
            >전체</button>
            <${For} each=${availableCategories}>${(cat: string) => html`
              <button
                class=${() => 'category-tab' + (state.selectedCategory === cat ? ' active' : '')}
                onClick=${() => setState('selectedCategory', cat)}
              >${cat}</button>
            `}</${For}>
          </div>
        `;
      }}
      <div class="post-list-toolbar">
        <button
          class=${() => 'y-btn y-btn-sm ' + (state.hideSpammer ? 'btn-filter-active' : 'y-btn-ghost')}
          onClick=${() => toggleHideSpammer()}
          title=${() => state.hideSpammer ? '도배기 글 보기' : '도배기 글 숨기기'}
        >
          ${() => state.hideSpammer ? '🚫 도배기 안 보기' : '🟢 도배기 보기'}
        </button>
        ${() => {
          const kw = state.filterKeyword;
          if (!kw) return null;
          return html`
            <span class="filter-chip">
              🔍 ${kw}
              <button class="filter-chip-close" onClick=${() => setState('filterKeyword', null)}>✕</button>
            </span>
          `;
        }}
      </div>
      ${() => {
        if (state.loading && state.posts.length === 0)
          return html`
            <div class="loading-center">
              <span class="y-spinner y-spinner-lg"></span>
              <span>게시물 불러오는 중...</span>
            </div>
          `;
        if (state.error && state.posts.length === 0)
          return html`
            <div class="error-center">
              <span class="error-icon">⚠️</span>
              <div class="error-msg">${() => state.error}</div>
              <button class="y-btn y-btn-primary" onClick=${() => doRefresh()}>다시 시도</button>
            </div>
          `;
        return html`
          <div
            class="post-list-scroll"
            onClick=${(e: MouseEvent) => {
              const el = (e.target as HTMLElement).closest('[data-post-num]') as HTMLElement | null;
              if (!el) return;
              const num = el.dataset.postNum;
              const post = state.posts.find((p: Post) => p.num === num);
              if (post) selectPost(post);
            }}
          >
            <${For} each=${filteredPosts}>${(post: Post) => html`
              <${PostItem} post=${post} />
            `}</${For}>
            ${() =>
              filteredPosts().length === 0 && (state.filterKeyword || state.selectedCategory)
                ? html`
                    <div
                      class="loading-center"
                      style="padding:var(--yaar-sp-4);color:var(--yaar-text-muted);font-size:13px"
                    >
                      검색 결과 없음
                    </div>
                  `
                : null}
          </div>
          <div class="page-nav">
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              onClick=${() => goToPage(state.page - 1)}
              disabled=${() => state.page <= 1 || state.loading}
            >◀ 이전</button>
            <span class="page-indicator">${() => state.page}페이지</span>
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              onClick=${() => goToPage(state.page + 1)}
              disabled=${() => state.loading}
            >다음 ▶</button>
          </div>
        `;
      }}
    </div>
  `;
}
