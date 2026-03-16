import { createSignal } from '@bundled/solid-js';
import type { Feed, Article } from './types';

export const FALLBACK_FEEDS: Feed[] = [
  { id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'nasa', name: 'NASA Breaking News', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

export const [feeds, setFeeds] = createSignal<Feed[]>([]);
export const [readArticleIds, setReadArticleIds] = createSignal<string[]>([]);
export const [selectedFeedId, setSelectedFeedId] = createSignal<string>('all');
export const [articles, setArticles] = createSignal<Record<string, Article[]>>({});
export const [loadingFeedIds, setLoadingFeedIds] = createSignal<string[]>([]);
export const [errorFeeds, setErrorFeeds] = createSignal<Record<string, string>>({});
export const [selectedArticle, setSelectedArticle] = createSignal<Article | null>(null);
export const [unreadCounts, setUnreadCounts] = createSignal<Record<string, number>>({});

// Toast
export const [toastMsg, setToastMsg] = createSignal<{ text: string; type: 'info' | 'error' | 'success' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, type: 'info' | 'error' | 'success' = 'info') {
  if (toastTimer) clearTimeout(toastTimer);
  setToastMsg({ text: message, type });
  toastTimer = setTimeout(() => setToastMsg(null), 2500);
}
