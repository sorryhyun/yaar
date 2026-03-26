import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { doRefresh, triggerAnalysis } from '../actions';
import { formatCountdown, formatTime } from '../helpers';

export function Header() {
  return html`
    <header class="header">
      <div class="header-title">
        <span class="icon">⚡</span>
        <span>특이점이 온다</span>
      </div>
      <div class="header-meta">
        <span>${() => state.posts.length}원</span>
        ${() =>
          state.newPostCount > 0
            ? html`<span class="new-badge">새 글 ${state.newPostCount}개</span>`
            : null}
        ${() =>
          state.lastUpdated
            ? html`<span>업데이트: ${formatTime(state.lastUpdated)}</span>`
            : null}
      </div>
      <div class="header-actions">
        <span class="countdown">${() => formatCountdown(state.countdown)}</span>
        <button
          class=${() => 'y-btn y-btn-sm ' + (state.showRec ? 'rec-btn-active' : 'y-btn-ghost')}
          onClick=${() => {
            const willShow = !state.showRec;
            setState('showRec', willShow);
            if (willShow && !state.recommendation && !state.recLoading) {
              triggerAnalysis();
            }
          }}
          title="AI 추천 분석"
        >
          ${() =>
            state.recLoading && !state.showRec ? html`<span class="y-spinner"></span>` : '🤖'}
        </button>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => doRefresh()}
          disabled=${() => state.loading}
          title="지금 새로고침"
        >
          ${() => (state.loading ? html`<span class="y-spinner"></span>` : '🔄')}
        </button>
        <button
          class=${() => {
            if (state.showLogin) return 'y-btn y-btn-sm rec-btn-active';
            if (state.isLoggedIn) return 'y-btn y-btn-sm login-btn-active';
            if (state.savedCredentials) return 'y-btn y-btn-sm login-btn-saved';
            return 'y-btn y-btn-sm y-btn-ghost';
          }}
          onClick=${() => {
            const next = !state.showLogin;
            setState('showLogin', next);
            if (next) setState('showSettings', false);
          }}
          title=${() => {
            if (state.isLoggedIn) return `로그인: ${state.savedCredentials?.username ?? ''}`;
            if (state.savedCredentials) return `저장된 계정: ${state.savedCredentials.username}`;
            return '로그인';
          }}
        >
          ${() => {
            if (state.loginLoading) return html`<span class="y-spinner"></span>`;
            if (state.isLoggedIn) return '👤';
            if (state.savedCredentials) return '🔓';
            return '🔐';
          }}
        </button>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => {
            const next = !state.showSettings;
            setState('showSettings', next);
            if (next) setState('showLogin', false);
          }}
          title="설정"
        >
          ⚙️
        </button>
      </div>
    </header>
  `;
}
