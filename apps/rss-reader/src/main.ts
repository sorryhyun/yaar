export {};
import { createSignal, onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import type { Article } from './types';
import {
  feeds, setFeeds, readArticleIds, setReadArticleIds, selectedFeedId, setSelectedFeedId,
  articles, setArticles, loadingFeedIds, errorFeeds, selectedArticle, setSelectedArticle,
  unreadCounts, setUnreadCounts, toastMsg, showToast, FALLBACK_FEEDS,
} from './store';
import { loadState, saveState } from './storage';
import { fetchAllFeeds, fetchSingleFeed } from './fetcher';
import { registerAppProtocol, notifyUnreadUpdate } from './protocol';
import { generateFeedId, extractDomainName, formatDate } from './utils';
import './styles.css';

const MIN_SIDEBAR = 160;
const MIN_ARTICLE_LIST = 220;
const MIN_CONTENT = 300;
const PREFS_PATH = 'rss-reader/prefs.json';

// Panel width signals
const [sidebarW, setSidebarW] = createSignal(240);
const [articleW, setArticleW] = createSignal(320);

// Add-feed form signals
const [addFeedUrl, setAddFeedUrl] = createSignal('');
const [addFeedName, setAddFeedName] = createSignal('');

const yaarStorage = () => (window as any).yaar?.storage;

async function loadPanelPrefs() {
  try {
    const p = await yaarStorage()?.read(PREFS_PATH, { as: 'json' });
    if (p?.sidebarW) setSidebarW(p.sidebarW);
    if (p?.articleW) setArticleW(p.articleW);
  } catch { /* defaults ok */ }
}

async function savePanelPrefs() {
  try {
    await yaarStorage()?.save(PREFS_PATH, JSON.stringify({ sidebarW: sidebarW(), articleW: articleW() }));
  } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCurrentArticles(): Article[] {
  const art = articles();
  if (selectedFeedId() === 'all') {
    const all: Article[] = [];
    for (const feed of feeds()) all.push(...(art[feed.id] || []));
    return all.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  }
  return art[selectedFeedId() || ''] || [];
}

function getTotalUnread(): number {
  const vals = Object.values(unreadCounts()) as number[];
  return vals.reduce((a, b) => a + b, 0);
}

function sanitizeContent(html_str: string): string {
  const doc = new DOMParser().parseFromString(html_str, 'text/html');
  doc.querySelectorAll('script, style, iframe, form, input, button').forEach(el => el.remove());
  doc.querySelectorAll('a').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); });
  doc.querySelectorAll('img').forEach(img => { img.style.maxWidth = '100%'; img.style.height = 'auto'; img.setAttribute('onerror', "this.style.display='none'"); });
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => { if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name); });
  });
  return doc.body.innerHTML;
}

// ── Actions ───────────────────────────────────────────────────────────────────
function selectFeed(feedId: string) {
  setSelectedFeedId(feedId);
  setSelectedArticle(null);
}

function openArticle(article: Article) {
  setSelectedArticle(article);
  if (!readArticleIds().includes(article.id)) {
    setReadArticleIds([...readArticleIds(), article.id]);
    const uc = { ...unreadCounts() };
    if ((uc[article.feedId] || 0) > 0) { uc[article.feedId]--; setUnreadCounts(uc); }
    saveState();
  }
}

function removeFeed(feedId: string) {
  setFeeds(feeds().filter(f => f.id !== feedId));
  const art = { ...articles() }; delete art[feedId]; setArticles(art);
  const uc = { ...unreadCounts() }; delete uc[feedId]; setUnreadCounts(uc);
  const ef = { ...errorFeeds() }; delete ef[feedId];
  if (selectedFeedId() === feedId) { setSelectedFeedId('all'); setSelectedArticle(null); }
  saveState();
}

function markAllRead() {
  const current = getCurrentArticles();
  const ids = [...readArticleIds()];
  current.forEach(a => { if (!ids.includes(a.id)) ids.push(a.id); });
  setReadArticleIds(ids);
  const sf = selectedFeedId();
  const uc = { ...unreadCounts() };
  if (sf === 'all') Object.keys(uc).forEach(k => uc[k] = 0);
  else if (sf) uc[sf] = 0;
  setUnreadCounts(uc);
  saveState();
}

async function handleAddFeed(): Promise<void> {
  const url = addFeedUrl().trim();
  const name = addFeedName().trim();
  if (!url) return;
  try { new URL(url); } catch { showToast('Please enter a valid URL', 'error'); return; }
  if (feeds().some(f => f.url === url)) { showToast('Feed already exists', 'error'); return; }
  const id = generateFeedId();
  const resolvedName = name || extractDomainName(url);
  const newFeed = { id, name: resolvedName, url };
  setFeeds([...feeds(), newFeed]);
  setAddFeedUrl('');
  setAddFeedName('');
  saveState();
  await fetchSingleFeed(newFeed);
  selectFeed(id);
}

async function handleAddFeedExternal(url: string, name?: string): Promise<string> {
  if (!url) throw new Error('No URL provided');
  try { new URL(url); } catch { showToast('Please enter a valid URL', 'error'); throw new Error('Invalid URL'); }
  if (feeds().some(f => f.url === url)) { showToast('Feed already exists', 'error'); throw new Error('Duplicate feed URL'); }
  const id = generateFeedId();
  const resolvedName = name || extractDomainName(url);
  const newFeed = { id, name: resolvedName, url };
  setFeeds([...feeds(), newFeed]);
  saveState();
  await fetchSingleFeed(newFeed);
  selectFeed(id);
  return id;
}

// ── Divider element refs (captured during mount, used in onMount) ──────────────
let leftDividerEl!: HTMLElement;
let rightDividerEl!: HTMLElement;
let panelBodyEl!: HTMLElement;

// ── Template Sections ──────────────────────────────────────────────────────────

function SidebarContent() {
  return html`
    <div class="sidebar-header">
      <span class="app-title">RSS Reader</span>
    </div>

    <div class="sidebar-section">
      <div
        class=${() => `feed-item${selectedFeedId() === 'all' ? ' active' : ''}`}
        onClick=${() => selectFeed('all')}
      >
        <span class="feed-icon">🌐</span>
        <span class="feed-name">All Feeds</span>
        ${() => getTotalUnread() > 0 ? html`
          <span class="badge">${() => { const u = getTotalUnread(); return u > 99 ? '99+' : String(u); }}</span>
        ` : null}
      </div>
    </div>

    <div class="sidebar-section-label">MY FEEDS</div>
    <div class="sidebar-feeds">
      ${() => feeds().map(feed => {
        const isLoading = loadingFeedIds().includes(feed.id);
        const hasError = !!errorFeeds()[feed.id];
        const count = unreadCounts()[feed.id] || 0;
        return html`
          <div
            class=${() => `feed-item${selectedFeedId() === feed.id ? ' active' : ''}`}
            onClick=${() => selectFeed(feed.id)}
          >
            <span class="feed-icon">${hasError ? '⚠️' : isLoading ? '' : '📡'}</span>
            ${isLoading ? html`<span class="spinner"></span>` : ''}
            <span class="feed-name" title="${feed.url}">${feed.name}</span>
            ${count > 0 && !hasError ? html`<span class="badge">${count > 99 ? '99+' : String(count)}</span>` : ''}
            <button
              class="feed-remove"
              title="Remove feed"
              onClick=${(e: Event) => { e.stopPropagation(); removeFeed(feed.id); }}
            >×</button>
          </div>
        `;
      })}
    </div>

    <div class="add-feed-section">
      <div class="sidebar-section-label">ADD FEED</div>
      <div class="add-feed-form">
        <input
          type="text"
          class="feed-url-input"
          placeholder="Feed URL..."
          value=${addFeedUrl}
          onInput=${(e: Event) => setAddFeedUrl((e.target as HTMLInputElement).value)}
          onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter') handleAddFeed(); }}
        />
        <input
          type="text"
          class="feed-name-input"
          placeholder="Name (optional)"
          value=${addFeedName}
          onInput=${(e: Event) => setAddFeedName((e.target as HTMLInputElement).value)}
        />
        <button class="add-feed-btn" onClick=${() => handleAddFeed()}>Add Feed</button>
      </div>
    </div>

    <div class="sidebar-footer">
      <button class="refresh-all-btn" onClick=${async () => {
        const prevUnread = getTotalUnread();
        await fetchAllFeeds();
        const newUnread = getTotalUnread();
        if (newUnread !== prevUnread) notifyUnreadUpdate(newUnread);
      }}>⟳ Refresh All</button>
    </div>
  `;
}

function ArticleListContent() {
  return () => {
    const sf = selectedFeedId();
    const isCurrentFeedLoading = sf !== 'all' && !!sf && loadingFeedIds().includes(sf);

    if (isCurrentFeedLoading) {
      return html`
        <div class="loading-state">
          <div class="spinner-large"></div>
          <p>Loading articles...</p>
        </div>
      `;
    }

    const currentArticles = getCurrentArticles();
    const isAnyLoading = loadingFeedIds().length > 0;

    if (currentArticles.length === 0) {
      return html`
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p class="empty-title">No articles found</p>
          <p class="empty-sub">${isAnyLoading ? 'Loading...' : 'Try refreshing or adding more feeds'}</p>
        </div>
      `;
    }

    return html`${currentArticles.map(article => {
      const isRead = readArticleIds().includes(article.id);
      const isSelected = selectedArticle()?.id === article.id;
      return html`
        <div
          class=${`article-item${isRead ? ' read' : ' unread'}${isSelected ? ' selected' : ''}`}
          onClick=${() => openArticle(article)}
        >
          ${article.thumbnail ? html`<img class="article-thumb" src="${article.thumbnail}" alt="" onerror="this.style.display='none'" />` : ''}
          <div class="article-meta">
            <div class="article-source">
              <span class="source-name">${article.feedName}</span>
              <span class="pub-date">${formatDate(article.pubDate)}</span>
            </div>
            <div class="article-title">${article.title}</div>
            ${article.description ? html`<div class="article-desc">${article.description}</div>` : ''}
          </div>
          ${!isRead ? html`<div class="unread-dot"></div>` : ''}
        </div>
      `;
    })}`;
  };
}

function ArticleViewContent() {
  return () => {
    const article = selectedArticle();

    if (!article) {
      return html`
        <div class="welcome-state">
          <div class="welcome-icon">📰</div>
          <h2 class="welcome-title">RSS Reader</h2>
          <p class="welcome-sub">Select a feed from the sidebar and click an article to read it.</p>
        </div>
      `;
    }

    const sanitizedContent = sanitizeContent(article.content || article.description || '');

    return html`
      <div class="article-view">
        <div class="article-view-header">
          <button class="back-btn" onClick=${() => { setSelectedArticle(null); }}>← Back</button>
          <a href="${article.link}" target="_blank" class="open-external-btn" rel="noopener noreferrer">
            Open in Browser ↗
          </a>
        </div>
        <div class="article-view-body">
          <div class="article-view-source">
            <span>${article.feedName}</span>
            ${article.author ? html`<span class="author-sep">·</span><span>${article.author}</span>` : ''}
            ${article.pubDate ? html`<span class="author-sep">·</span><span>${formatDate(article.pubDate)}</span>` : ''}
          </div>
          <h1 class="article-view-title">${article.title}</h1>
          ${article.thumbnail ? html`<img class="article-view-thumb" src="${article.thumbnail}" alt="" onerror="this.style.display='none'" />` : ''}
          <div class="article-view-content" ref=${(el: HTMLElement) => { el.innerHTML = sanitizedContent; }}></div>
          <div class="article-view-footer">
            <a href="${article.link}" target="_blank" class="read-more-link" rel="noopener noreferrer">
              Read full article on ${article.feedName} ↗
            </a>
          </div>
        </div>
      </div>
    `;
  };
}

// ── Mount ──────────────────────────────────────────────────────────────────────
render(() => {
  onMount(async () => {
    // Setup left divider
    {
      let dragging = false, startX = 0, startW = 0;
      const el = leftDividerEl;
      const onMove = (e: MouseEvent) => {
        if (!dragging) return;
        const newW = Math.max(MIN_SIDEBAR, startW + (e.clientX - startX));
        setSidebarW(newW);
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        document.body.style.userSelect = '';
        savePanelPrefs();
      };
      el.addEventListener('mousedown', (e) => {
        dragging = true; startX = e.clientX; startW = sidebarW();
        el.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault();
      });
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      onCleanup(() => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      });
    }

    // Setup right divider
    {
      let dragging = false, startX = 0, startW = 0;
      const el = rightDividerEl;
      const onMove = (e: MouseEvent) => {
        if (!dragging) return;
        const newW = Math.max(MIN_ARTICLE_LIST, startW + (e.clientX - startX));
        if (panelBodyEl) {
          const available = panelBodyEl.getBoundingClientRect().width;
          if (available - newW - 4 < MIN_CONTENT) return;
        }
        setArticleW(newW);
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        document.body.style.userSelect = '';
        savePanelPrefs();
      };
      el.addEventListener('mousedown', (e) => {
        dragging = true; startX = e.clientX; startW = articleW();
        el.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault();
      });
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      onCleanup(() => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      });
    }

    await loadPanelPrefs();
    await loadState();
    const prevUnread = getTotalUnread();
    await fetchAllFeeds();
    const newUnread = getTotalUnread();
    if (newUnread !== prevUnread) notifyUnreadUpdate(newUnread);

    registerAppProtocol({
      refresh: async () => {
        await fetchAllFeeds();
        const total = getTotalUnread();
        notifyUnreadUpdate(total);
        return { ok: true, totalUnread: total };
      },
      markAllRead: () => { markAllRead(); return { ok: true }; },
      selectFeed: (feedId: string) => { selectFeed(feedId); return { ok: true }; },
      addFeed: async (url: string, name?: string) => {
        const feedId = await handleAddFeedExternal(url, name);
        return { ok: true, feedId };
      },
    });
  });

  return html`
    <div class="app-container">
      <aside
        class="sidebar"
        style=${() => `width: ${sidebarW()}px`}
      >
        ${SidebarContent()}
      </aside>

      <div
        class="divider"
        ref=${(el: HTMLElement) => { leftDividerEl = el; }}
      ></div>

      <div class="main-panel">
        <div class="panel-header">
          <span id="panel-title">${() => {
            const sf = selectedFeedId();
            if (sf === 'all') return 'All Feeds';
            return feeds().find(f => f.id === sf)?.name || 'Feed';
          }}</span>
          <button class="mark-all-read-btn" onClick=${() => markAllRead()}>Mark all read</button>
        </div>
        <div class="panel-body" ref=${(el: HTMLElement) => { panelBodyEl = el; }}>
          <div
            class="article-list-wrap"
            style=${() => `width: ${articleW()}px`}
          >
            <div class="article-list">
              ${ArticleListContent()}
            </div>
          </div>

          <div
            class="divider"
            ref=${(el: HTMLElement) => { rightDividerEl = el; }}
          ></div>

          <div class="content-area">
            ${ArticleViewContent()}
          </div>
        </div>
      </div>
    </div>

    ${() => toastMsg() !== null ? html`
      <div class=${() => `toast toast-${toastMsg()?.type || 'info'}`}>
        ${() => toastMsg()?.text || ''}
      </div>
    ` : null}
  `;
}, document.getElementById('app')!);
