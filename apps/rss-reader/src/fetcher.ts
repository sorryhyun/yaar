import { Feed, Article } from './types';
import { store } from './store';
import { stripHtml, extractFirstImage } from './utils';
import { renderSidebar, renderArticleList } from './renderer';

const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';

export async function fetchFeed(feed: Feed): Promise<Article[]> {
  const apiUrl = `${RSS2JSON_API}${encodeURIComponent(feed.url)}&count=30`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.message || 'Feed error');

  return (json.items || []).map((item: any) => {
    const id = btoa(encodeURIComponent(item.link || item.title || Math.random().toString())).slice(0, 20);
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

export async function fetchAllFeeds(): Promise<void> {
  store.articles = {};
  store.unreadCounts = {};

  const promises = store.feeds.map(async (feed) => {
    store.loadingFeeds.add(feed.id);
    store.errorFeeds[feed.id] = '';
    renderSidebar();

    try {
      const items = await fetchFeed(feed);
      store.articles[feed.id] = items;
      store.unreadCounts[feed.id] = items.filter(a => !store.readArticleIds.includes(a.id)).length;
    } catch (e: any) {
      store.errorFeeds[feed.id] = e.message || 'Failed to load';
      store.articles[feed.id] = [];
      store.unreadCounts[feed.id] = 0;
    } finally {
      store.loadingFeeds.delete(feed.id);
      renderSidebar();
      renderArticleList();
    }
  });

  await Promise.allSettled(promises);
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
  } finally {
    store.loadingFeeds.delete(feed.id);
    renderSidebar();
    renderArticleList();
  }
}
