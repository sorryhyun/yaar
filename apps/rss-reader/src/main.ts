import { createMemo, createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import type { Article, Feed } from './types';
import {
  feeds, setFeeds,
  articles,
  selectedFeedId, setSelectedFeedId,
  selectedArticle, setSelectedArticle,
  readArticleIds, setReadArticleIds,
  unreadCounts, loadingFeedIds,
  showToast,
} from './store';
import { fetchAllFeeds, fetchSingleFeed } from './fetcher';
import { loadState, saveState } from './storage';
import { registerAppProtocol, notifyUnreadUpdate } from './protocol';
import { formatDate, generateFeedId, extractDomainName } from './utils';
import './styles.css';

// ── Derived state ──────────────────────────────────────────────────────────

const visibleArticles = createMemo(() => {
  const art = articles();
  const selId = selectedFeedId();
  if (selId === 'all') {
    const all: Article[] = [];
    for (const feed of feeds()) all.push(...(art[feed.id] ?? []));
    return all.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  }
  return art[selId] ?? [];
});

const totalUnread = createMemo(() =>
  Object.values(unreadCounts() as Record<string, number>).reduce((sum, n) => sum + n, 0)
);

// ── Actions ────────────────────────────────────────────────────────────────

async function refresh(): Promise<{ ok: boolean; totalUnread: number }> {
  await fetchAllFeeds();
  await saveState();
  notifyUnreadUpdate(totalUnread());
  return { ok: true, totalUnread: totalUnread() };
}

function markAllRead(): { ok: boolean } {
  const ids = visibleArticles().map(a => a.id);
  setReadArticleIds(Array.from(new Set([...readArticleIds(), ...ids])));
  void saveState();
  return { ok: true };
}

function selectFeed(feedId: string): { ok: boolean } {
  setSelectedFeedId(feedId);
  setSelectedArticle(null);
  return { ok: true };
}

async function addFeed(url: string, name?: string): Promise<{ ok: boolean; feedId: string }> {
  let normalized: string;
  try { normalized = new URL(url).toString(); } catch { throw new Error('Invalid URL'); }
  if (feeds().some(f => f.url === normalized)) throw new Error('Feed already exists');
  const id = generateFeedId();
  const feed: Feed = { id, url: normalized, name: name || extractDomainName(normalized) };
  setFeeds([...feeds(), feed]);
  await fetchSingleFeed(feed);
  await saveState();
  showToast(`Added: ${feed.name}`, 'success');
  return { ok: true, feedId: id };
}

function removeFeed(feedId: string): void {
  setFeeds(feeds().filter(f => f.id !== feedId));
  if (selectedFeedId() === feedId) {
    setSelectedFeedId('all');
    setSelectedArticle(null);
  }
  void saveState();
}

function openArticle(article: Article): void {
  setSelectedArticle(article);
  if (!readArticleIds().includes(article.id)) {
    setReadArticleIds([...readArticleIds(), article.id]);
    void saveState();
  }
}

// ── Add-feed form state ─────────────────────────────────────────────────────

const [showAddForm, setShowAddForm] = createSignal(false);
const [addBusy, setAddBusy] = createSignal(false);
let addUrlInput: HTMLInputElement | null = null;
let addNameInput: HTMLInputElement | null = null;

async function submitAdd() {
  const url = addUrlInput?.value.trim() ?? '';
  if (!url) return;
  setAddBusy(true);
  try {
    await addFeed(url, addNameInput?.value.trim() || undefined);
    if (addUrlInput) addUrlInput.value = '';
    if (addNameInput) addNameInput.value = '';
    setShowAddForm(false);
  } catch (e: unknown) {
    showToast((e as Error).message, 'error');
  } finally {
    setAddBusy(false);
  }
}

// ── Render ──────────────────────────────────────────────────────────────────

render(() => html`
  <div id="layout">

    <!-- Feeds panel -->
    <aside class="feeds-panel">
      <div class="panel-hdr">
        <strong>📰 Feeds</strong>
        <button
          class="y-btn y-btn-ghost y-btn-sm"
          title="Refresh all feeds"
          disabled=${() => loadingFeedIds().length > 0}
          onClick=${() => void refresh()}
        >${() => loadingFeedIds().length > 0 ? '⟳' : '↻'}</button>
      </div>

      <div class="feed-list">
        <div
          class=${() => 'feed-item' + (selectedFeedId() === 'all' ? ' active' : '')}
          onClick=${() => selectFeed('all')}
        >
          <span class="feed-label">All Articles</span>
          ${() => totalUnread() > 0
            ? html`<span class="unread-pill">${totalUnread()}</span>`
            : null}
        </div>
        ${() => feeds().map(feed => html`
          <div
            class=${() => 'feed-item' + (selectedFeedId() === feed.id ? ' active' : '')}
            onClick=${() => selectFeed(feed.id)}
          >
            ${() => loadingFeedIds().includes(feed.id)
              ? html`<span class="dot-blink"></span>`
              : null}
            <span class="feed-label">${feed.name}</span>
            ${() => ((unreadCounts() as Record<string, number>)[feed.id] ?? 0) > 0
              ? html`<span class="unread-pill">${(unreadCounts() as Record<string, number>)[feed.id]}</span>`
              : null}
            <button
              class="rm-btn"
              title="Remove feed"
              onClick=${(e: MouseEvent) => { e.stopPropagation(); removeFeed(feed.id); }}
            >x</button>
          </div>
        `)}
      </div>

      <div class="add-area">
        ${() => !showAddForm()
          ? html`<button
              class="y-btn y-btn-ghost y-btn-sm"
              style="width:100%;"
              onClick=${() => setShowAddForm(true)}
            >+ Add Feed</button>`
          : html`
            <div class="add-form">
              <input
                class="y-input"
                placeholder="https://example.com/feed.xml"
                ref=${(el: HTMLInputElement) => { addUrlInput = el; }}
              />
              <input
                class="y-input"
                placeholder="Name (optional)"
                ref=${(el: HTMLInputElement) => { addNameInput = el; }}
              />
              <div class="add-actions">
                <button
                  class="y-btn y-btn-primary y-btn-sm"
                  style="flex:1;"
                  disabled=${() => addBusy()}
                  onClick=${() => void submitAdd()}
                >Add</button>
                <button
                  class="y-btn y-btn-ghost y-btn-sm"
                  onClick=${() => { setShowAddForm(false); }}
                >Cancel</button>
              </div>
            </div>`}
      </div>
    </aside>

    <!-- Articles panel -->
    <section class="articles-panel">
      <div class="panel-hdr">
        <strong>${() => selectedFeedId() === 'all'
          ? 'All Articles'
          : (feeds().find(f => f.id === selectedFeedId())?.name ?? 'Articles')
        }</strong>
        <button class="y-btn y-btn-ghost y-btn-sm" onClick=${() => markAllRead()}>✓ All read</button>
      </div>
      <div class="article-list">
        ${() => visibleArticles().length === 0
          ? html`<div class="empty-hint">No articles yet — select a feed and click refresh.</div>`
          : null}
        ${() => visibleArticles().map(article => html`
          <div
            class=${() => {
              let cls = 'article-item';
              if (selectedArticle()?.id === article.id) cls += ' active';
              if (!readArticleIds().includes(article.id)) cls += ' unread';
              return cls;
            }}
            onClick=${() => openArticle(article)}
          >
            <div class="art-title">${article.title}</div>
            <div class="art-meta">${article.feedName} · ${formatDate(article.pubDate)}</div>
          </div>
        `)}
      </div>
    </section>

    <!-- Content panel -->
    <main class="content-panel">
      <div class="content-main">
        ${() => !selectedArticle()
          ? html`
            <div class="splash">
              <span class="splash-icon">📰</span>
              <span>Select an article to read</span>
            </div>`
          : html`
            <div class="art-view">
              <div class="art-header">
                <div class="art-view-title">${() => selectedArticle()!.title}</div>
                <div class="art-view-meta">
                  <span>${() => selectedArticle()!.feedName}</span>
                  ${() => selectedArticle()!.author
                    ? html`<span>${() => selectedArticle()!.author}</span>`
                    : null}
                  <span>${() => formatDate(selectedArticle()!.pubDate)}</span>
                  <a
                    href=${() => selectedArticle()!.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="ext-link"
                  >Open original ↗</a>
                </div>
              </div>
              <div
                class="art-body"
                .innerHTML=${() => selectedArticle()!.content || selectedArticle()!.description || ''}
              ></div>
            </div>`}
      </div>

      <div class="status-bar">
        <span>${() => `${feeds().length} feeds · ${visibleArticles().length} articles · ${totalUnread()} unread`}</span>

      </div>
    </main>
  </div>
`, document.getElementById('app')!);

// ── Bootstrap ───────────────────────────────────────────────────────────────

registerAppProtocol({ refresh, markAllRead, selectFeed, addFeed });

void (async () => {
  await loadState();
  await fetchAllFeeds();
})();
