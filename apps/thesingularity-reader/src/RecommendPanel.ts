import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from './store';
import { selectPost, triggerAnalysis } from './actions';

export function RecommendPanel() {
  return html`
    <div class="rec-panel">
      ${() =>
        state.recLoading
          ? html`
              <div class="rec-loading">
                <span class="y-spinner"></span>
                <span>AI가 게시물 분석 중... (약 5초 소요)</span>
              </div>
            `
          : null}
      ${() => {
        const rec = state.recommendation;
        if (!rec || state.recLoading) return null;

        const bestNum = rec.bestPostNum;
        const best = bestNum ? state.posts.find(p => p.num === bestNum) : null;

        return html`
          <div class="rec-content">
            <div class="rec-section">
              <div class="y-label rec-section-title">🔥 현재 뜨는 주제</div>
              <div
                class="rec-topics"
                onClick=${(e: MouseEvent) => {
                  const el = (e.target as HTMLElement).closest('[data-topic]') as HTMLElement | null;
                  if (el?.dataset.topic) {
                    setState('filterKeyword', el.dataset.topic);
                    setState('showRec', false);
                  }
                }}
              >
                <${For} each=${() => rec.topics}>${(topic: string) => html`
                  <span class="topic-chip" data-topic=${topic}>${topic}</span>
                `}</${For}>
              </div>
            </div>
            ${() =>
              best
                ? html`
                    <div class="rec-section">
                      <div class="y-label rec-section-title">⭐ 오늘의 베스트</div>
                      <div
                        class="best-post-card"
                        onClick=${() => {
                          selectPost(best!);
                          setState('showRec', false);
                        }}
                      >
                        <div class="best-post-title">${best.title}</div>
                        <div class="best-post-reason">${rec.bestPostReason}</div>
                        <div class="best-post-stats">
                          <span>👁 ${best.views}</span>
                          <span>👍 ${best.recommend}</span>
                          ${best.author ? html`<span>${best.author}</span>` : null}
                        </div>
                      </div>
                    </div>
                  `
                : null}
            <div class="rec-footer">
              <span>분석 시각: ${rec.analyzedAt.toLocaleTimeString('ko-KR')}</span>
              <button
                class="y-btn y-btn-sm y-btn-ghost"
                style="font-size:11px;padding:2px 8px"
                onClick=${() => triggerAnalysis()}
              >
                🔄 다시 분석
              </button>
            </div>
          </div>
        `;
      }}
    </div>
  `;
}
