import type { Article } from './types';
import {
  feeds, articles, unreadCounts, readArticleIds, selectedFeedId, selectedArticle
} from './store';

export interface ProtocolActions {
  refresh: () => Promise<{ ok: boolean; totalUnread: number }>;
  markAllRead: () => { ok: boolean };
  selectFeed: (feedId: string) => { ok: boolean };
  addFeed: (url: string, name?: string) => Promise<{ ok: boolean; feedId: string }>;
}

function getTotalUnread(): number {
  const vals = Object.values(unreadCounts()) as number[];
  return vals.reduce((a, b) => a + b, 0);
}

function getCurrentArticles(): Article[] {
  const art = articles();
  if (selectedFeedId() === 'all') {
    const all: Article[] = [];
    for (const feed of feeds()) all.push(...(art[feed.id] || []));
    return all.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  }
  return art[selectedFeedId() || ''] || [];
}

export function registerAppProtocol(actions: ProtocolActions) {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;

  appApi.register({
    appId: 'rss-reader',
    name: 'RSS Reader',
    state: {
      unreadCount: { description: 'Total unread article count', handler: () => getTotalUnread() },
      feeds: {
        description: 'All feeds with unread counts',
        handler: () => feeds().map(f => ({
          id: f.id, name: f.name, url: f.url,
          unreadCount: unreadCounts()[f.id] || 0,
        })),
      },
      articles: {
        description: 'Current visible articles (max 50)',
        handler: (): Array<{ title: string; feedName: string; pubDate: string; isRead: boolean; link: string }> =>
          getCurrentArticles().slice(0, 50).map(a => ({
            title: a.title, feedName: a.feedName, pubDate: a.pubDate,
            isRead: readArticleIds().includes(a.id), link: a.link,
          })),
      },
      selectedArticle: {
        description: 'Currently selected article or null',
        handler: () => {
          const a = selectedArticle();
          return a ? { title: a.title, feedName: a.feedName, pubDate: a.pubDate, link: a.link } : null;
        },
      },
    },
    commands: {
      refresh: { description: 'Refresh all feeds', params: { type: 'object', properties: {} }, handler: async () => actions.refresh() },
      markAllRead: { description: 'Mark all visible articles as read', params: { type: 'object', properties: {} }, handler: () => actions.markAllRead() },
      selectFeed: {
        description: 'Select a feed by ID',
        params: { type: 'object', properties: { feedId: { type: 'string' } }, required: ['feedId'] },
        handler: (p: { feedId: string }) => actions.selectFeed(p.feedId),
      },
      addFeed: {
        description: 'Add a new feed by URL',
        params: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url'] },
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
