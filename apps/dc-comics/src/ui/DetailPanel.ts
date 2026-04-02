import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state } from '../store';
import { CommentSection } from './CommentSection';
import { subscribeSeries, unsubscribeSeries } from '../actions';
import type { SeriesLink } from '../types';

function fmtNum(n: string): string {
  const num = parseInt(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + '만';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function extractSeriesLinks(html: string): SeriesLink[] {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const links = Array.from(doc.querySelectorAll('a[href*="s_type=series"], a[href*="gall.dcinside.com/board/lists"]'));
    const seen = new Set<string>();
    const result: SeriesLink[] = [];
    for (const a of links) {
      const href = (a as HTMLAnchorElement).href || (a as HTMLAnchorElement).getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const title = (a.textContent ?? '').trim() || '시리즈 보기';
      result.push({ title, url: href });
    }
    return result;
  } catch {
    return [];
  }
}

function SubscribeButton(props: { link: SeriesLink }) {
  const [loading, setLoading] = createSignal(false);
  const isSub = () => state.subscriptions.some((s) => s.url === props.link.url);
  const subObj = () => state.subscriptions.find((s) => s.url === props.link.url);

  const handleClick = async (e: Event) => {
    e.stopPropagation();
    if (loading()) return;
    setLoading(true);
    try {
      if (isSub()) {
        const s = subObj();
        if (s && confirm(`'${s.title}' 구독을 취소하시겠습니까?`)) {
          await unsubscribeSeries(s.id);
        }
      } else {
        await subscribeSeries(props.link);
      }
    } finally {
      setLoading(false);
    }
  };

  return html`
    <button
      class=${() => isSub() ? 'subscribe-btn subscribe-btn-active' : 'subscribe-btn'}
      onclick=${handleClick}
      disabled=${loading}
    >
      ${() => loading()
        ? html`<span class="y-spinner" style="width:10px;height:10px"></span>`
        : isSub() ? '구독 중 ✓' : '+ 구독'}
    </button>
  `;
}

function EmptyState() {
  return html`
    <div class="detail-empty y-flex-col y-items-center y-justify-center">
      <div class="detail-empty-icon">📚</div>
      <p style="color:var(--yaar-text-muted);font-size:13px;margin-top:8px">글을 선택하마세요</p>
    </div>
  `;
}

export function DetailPanel() {
  return html`
    <div class="detail-panel">
      ${() => !state.selectedPost ? EmptyState() : html`
        <div class="detail-header">
          <div class="detail-title">
            ${() => state.selectedPost!.category
              ? html`<span class="post-category" style="margin-right:6px">${() => state.selectedPost!.category}</span>`
              : null}
            ${() => state.selectedPost!.title}
          </div>
          <div class="detail-meta">
            <span>✍️ ${() => state.selectedPost!.author}</span>
            <span class="divider">·</span>
            <span>${() => state.selectedPost!.date}</span>
            <span class="divider">·</span>
            <span>👁 ${() => fmtNum(state.selectedPost!.views)}</span>
            <span>❤ ${() => fmtNum(state.selectedPost!.recommend)}</span>
            <a
              class="detail-open-link"
              href=${() => state.selectedPost!.url}
              target="_blank"
              rel="noopener noreferrer"
            >DC에서 보기 ↗</a>
          </div>
        </div>

        <div class="detail-content">
          ${() => state.postLoading
            ? html`<div class="loading-center"><div class="y-spinner"></div><span>불러오는 중...</span></div>`
            : null}
          ${() => state.postError
            ? html`<div class="error-center">
                <div class="error-icon">⚠️</div>
                <div class="error-msg">${() => state.postError}</div>
              </div>`
            : null}
          ${() => state.postContent && !state.postLoading
            ? html`
              <div class="post-body" innerHTML=${() => state.postContent!}></div>
              ${() => {
                const links = extractSeriesLinks(state.postContent!);
                return links.length > 0
                  ? html`
                    <div class="series-link-section">
                      <span class="y-label" style="padding:0 12px">시리즈</span>
                      ${links.map((link) => html`
                        <div class="series-link-row">
                          <a class="series-link-title" href=${link.url} target="_blank" rel="noopener noreferrer">${link.title}</a>
                          <${SubscribeButton} link=${link} />
                        </div>
                      `)}
                    </div>`
                  : null;
              }}
            `
            : null}

          ${() => !state.postLoading ? html`<${CommentSection} />` : null}
        </div>
      `}
    </div>
  `;
}
