import { Feed, Article } from './types';

// ---- Default Feeds ----
export const DEFAULT_FEEDS: Feed[] = [
  { id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { id: 'bbc', name: 'BBC News', url: 'http://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'nasa', name: 'NASA Breaking News', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

// ---- Shared Mutable Store ----
export const store = {
  feeds: [...DEFAULT_FEEDS] as Feed[],
  readArticleIds: [] as string[],
  selectedFeedId: 'all' as string | null,
  articles: {} as Record<string, Article[]>,
  loadingFeeds: new Set<string>(),
  errorFeeds: {} as Record<string, string>,
  selectedArticle: null as Article | null,
  unreadCounts: {} as Record<string, number>,
};
