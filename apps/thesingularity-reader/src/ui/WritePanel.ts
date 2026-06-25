import { createMemo } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { submitPost } from '../actions';

const MAX_TITLE = 100;

export function WritePanel() {
  // Categories (말머리) inferred from the current feed, minus the spammer flair.
  const categories = createMemo(() => {
    const cats = new Set<string>();
    for (const p of state.posts) {
      if (p.category && !p.category.includes('도배기')) cats.add(p.category);
    }
    return Array.from(cats).sort();
  });

  const canSubmit = () =>
    !state.writeSubmitting &&
    state.writeTitle.trim().length > 0 &&
    state.writeContent.trim().length > 0;

  const close = () => {
    if (state.writeSubmitting) return;
    setState('showWrite', false);
  };

  return html`
    <div class="login-overlay write-overlay">
      <div class="login-header">
        <span class="login-title">✏️ 새 게시물 작성</span>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${close}
          disabled=${() => state.writeSubmitting}
          title="닫기"
        >✕</button>
      </div>

      ${() => !state.isLoggedIn
        ? html`
          <div class="login-status-bar login-status-none">
            <span class="login-status-icon">🔒</span>
            <span>로그인이 필요합니다</span>
          </div>
        `
        : html`
          <div class="login-status-bar login-status-ok">
            <span class="login-status-icon">✅</span>
            <div class="login-status-info">
              <span class="login-status-user">${() => state.savedCredentials?.username ?? '나'}</span>
              <span class="login-status-label">님으로 작성</span>
            </div>
          </div>
        `}

      <div class="login-form write-form">
        ${() => {
          const cats = categories();
          if (cats.length === 0) return null;
          return html`
            <div class="login-field">
              <label class="login-label">말머리 (선택)</label>
              <div class="write-cat-tabs">
                <button
                  class=${() => 'category-tab' + (state.writeCategory === null ? ' active' : '')}
                  onClick=${() => setState('writeCategory', null)}
                  disabled=${() => state.writeSubmitting}
                  type="button"
                >일반</button>
                ${cats.map((cat) => html`
                  <button
                    class=${() => 'category-tab' + (state.writeCategory === cat ? ' active' : '')}
                    onClick=${() => setState('writeCategory', cat)}
                    disabled=${() => state.writeSubmitting}
                    type="button"
                  >${cat}</button>
                `)}
              </div>
            </div>
          `;
        }}

        <div class="login-field">
          <label class="login-label">제목</label>
          <input
            class="y-input login-input"
            type="text"
            placeholder="제목을 입력하세요"
            maxlength=${MAX_TITLE}
            value=${() => state.writeTitle}
            onInput=${(e: Event) => setState('writeTitle', (e.currentTarget as HTMLInputElement).value)}
            disabled=${() => state.writeSubmitting}
          />
        </div>

        <div class="login-field">
          <label class="login-label">본문</label>
          <textarea
            class="y-input login-input write-content-textarea"
            placeholder="본문을 입력하세요... (Ctrl+Enter로 등록)"
            value=${() => state.writeContent}
            onInput=${(e: Event) => setState('writeContent', (e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (canSubmit()) submitPost();
              }
            }}
            disabled=${() => state.writeSubmitting}
          ></textarea>
        </div>

        <div class="login-actions">
          <button
            class="y-btn y-btn-primary"
            onClick=${() => { if (canSubmit()) submitPost(); }}
            disabled=${() => !canSubmit()}
          >
            ${() => state.writeSubmitting
              ? html`<span class="y-spinner"></span><span>등록 중…</span>`
              : '✏️ 등록'}
          </button>
          <button
            class="y-btn y-btn-sm y-btn-ghost"
            onClick=${close}
            disabled=${() => state.writeSubmitting}
          >취소</button>
        </div>
      </div>

      <div class="login-how">
        <div class="login-how-title">ℹ️ 안내</div>
        <ul class="login-how-list">
          <li>로그인 세션으로 DC 모바일 글쓰기 폼을 열어 등록합니다</li>
          <li>등록 성공 시 폼이 닫히고 목록이 새로고침됩니다</li>
          <li>과도한 연속 등록은 DC에서 차단될 수 있습니다</li>
        </ul>
      </div>
    </div>
  `;
}
