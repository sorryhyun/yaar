import { Feed, Article } from './types';
import { store } from './store';
import { stripHtml, extractFirstImage } from './utils';
import { renderSidebar, renderArticleList, showToast } from './renderer';

const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';

// ---- Stable djb2 hash for article ID generation ----
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash.toString(36);
}

export async function fetchFeed(feed: Feed): Promise<Article[]> {
  const apiUrl = `${RSS2JSON_API}${encodeURIComponent(feed.url)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.message || 'Feed error');

  return (json.items || []).map((item: any) => {
    const raw = item.link || item.title || Math.random().toString();
    const id = `${feed.id}_${djb2Hash(raw)}`;
    return {
      id,
      feedId: feed.id,
      feedName: feed.name,
      title: item.title || 'Untitled',
      link: item.link || '',
      pubDate: item.pubDate || '',
      author: item.author || '',
      description: stripHtml(item.description || '').slice(0, 300),
      content: item.content || item.description || '',
      thumbnail: item.thumbnail || extractFirstImage(item.content || item.description || ''),
    };
  });
}

// Guard flag to prevent concurrent fetchAllFeeds calls
let isRefreshing = false;

export async function fetchAllFeeds(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  // Collect results locally — don't wipe store until all fetches complete
  const localArticles: Record<string, Article[]> = {};
  const localUnreadCounts: Record<string, number> = {};
  const localErrors: Record<string, string> = {};

  const promises = store.feeds.map(async (feed) => {
    store.loadingFeeds.add(feed.id);
    store.errorFeeds[feed.id] = '';
    renderSidebar();

    try {
      const items = await fetchFeed(feed);
      localArticles[feed.id] = items;
      localUnreadCounts[feed.id] = items.filter(a => !store.readArticleIds.includes(a.id)).length;
    } catch (e: any) {
      localErrors[feed.id] = e.message || 'Failed to load';
      localArticles[feed.id] = [];
      localUnreadCounts[feed.id] = 0;
    } finally {
      store.loadingFeeds.delete(feed.id);
      renderSidebar();
    }
  });

  await Promise.allSettled(promises);

  // Commit all results atomically
  store.articles = localArticles;
  store.unreadCounts = localUnreadCounts;
  Object.assign(store.errorFeeds, localErrors);

  isRefreshing = false;
  renderSidebar();
  renderArticleList();
}

export async function fetchSingleFeed(feed: Feed): Promise<void> {
  store.loadingFeeds.add(feed.id);
  store.errorFeeds[feed.id] = '';
  renderSidebar();
  renderArticleList();

  try {
    const items = await fetchFeed(feed);
    store.articles[feed.id] = items;
    store.unreadCounts[feed.id] = items.filter(a => !store.readArticleIds.includes(a.id)).length;
  } catch (e: any) {
    store.errorFeeds[feed.id] = e.message || 'Failed to load';
    store.articles[feed.id] = [];
    store.unreadCounts[feed.id] = 0;
    showToast(`Failed to load: ${feed.name}`, 'error');
  } finally {
    store.loadingFeeds.delete(feed.id);
    renderSidebar();
    renderArticleList();
  }
}
