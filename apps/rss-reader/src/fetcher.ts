import type { Feed, Article } from './types';
import {
  feeds, loadingFeedIds, errorFeeds, articles, unreadCounts, readArticleIds, showToast
} from './store';
import { stripHtml, extractFirstImage } from './utils';

const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
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
      id, feedId: feed.id, feedName: feed.name,
      title: item.title || 'Untitled', link: item.link || '',
      pubDate: item.pubDate || '', author: item.author || '',
      description: stripHtml(item.description || '').slice(0, 300),
      content: item.content || item.description || '',
      thumbnail: item.thumbnail || extractFirstImage(item.content || item.description || ''),
    };
  });
}

let isRefreshing = false;

export async function fetchAllFeeds(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  const localArticles: Record<string, Article[]> = {};
  const localUnreadCounts: Record<string, number> = {};
  const localErrors: Record<string, string> = {};

  const promises = feeds().map(async (feed) => {
    loadingFeedIds([...loadingFeedIds(), feed.id]);
    const ef = { ...errorFeeds() };
    ef[feed.id] = '';
    errorFeeds(ef);

    try {
      const items = await fetchFeed(feed);
      localArticles[feed.id] = items;
      localUnreadCounts[feed.id] = items.filter(a => !readArticleIds().includes(a.id)).length;
    } catch (e: any) {
      localErrors[feed.id] = e.message || 'Failed to load';
      localArticles[feed.id] = [];
      localUnreadCounts[feed.id] = 0;
    } finally {
      loadingFeedIds(loadingFeedIds().filter(id => id !== feed.id));
    }
  });

  await Promise.allSettled(promises);
  articles(localArticles);
  unreadCounts(localUnreadCounts);
  errorFeeds({ ...errorFeeds(), ...localErrors });
  isRefreshing = false;
}

export async function fetchSingleFeed(feed: Feed): Promise<void> {
  loadingFeedIds([...loadingFeedIds(), feed.id]);
  const ef = { ...errorFeeds() };
  ef[feed.id] = '';
  errorFeeds(ef);

  try {
    const items = await fetchFeed(feed);
    articles({ ...articles(), [feed.id]: items });
    unreadCounts({
      ...unreadCounts(),
      [feed.id]: items.filter(a => !readArticleIds().includes(a.id)).length,
    });
  } catch (e: any) {
    errorFeeds({ ...errorFeeds(), [feed.id]: e.message || 'Failed to load' });
    articles({ ...articles(), [feed.id]: [] });
    unreadCounts({ ...unreadCounts(), [feed.id]: 0 });
    showToast(`Failed to load: ${feed.name}`, 'error');
  } finally {
    loadingFeedIds(loadingFeedIds().filter(id => id !== feed.id));
  }
}
