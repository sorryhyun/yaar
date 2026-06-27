import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { doSearch, clearSearch } from '../actions';
import type { SearchType } from '../types';

const SEARCH_TYPES: { value: SearchType; label: string }[] = [
  { value: 'subject_m', label: '제목+내용' },
  { value: 'subject', label: '제목' },
  { value: 'memo', label: '내용' },
  { value: 'name', label: '글쓴이' },
  { value: 'comment', label: '댓글' },
];

export function SearchBar() {
  return html`
    <div class="search-bar">
      <select
        class="search-type-select"
        value=${() => state.searchType}
        onChange=${(e: Event) =>
          setState('searchType', (e.currentTarget as HTMLSelectElement).value as SearchType)}
        disabled=${() => state.loading}
        title="검색 대상"
      >
        ${SEARCH_TYPES.map(
          (t) => html`<option value=${t.value}>${t.label}</option>`,
        )}
      </select>
      <div class="search-input-wrap">
        <input
          class="y-input search-input"
          type="text"
          placeholder="갤러리 내 검색..."
          value=${() => state.searchKeyword}
          onInput=${(e: Event) =>
            setState('searchKeyword', (e.currentTarget as HTMLInputElement).value)}
          onKeyDown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              doSearch();
            }
          }}
        />
        ${() =>
          state.searchKeyword
            ? html`<button
                class="search-input-clear"
                title="입력 지우기"
                onClick=${() => setState('searchKeyword', '')}
              >✕</button>`
            : null}
      </div>
      <button
        class="y-btn y-btn-sm y-btn-primary search-go-btn"
        onClick=${() => doSearch()}
        disabled=${() => state.loading}
        title="검색"
      >
        ${() => (state.loading && state.searchActive ? html`<span class="y-spinner"></span>` : '🔍')}
      </button>
    </div>
    ${() =>
      state.searchActive
        ? html`
            <div class="search-status">
              <span class="search-status-label"
                >🔍 '${() => state.searchKeyword}' 검색 결과</span
              >
              <button
                class="y-btn y-btn-sm y-btn-ghost search-reset-btn"
                onClick=${() => clearSearch()}
                title="전체 목록으로 복귀"
              >
                ✕ 검색 해제
              </button>
            </div>
          `
        : null}
  `;
}
