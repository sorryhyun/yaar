import { createStore } from '@bundled/solid-js/store';
import type { Feed, Article } from './types';

export const FALLBACK_FEEDS: Feed[] = [
  { id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'nasa', name: 'NASA Breaking News', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

export const [state, setState] = createStore({
  feeds: [] as Feed[],
  readArticleIds: [] as string[],
  selectedFeedId: 'all',
  articles: {} as Record<string, Article[]>,
  loadingFeedIds: [] as string[],
  errorFeeds: {} as Record<string, string>,
  selectedArticle: null as Article | null,
  unreadCounts: {} as Record<string, number>,
  // UI
  showAddForm: false,
  addBusy: false,
});

// Toast
export { showToast } from '@bundled/yaar';
