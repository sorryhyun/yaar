import { Article } from './types';
import { store } from './store';
import { getTotalUnread } from './renderer';

export interface ProtocolActions {
  refresh: () => Promise<{ ok: boolean; totalUnread: number }>;
  markAllRead: () => { ok: boolean };
  selectFeed: (feedId: string) => { ok: boolean };
  addFeed: (url: string, name?: string) => Promise<{ ok: boolean; feedId: string }>;
}

export function registerAppProtocol(actions: ProtocolActions) {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;

  appApi.register({
    appId: 'rss-reader',
    name: 'RSS Reader',
    state: {
      unreadCount: {
        description: 'Total unread article count',
        handler: () => getTotalUnread(),
      },
      feeds: {
        description: 'All feeds with unread counts',
        handler: () => store.feeds.map(f => ({
          id: f.id,
          name: f.name,
          url: f.url,
          unreadCount: store.unreadCounts[f.id] || 0,
        })),
      },
      articles: {
        description: 'Current visible articles (max 50)',
        handler: (): Array<{ title: string; feedName: string; pubDate: string; isRead: boolean; link: string }> => {
          const allArticles: Article[] = [];
          if (store.selectedFeedId === 'all') {
            for (const feed of store.feeds) {
              allArticles.push(...(store.articles[feed.id] || []));
            }
            allArticles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
          } else {
            allArticles.push(...(store.articles[store.selectedFeedId || ''] || []));
          }
          return allArticles.slice(0, 50).map(a => ({
            title: a.title,
            feedName: a.feedName,
            pubDate: a.pubDate,
            isRead: store.readArticleIds.includes(a.id),
            link: a.link,
          }));
        },
      },
      selectedArticle: {
        description: 'Currently selected article or null',
        handler: () => store.selectedArticle
          ? {
              title: store.selectedArticle.title,
              feedName: store.selectedArticle.feedName,
              pubDate: store.selectedArticle.pubDate,
              link: store.selectedArticle.link,
            }
          : null,
      },
    },
    commands: {
      refresh: {
        description: 'Refresh all feeds',
        params: { type: 'object', properties: {} },
        handler: async () => actions.refresh(),
      },
      markAllRead: {
        description: 'Mark all visible articles as read',
        params: { type: 'object', properties: {} },
        handler: () => actions.markAllRead(),
      },
      selectFeed: {
        description: 'Select a feed by ID',
        params: {
          type: 'object',
          properties: { feedId: { type: 'string' } },
          required: ['feedId'],
        },
        handler: (p: { feedId: string }) => actions.selectFeed(p.feedId),
      },
      addFeed: {
        description: 'Add a new feed by URL',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['url'],
        },
        handler: (p: { url: string; name?: string }) => actions.addFeed(p.url, p.name),
      },
    },
  });
}

export function notifyUnreadUpdate(totalUnread: number) {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;
  appApi.sendInteraction({ event: 'unread_update', totalUnread });
}
