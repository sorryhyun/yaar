import { createEffect, createMemo, onCleanup, onMount, Show, For } from '@bundled/solid-js';
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
    // Reset countdown
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

async function selectPost(post: Post) {
  setSelectedPost(post);
  setPostContent(null);
  setPostLoading(true);
  try {
    const content = await fetchPostContent(post);
    setPostContent(content);
  } catch (e: any) {
    setPostContent('<p style="color:var(--yaar-error)">게시물을 불러올 수 없습니다: ' + (e?.message ?? '') + '</p>');
  } finally {
    setPostLoading(false);
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

function PostItem(props: { post: Post; onClick: () => void }) {
  const isSelected = createMemo(() => selectedPost()?.id === props.post.id);
  const isHot = createMemo(() => parseInt(props.post.recommend) >= 10);

  return html`
    <div
      class=${() => ['post-item', isSelected() && 'selected', isHot() && 'hot'].filter(Boolean).join(' ')}
      onClick=${props.onClick}
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

  const PostList = () => html`
    <div class="post-list-panel">
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
          <div class="post-list-scroll">
            <${For} each=${posts}>${(post: Post) => html`
              <${PostItem} post=${post} onClick=${() => selectPost(post)} />
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
              <a href=${post.url} target="_blank" rel="noopener noreferrer" class="detail-open-link">
                DC에서 보기 ↗
              </a>
            </div>
          </div>
          <div class="detail-content">
            ${() => {
              if (postLoading()) return html`
                <div class="loading-center">
                  <span class="y-spinner"></span>
                  <span>내용 불러오는 중...</span>
                </div>
              `;
              const content = postContent();
              if (!content) return null;
              // Render HTML content safely
              const div = document.createElement('div');
              div.innerHTML = content;
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
