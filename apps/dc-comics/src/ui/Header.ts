import html from '@bundled/solid-js/html';
import { state } from '../store';
import { doRefresh, setTab } from '../actions';

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function Header() {
  return html`
    <div class="header">
      <div class="header-title">
        <span class="icon">📚</span>
        <span>만화 갤러리</span>
      </div>

      <div class="tab-bar">
        <button
          class=${() => `tab-btn${state.tabMode === 'all' ? ' active' : ''}`}
          onclick=${() => setTab('all')}
        >전체글</button>
        <button
          class=${() => `tab-btn${state.tabMode === 'recommend' ? ' active' : ''}`}
          onclick=${() => setTab('recommend')}
        >개념글</button>
      </div>

      <div class="header-meta">
        ${() => state.lastUpdated ? html`<span>갱신: ${fmtTime(state.lastUpdated)}</span>` : null}
      </div>

      <div class="header-actions">
        <button
          class="y-btn y-btn-ghost"
          onclick=${() => doRefresh()}
          disabled=${() => state.loading}
          title="새로고침"
        >
          ${() => state.loading ? '⏳' : '🔄'}
        </button>
      </div>
    </div>
  `;
}
