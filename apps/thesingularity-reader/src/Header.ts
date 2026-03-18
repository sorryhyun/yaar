import html from '@bundled/solid-js/html';
import {
  posts, loading, lastUpdated, newPostCount,
  countdown, showRec, setShowRec,
  showSettings, setShowSettings,
  recommendation, recLoading,
} from './store';
import { doRefresh, triggerAnalysis } from './actions';
import { formatCountdown, formatTime } from './helpers';

export function Header() {
  return html`
    <header class="header">
      <div class="header-title">
        <span class="icon">⚡</span>
        <span>특이점이 온다</span>
      </div>
      <div class="header-meta">
        <span>${() => posts().length}원</span>
        ${() =>
          newPostCount() > 0
            ? html`<span class="new-badge">새 글 ${newPostCount()}개</span>`
            : null}
        ${() =>
          lastUpdated()
            ? html`<span>업데이트: ${formatTime(lastUpdated())}</span>`
            : null}
      </div>
      <div class="header-actions">
        <span class="countdown">${() => formatCountdown(countdown())}</span>
        <button
          class=${() => 'y-btn y-btn-sm ' + (showRec() ? 'rec-btn-active' : 'y-btn-ghost')}
          onClick=${() => {
            const willShow = !showRec();
            setShowRec(willShow);
            if (willShow && !recommendation() && !recLoading()) {
              triggerAnalysis();
            }
          }}
          title="AI 추천 분석"
        >
          ${() =>
            recLoading() && !showRec() ? html`<span class="y-spinner"></span>` : '🤖'}
        </button>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => doRefresh()}
          disabled=${loading}
          title="지금 새로고침"
        >
          ${() => (loading() ? html`<span class="y-spinner"></span>` : '🔄')}
        </button>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => setShowSettings(s => !s)}
          title="설정"
        >
          ⚙️
        </button>
      </div>
    </header>
  `;
}
