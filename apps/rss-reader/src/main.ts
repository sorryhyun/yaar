// RSS Reader App — main entry point

import { store } from './store';
import { loadState, saveState } from './storage';
import { fetchAllFeeds, fetchSingleFeed } from './fetcher';
import { injectStyles } from './styles';
import {
  setRendererCallbacks,
  renderSidebar,
  renderArticleList,
  renderArticleView,
  getCurrentArticles,
  getTotalUnread,
  showToast,
} from './renderer';
import { registerAppProtocol, notifyUnreadUpdate } from './protocol';
import { generateFeedId, extractDomainName } from './utils';
import { Article } from './types';

// ---- Layout Min Widths ----
const MIN_SIDEBAR = 160;
const MIN_ARTICLE_LIST = 220;
const MIN_CONTENT = 300;

// ---- Storage keys for panel widths ----
const LS_SIDEBAR_W = 'rss-sidebar-width';
const LS_ARTICLE_W = 'rss-article-width';

// ---- Build Layout ----
function buildLayout() {
  const savedSidebarW = parseInt(localStorage.getItem(LS_SIDEBAR_W) || '240', 10);
  const savedArticleW = parseInt(localStorage.getItem(LS_ARTICLE_W) || '320', 10);

  document.body.innerHTML = `
    <div class="app-container">
      <aside id="sidebar" class="sidebar" style="width:${savedSidebarW}px"></aside>
      <div class="divider" id="divider-left"></div>
      <div class="main-panel">
        <div class="panel-header" id="panel-header">
          <span id="panel-title">All Feeds</span>
          <button class="mark-all-read-btn" id="mark-all-read-btn">Mark all read</button>
        </div>
        <div class="panel-body">
          <div class="article-list-wrap" style="width:${savedArticleW}px">
            <div id="article-list" class="article-list"></div>
          </div>
          <div class="divider" id="divider-right"></div>
          <div id="content-area" class="content-area"></div>
        </div>
      </div>
    </div>
  `;

  // Mark all read button
  document.getElementById('mark-all-read-btn')?.addEventListener('click', () => {
    const current = getCurrentArticles();
    current.forEach(a => {
      if (!store.readArticleIds.includes(a.id)) {
        store.readArticleIds.push(a.id);
      }
    });
    if (store.selectedFeedId === 'all') {
      Object.keys(store.unreadCounts).forEach(k => store.unreadCounts[k] = 0);
    } else if (store.selectedFeedId) {
      store.unreadCounts[store.selectedFeedId] = 0;
    }
    saveState();
    renderSidebar();
    renderArticleList();
  });

  // Panel title observer
  const observer = new MutationObserver(() => {
    const title = document.getElementById('panel-title');
    if (title) {
      title.textContent = store.selectedFeedId === 'all'
        ? 'All Feeds'
        : store.feeds.find(f => f.id === store.selectedFeedId)?.name || 'Feed';
    }
  });
  observer.observe(document.getElementById('sidebar')!, { childList: true, subtree: true });

  // Draggable dividers
  setupDivider('divider-left', 'sidebar', LS_SIDEBAR_W, MIN_SIDEBAR);
  setupDividerRight();
}

// ---- Draggable Divider: left (sidebar) ----
function setupDivider(dividerId: string, targetId: string, lsKey: string, minW: number) {
  const divider = document.getElementById(dividerId);
  const target = document.getElementById(targetId);
  if (!divider || !target) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = target.getBoundingClientRect().width;
    divider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(minW, startW + delta);
    (target as HTMLElement).style.width = `${newW}px`;
    localStorage.setItem(lsKey, String(newW));
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
}

// ---- Draggable Divider: right (article list) ----
function setupDividerRight() {
  const divider = document.getElementById('divider-right');
  const articleWrap = document.querySelector('.article-list-wrap') as HTMLElement | null;
  if (!divider || !articleWrap) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = articleWrap.getBoundingClientRect().width;
    divider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(MIN_ARTICLE_LIST, startW + delta);
    // Also enforce min content area
    const container = document.querySelector('.panel-body') as HTMLElement;
    if (container) {
      const available = container.getBoundingClientRect().width;
      const dividerW = 4;
      if (available - newW - dividerW < MIN_CONTENT) return;
    }
    articleWrap.style.width = `${newW}px`;
    localStorage.setItem(LS_ARTICLE_W, String(newW));
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
}

// ---- Actions ----
function selectFeed(feedId: string) {
  store.selectedFeedId = feedId;
  store.selectedArticle = null;
  renderSidebar();
  renderArticleList();
  renderArticleView();
}

function openArticle(article: Article) {
  store.selectedArticle = article;
  if (!store.readArticleIds.includes(article.id)) {
    store.readArticleIds.push(article.id);
    if ((store.unreadCounts[article.feedId] || 0) > 0) {
      store.unreadCounts[article.feedId]--;
    }
    saveState();
    renderSidebar();
  }
  renderArticleList();
  renderArticleView();
}

function removeFeed(feedId: string) {
  store.feeds = store.feeds.filter(f => f.id !== feedId);
  delete store.articles[feedId];
  delete store.unreadCounts[feedId];
  delete store.errorFeeds[feedId];
  if (store.selectedFeedId === feedId) {
    store.selectedFeedId = 'all';
    store.selectedArticle = null;
  }
  saveState();
  renderSidebar();
  renderArticleList();
  renderArticleView();
}

async function handleAddFeed(url?: string, name?: string): Promise<string> {
  const urlInput = document.getElementById('feed-url-input') as HTMLInputElement | null;
  const nameInput = document.getElementById('feed-name-input') as HTMLInputElement | null;
  const feedUrl = url || urlInput?.value.trim() || '';
  const feedName = name || nameInput?.value.trim() || '';

  if (!feedUrl) throw new Error('No URL provided');

  try {
    new URL(feedUrl);
  } catch {
    showToast('Please enter a valid URL', 'error');
    throw new Error('Invalid URL');
  }

  const id = generateFeedId();
  const resolvedName = feedName || extractDomainName(feedUrl);
  const newFeed = { id, name: resolvedName, url: feedUrl };

  store.feeds.push(newFeed);
  saveState();

  if (urlInput) urlInput.value = '';
  if (nameInput) nameInput.value = '';

  renderSidebar();
  await fetchSingleFeed(newFeed);
  selectFeed(id);

  return id;
}

// ---- Init ----
async function init() {
  document.title = 'RSS Reader';
  injectStyles();
  await loadState();

  // Wire renderer callbacks before building layout
  setRendererCallbacks({
    onSelectFeed: selectFeed,
    onOpenArticle: openArticle,
    onRemoveFeed: removeFeed,
    onAddFeed: () => handleAddFeed().then(() => {}).catch(() => {}),
    onRefreshAll: async () => {
      const prevUnread = getTotalUnread();
      await fetchAllFeeds();
      const newUnread = getTotalUnread();
      if (newUnread !== prevUnread) {
        notifyUnreadUpdate(newUnread);
      }
    },
  });

  buildLayout();
  renderSidebar();
  renderArticleList();
  renderArticleView();

  // Initial fetch
  const prevUnread = getTotalUnread();
  await fetchAllFeeds();
  const newUnread = getTotalUnread();
  if (newUnread !== prevUnread) {
    notifyUnreadUpdate(newUnread);
  }

  // Register App Protocol after all setup
  registerAppProtocol({
    refresh: async () => {
      await fetchAllFeeds();
      const total = getTotalUnread();
      notifyUnreadUpdate(total);
      return { ok: true, totalUnread: total };
    },
    markAllRead: () => {
      const current = getCurrentArticles();
      current.forEach(a => {
        if (!store.readArticleIds.includes(a.id)) {
          store.readArticleIds.push(a.id);
        }
      });
      if (store.selectedFeedId === 'all') {
        Object.keys(store.unreadCounts).forEach(k => store.unreadCounts[k] = 0);
      } else if (store.selectedFeedId) {
        store.unreadCounts[store.selectedFeedId] = 0;
      }
      saveState();
      renderSidebar();
      renderArticleList();
      return { ok: true };
    },
    selectFeed: (feedId: string) => {
      selectFeed(feedId);
      return { ok: true };
    },
    addFeed: async (url: string, name?: string) => {
      const feedId = await handleAddFeed(url, name);
      return { ok: true, feedId };
    },
  });
}

init();
