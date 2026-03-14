import { createEffect, createMemo, onCleanup, onMount, Show, For, batch } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import type { Post } from './types';
import {
  posts, setPosts, loading, setLoading, error, setError,
  lastUpdated, newPostCount, settings, selectedPost, setSelectedPost,
  postContent, setPostContent, postLoading, setPostLoading,
  countdown, setCountdown, showSettings, setShowSettings,
  loadSettings, saveSettings, updatePosts,
  showOriginal, setShowOriginal,
  screenshotSrc, setScreenshotSrc,
  screenshotLoading, setScreenshotLoading,
  hideSpammer, toggleHideSpammer,
} from './store';
import { fetchPosts, fetchPostContent } from './fetcher';

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

async function doRefresh() {
  if (loading()) return;
  setLoading(true);
  setError(null);
  try {
    const newPosts = await fetchPosts();
    updatePosts(newPosts);
    setCountdown(settings().refreshInterval);
  } catch (e: any) {
    setError(e?.message ?? '불러오기 실패');
  } finally {
    setLoading(false);
  }
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  const interval = settings().refreshInterval;
  setCountdown(interval);

  refreshTimer = setInterval(() => {
    doRefresh();
  }, interval * 1000);

  countdownTimer = setInterval(() => {
    setCountdown(c => {
      if (c <= 1) return settings().refreshInterval;
      return c - 1;
    });
  }, 1000);
}

let fetchVersion = 0;

async function selectPost(post: Post) {
  if (selectedPost()?.id === post.id && postContent()) return;

  const version = ++fetchVersion;
  batch(() => {
    setSelectedPost(post);
    setPostContent(null);
    setPostLoading(true);
    setShowOriginal(false);
    setScreenshotSrc(null);
    setScreenshotLoading(false);
  });
  try {
    const content = await fetchPostContent(post);
    if (version !== fetchVersion) return;
    setPostContent(content);
  } catch (e: any) {
    if (version !== fetchVersion) return;
    setPostContent('<p style="color:var(--yaar-error)">게시물을 불러올 수 없습니다: ' + (e?.message ?? '') + '</p>');
  } finally {
    if (version === fetchVersion) setPostLoading(false);
  }
}

/** HTML 콘텐츠에서 img를 제거하고 텍스트만 반환 */
function stripImages(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('img').forEach(img => {
    // 이미지 자리에 [이미지] 플레이스홀더 표시
    const placeholder = document.createElement('span');
    placeholder.textContent = '[이미지]';
    placeholder.style.cssText = 'display:inline-block;padding:2px 6px;background:var(--yaar-surface-2,#2a2a2a);border-radius:4px;font-size:0.8em;color:var(--yaar-text-2,#888);margin:2px';
    img.replaceWith(placeholder);
  });
  return div.innerHTML;
}

/** DCinside PC URL → 모바일 URL 변환 */
function toMobileUrl(url: string): string {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id');
    const no = u.searchParams.get('no');
    if (id && no) return `https://m.dcinside.com/board/${id}/${no}`;
  } catch {}
  return url;
}

/** 브라우저 탭으로 포스트 URL 스크린샷 찍기 */
async function takeScreenshot(post: Post) {
  batch(() => {
    setScreenshotLoading(true);
    setScreenshotSrc(null);
  });
  try {
    const tabId = 'singularity-screenshot';
    // 탭에 모바일 URL 열기
    const mobileUrl = toMobileUrl(post.url);
    await window.yaar.invoke('yaar://browser/' + tabId, { action: 'open', url: mobileUrl, visible: false });
    // 페이지 로드 대기
    await new Promise<void>(r => setTimeout(r, 2500));
    // 스크린샷 찍기
    const result = await window.yaar.invoke('yaar://browser/' + tabId, { action: 'screenshot' });
    const contents: any[] = result?.content ?? [];
    // image 타입 항목을 우선 탐색
    const imageItem = contents.find((i: any) => i?.type === 'image');
    if (imageItem) {
      setScreenshotSrc(`data:${imageItem.mimeType ?? 'image/png'};base64,${imageItem.data}`);
    } else {
      // base64 데이터가 text 타입으로 오는 경우 (실제 base64인지 확인)
      const textItem = contents.find((i: any) => i?.type === 'text' && /^[A-Za-z0-9+/]{20}/.test(i.text ?? ''));
      if (textItem) {
        setScreenshotSrc(`data:image/png;base64,${textItem.text}`);
      }
    }
  } catch (e: any) {
    console.error('Screenshot failed:', e);
  } finally {
    setScreenshotLoading(false);
  }
}

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

function formatTime(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function PostItem(props: { post: Post }) {
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

function SettingsPanel() {
  const intervals = [
    { label: '1분', value: 60 },
    { label: '5분', value: 300 },
    { label: '10분', value: 600 },
    { label: '30분', value: 1800 },
  ];

  return html`
    <div class="settings-overlay">
      <div class="settings-title">⚙️ 설정</div>
      <div class="settings-row">
        <span>새로고침 간격</span>
        <select
          class="settings-select"
          value=${() => settings().refreshInterval}
          onChange=${(e: Event) => {
            const val = parseInt((e.target as HTMLSelectElement).value);
            saveSettings({ ...settings(), refreshInterval: val });
            startRefreshTimer();
          }}
        >
          ${() => intervals.map(opt => html`
            <option value=${opt.value} selected=${() => settings().refreshInterval === opt.value}>
              ${opt.label}
            </option>
          `)}
        </select>
      </div>
    </div>
  `;
}

function App() {
  onMount(async () => {
    await loadSettings();
    await doRefresh();
    startRefreshTimer();
  });

  onCleanup(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (countdownTimer) clearInterval(countdownTimer);
  });

  const Header = () => html`
    <header class="header">
      <div class="header-title">
        <span class="icon">⚡</span>
        <span>특이점이 온다</span>
      </div>
      <div class="header-meta">
        <span>${() => posts().length}원</span>
        ${() => newPostCount() > 0 ? html`<span class="new-badge">새 글 ${newPostCount()}개</span>` : null}
        ${() => lastUpdated() ? html`<span>업데이트: ${formatTime(lastUpdated())}</span>` : null}
      </div>
      <div class="header-actions">
        <span class="countdown">${() => formatCountdown(countdown())}</span>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => doRefresh()}
          disabled=${loading}
          title="지금 새로고침"
        >
          ${() => loading() ? html`<span class="y-spinner"></span>` : '🔄'}
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

  // 도배기 필터링: category가 '도배기'인 포스트 숨김
  const filteredPosts = createMemo(() => {
    if (!hideSpammer()) return posts();
    return posts().filter(p => !(p.category && p.category.includes('도배기')));
  });

  const PostList = () => html`
    <div class="post-list-panel">
      <div class="post-list-toolbar">
        <button
          class=${() => 'y-btn y-btn-sm ' + (hideSpammer() ? 'btn-filter-active' : 'y-btn-ghost')}
          onClick=${() => toggleHideSpammer()}
          title=${() => hideSpammer() ? '도배기 글 보기' : '도배기 글 숨기기'}
        >
          ${() => hideSpammer() ? '🚫 도배기 안 보기' : '🟢 도배기 보기'}
        </button>
      </div>
      ${() => {
        if (loading() && posts().length === 0) return html`
          <div class="loading-center">
            <span class="y-spinner y-spinner-lg"></span>
            <span>게시물 불러오는 중...</span>
          </div>
        `;
        if (error() && posts().length === 0) return html`
          <div class="error-center">
            <span class="error-icon">⚠️</span>
            <div class="error-msg">${error()}</div>
            <button class="y-btn y-btn-primary" onClick=${() => doRefresh()}>다시 시도</button>
          </div>
        `;
        return html`
          <div class="post-list-scroll" onClick=${(e: MouseEvent) => {
            const el = (e.target as HTMLElement).closest('[data-post-num]') as HTMLElement | null;
            if (!el) return;
            const num = el.dataset.postNum;
            const post = posts().find(p => p.num === num);
            if (post) selectPost(post);
          }}>
            <${For} each=${filteredPosts}>${(post: Post) => html`
              <${PostItem} post=${post} />
            `}</${For}>
          </div>
        `;
      }}
    </div>
  `;

  const DetailPanel = () => html`
    <div class="detail-panel">
      ${() => {
        const post = selectedPost();
        if (!post) return html`
          <div class="detail-empty">
            <span class="detail-empty-icon">⚡</span>
            <span class="y-text-sm">게시물을 선택하세요</span>
          </div>
        `;
        return html`
          <div class="detail-header">
            <div class="detail-title">${post.title}</div>
            <div class="detail-meta">
              <span>${post.author}</span>
              <span class="divider">·</span>
              <span>${post.date}</span>
              <span class="divider">·</span>
              <span>👁 ${post.views}</span>
              <span>👍 ${post.recommend}</span>
            </div>
            <div class="detail-actions">
              <button
                class=${() => 'y-btn y-btn-sm ' + (showOriginal() ? 'y-btn-primary' : 'y-btn-ghost')}
                onClick=${() => {
                  const next = !showOriginal();
                  setShowOriginal(next);
                  if (next && !screenshotSrc() && !screenshotLoading()) {
                    takeScreenshot(post);
                  }
                }}
                title="브라우저 스크린샷으로 원본 보기"
              >
                ${() => showOriginal() ? '📷 원본 보는 중' : '📷 원본 보기'}
              </button>
              <a href=${post.url} target="_blank" rel="noopener noreferrer" class="detail-open-link">
                DC에서 보기 ↗
              </a>
            </div>
          </div>
          <div class="detail-content">
            ${() => {
              // 원본 보기 모드
              if (showOriginal()) {
                if (screenshotLoading()) return html`
                  <div class="loading-center">
                    <span class="y-spinner"></span>
                    <span>원본 페이지 로딩 중... (약 3초 소요)</span>
                  </div>
                `;
                const src = screenshotSrc();
                if (src) return html`
                  <div class="screenshot-wrap">
                    <div class="screenshot-notice">📷 브라우저 스크린샷</div>
                    <img src=${src} style="width:100%;border-radius:6px;display:block" alt="원본 페이지" />
                  </div>
                `;
                return html`<div class="loading-center"><span style="color:var(--yaar-text-2)">스크린샷 실패</span></div>`;
              }

              // 텍스트 보기 모드 (이미지 제거)
              if (postLoading()) return html`
                <div class="loading-center">
                  <span class="y-spinner"></span>
                  <span>내용 불러오는 중...</span>
                </div>
              `;
              const content = postContent();
              if (!content) return null;
              const div = document.createElement('div');
              div.innerHTML = stripImages(content);
              return div;
            }}
          </div>
        `;
      }}
    </div>
  `;

  return html`
    <div id="app-root" style="position: relative; display: contents">
      <${Header} />
      ${() => showSettings() ? html`<${SettingsPanel} />` : null}
      <div class="main-layout">
        <${PostList} />
        <${DetailPanel} />
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);
