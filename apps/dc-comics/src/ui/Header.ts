import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { doRefresh, setTab } from '../actions';
import { formatCountdown, formatTime } from '../helpers';

export function Header() {
  return html`
    <div class="header">
      <div class="header-title">
        <span class="icon">📚</span>
        <span>만화 갤러리</span>
      </div>

      <div class="tab-bar">
        <button
          class=${() =>
            `tab-btn${state.activePanel === 'feed' && state.tabMode === 'all' ? ' active' : ''}`}
          onclick=${() => {
            setState({ activePanel: 'feed' });
            setTab('all');
          }}
        >
          전체글
        </button>
        <button
          class=${() =>
            `tab-btn${state.activePanel === 'feed' && state.tabMode === 'recommend' ? ' active' : ''}`}
          onclick=${() => {
            setState({ activePanel: 'feed' });
            setTab('recommend');
          }}
        >
          개념글
        </button>
        <button
          class=${() => `tab-btn${state.activePanel === 'subscriptions' ? ' active' : ''}`}
          onclick=${() => setState({ activePanel: 'subscriptions' })}
        >
          구독
          ${() => {
            const total = state.subscriptions.reduce((acc, s) => acc + s.unreadCount, 0);
            return total > 0
              ? html`<span class="unread-badge" style="margin-left:4px">${total}</span>`
              : null;
          }}
        </button>
      </div>

      <div class="header-meta">
        ${() =>
          state.newPostCount > 0
            ? html`<span class="new-badge">새 글 ${state.newPostCount}개</span>`
            : null}
        ${() =>
          state.lastUpdated ? html`<span>갱신: ${formatTime(state.lastUpdated)}</span>` : null}
      </div>

      <div class="header-actions">
        <span class="countdown">${() => formatCountdown(state.countdown)}</span>
        <button
          class="y-btn y-btn-ghost"
          onclick=${() => doRefresh()}
          disabled=${() => state.loading}
          title="새로고침"
        >
          ${() => (state.loading ? '⏳' : '🔄')}
        </button>
        <button
          class=${() =>
            'y-btn y-btn-ghost' + (state.showSettings ? ' rec-btn-active' : '')}
          onclick=${() => setState('showSettings', !state.showSettings)}
          title="설정"
        >
          ⚙️
        </button>
      </div>
    </div>
  `;
}
