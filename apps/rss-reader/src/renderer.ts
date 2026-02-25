import { Article } from './types';
import { store } from './store';
import { escapeHtml, formatDate } from './utils';
import { saveState } from './storage';

// These callbacks are set by main.ts to break circular deps
let _onSelectFeed: (feedId: string) => void = () => {};
let _onOpenArticle: (article: Article) => void = () => {};
let _onRemoveFeed: (feedId: string) => void = () => {};
let _onAddFeed: () => Promise<void> = async () => {};
let _onRefreshAll: () => Promise<void> = async () => {};

export function setRendererCallbacks(callbacks: {
  onSelectFeed: (feedId: string) => void;
  onOpenArticle: (article: Article) => void;
  onRemoveFeed: (feedId: string) => void;
  onAddFeed: () => Promise<void>;
  onRefreshAll: () => Promise<void>;
}) {
  _onSelectFeed = callbacks.onSelectFeed;
  _onOpenArticle = callbacks.onOpenArticle;
  _onRemoveFeed = callbacks.onRemoveFeed;
  _onAddFeed = callbacks.onAddFeed;
  _onRefreshAll = callbacks.onRefreshAll;
}

export function getCurrentArticles(): Article[] {
  if (store.selectedFeedId === 'all') {
    const all: Article[] = [];
    for (const feed of store.feeds) {
      all.push(...(store.articles[feed.id] || []));
    }
    all.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
    return all;
  }
  return store.articles[store.selectedFeedId || ''] || [];
}

export function getTotalUnread(): number {
  return Object.values(store.unreadCounts).reduce((a, b) => a + b, 0);
}

export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const totalUnread = getTotalUnread();

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <span class="app-title">RSS Reader</span>
    </div>

    <div class="sidebar-section">
      <div class="feed-item ${store.selectedFeedId === 'all' ? 'active' : ''}" data-feed-id="all">
        <span class="feed-icon">🌐</span>
        <span class="feed-name">All Feeds</span>
        ${totalUnread > 0 ? `<span class="badge">${totalUnread > 99 ? '99+' : totalUnread}</span>` : ''}
      </div>
    </div>

    <div class="sidebar-section-label">MY FEEDS</div>
    <div class="sidebar-feeds">
      ${store.feeds.map(feed => {
        const isLoading = store.loadingFeeds.has(feed.id);
        const hasError = !!store.errorFeeds[feed.id];
        const count = store.unreadCounts[feed.id] || 0;
        return `
          <div class="feed-item ${store.selectedFeedId === feed.id ? 'active' : ''}" data-feed-id="${feed.id}">
            <span class="feed-icon">${hasError ? '⚠️' : isLoading ? '' : '📡'}</span>
            ${isLoading ? '<span class="spinner"></span>' : ''}
            <span class="feed-name" title="${feed.url}">${escapeHtml(feed.name)}</span>
            ${count > 0 && !hasError ? `<span class="badge">${count > 99 ? '99+' : count}</span>` : ''}
            <button class="feed-remove" data-feed-id="${feed.id}" title="Remove feed">×</button>
          </div>
        `;
      }).join('')}
    </div>

    <div class="add-feed-section">
      <div class="sidebar-section-label">ADD FEED</div>
      <div class="add-feed-form">
        <input type="text" id="feed-url-input" placeholder="Feed URL..." class="feed-url-input" />
        <input type="text" id="feed-name-input" placeholder="Name (optional)" class="feed-name-input" />
        <button id="add-feed-btn" class="add-feed-btn">Add Feed</button>
      </div>
    </div>

    <div class="sidebar-footer">
      <button class="refresh-all-btn" id="refresh-all-btn">⟳ Refresh All</button>
    </div>
  `;

  // Bind events
  sidebar.querySelectorAll('.feed-item[data-feed-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('feed-remove')) return;
      const feedId = (el as HTMLElement).dataset.feedId!;
      _onSelectFeed(feedId);
    });
  });

  sidebar.querySelectorAll('.feed-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const feedId = (btn as HTMLElement).dataset.feedId!;
      _onRemoveFeed(feedId);
    });
  });

  const addBtn = document.getElementById('add-feed-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => _onAddFeed());
  }

  const urlInput = document.getElementById('feed-url-input');
  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') _onAddFeed();
    });
  }

  const refreshBtn = document.getElementById('refresh-all-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => _onRefreshAll());
  }
}

export function renderArticleList() {
  const list = document.getElementById('article-list');
  if (!list) return;
  const currentArticles = getCurrentArticles();
  const isAnyLoading = store.loadingFeeds.size > 0;

  if (store.selectedFeedId !== 'all' && store.selectedFeedId && store.loadingFeeds.has(store.selectedFeedId)) {
    list.innerHTML = `
      <div class="loading-state">
        <div class="spinner-large"></div>
        <p>Loading articles...</p>
      </div>
    `;
    return;
  }

  if (currentArticles.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p class="empty-title">No articles found</p>
        <p class="empty-sub">${isAnyLoading ? 'Loading...' : 'Try refreshing or adding more feeds'}</p>
      </div>
    `;
    return;
  }

  list.innerHTML = currentArticles.map(article => {
    const isRead = store.readArticleIds.includes(article.id);
    const isSelected = store.selectedArticle?.id === article.id;
    return `
      <div class="article-item ${isRead ? 'read' : 'unread'} ${isSelected ? 'selected' : ''}" data-article-id="${article.id}">
        ${article.thumbnail ? `<img class="article-thumb" src="${escapeHtml(article.thumbnail)}" alt="" onerror="this.style.display='none'" />` : ''}
        <div class="article-meta">
          <div class="article-source">
            <span class="source-name">${escapeHtml(article.feedName)}</span>
            <span class="pub-date">${formatDate(article.pubDate)}</span>
          </div>
          <div class="article-title">${escapeHtml(article.title)}</div>
          ${article.description ? `<div class="article-desc">${escapeHtml(article.description)}</div>` : ''}
        </div>
        ${!isRead ? '<div class="unread-dot"></div>' : ''}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.article-item').forEach(el => {
    el.addEventListener('click', () => {
      const articleId = (el as HTMLElement).dataset.articleId!;
      const article = currentArticles.find(a => a.id === articleId);
      if (article) _onOpenArticle(article);
    });
  });
}

export function renderArticleView() {
  const content = document.getElementById('content-area');
  if (!content) return;

  if (!store.selectedArticle) {
    content.innerHTML = `
      <div class="welcome-state">
        <div class="welcome-icon">📰</div>
        <h2 class="welcome-title">RSS Reader</h2>
        <p class="welcome-sub">Select a feed from the sidebar and click an article to read it.</p>
      </div>
    `;
    return;
  }

  const article = store.selectedArticle;
  const sanitizedContent = sanitizeContent(article.content || article.description || '');

  content.innerHTML = `
    <div class="article-view">
      <div class="article-view-header">
        <button class="back-btn" id="back-btn">← Back</button>
        <a href="${escapeHtml(article.link)}" target="_blank" class="open-external-btn" rel="noopener noreferrer">
          Open in Browser ↗
        </a>
      </div>
      <div class="article-view-body">
        <div class="article-view-source">
          <span>${escapeHtml(article.feedName)}</span>
          ${article.author ? `<span class="author-sep">·</span><span>${escapeHtml(article.author)}</span>` : ''}
          ${article.pubDate ? `<span class="author-sep">·</span><span>${formatDate(article.pubDate)}</span>` : ''}
        </div>
        <h1 class="article-view-title">${escapeHtml(article.title)}</h1>
        ${article.thumbnail ? `<img class="article-view-thumb" src="${escapeHtml(article.thumbnail)}" alt="" onerror="this.style.display='none'" />` : ''}
        <div class="article-view-content">${sanitizedContent}</div>
        <div class="article-view-footer">
          <a href="${escapeHtml(article.link)}" target="_blank" class="read-more-link" rel="noopener noreferrer">
            Read full article on ${escapeHtml(article.feedName)} ↗
          </a>
        </div>
      </div>
    </div>
  `;

  document.getElementById('back-btn')?.addEventListener('click', () => {
    store.selectedArticle = null;
    renderArticleView();
    renderArticleList();
  });
}

function sanitizeContent(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, form, input, button').forEach(el => el.remove());
  doc.querySelectorAll('a').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  doc.querySelectorAll('img').forEach(img => {
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.setAttribute('onerror', "this.style.display='none'");
  });
  // Strip all on* event handler attributes from every remaining element
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

export function showToast(message: string, type: 'info' | 'error' | 'success' = 'info') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 400);
  }, 2500);
}
