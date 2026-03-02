import { signal } from '@bundled/yaar';
import type { Feed, Article } from './types';

export const FALLBACK_FEEDS: Feed[] = [
  { id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'nasa', name: 'NASA Breaking News', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

export const feeds = signal<Feed[]>([]);
export const readArticleIds = signal<string[]>([]);
export const selectedFeedId = signal<string>('all');
export const articles = signal<Record<string, Article[]>>({});
export const loadingFeedIds = signal<string[]>([]);
export const errorFeeds = signal<Record<string, string>>({});
export const selectedArticle = signal<Article | null>(null);
export const unreadCounts = signal<Record<string, number>>({});

// Toast
export const toastMsg = signal<{ text: string; type: 'info' | 'error' | 'success' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, type: 'info' | 'error' | 'success' = 'info') {
  if (toastTimer) clearTimeout(toastTimer);
  toastMsg({ text: message, type });
  toastTimer = setTimeout(() => toastMsg(null), 2500);
}
