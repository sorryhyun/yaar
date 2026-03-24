import type { Article } from './types';
import { state } from './store';
import { app } from '@bundled/yaar';

export interface ProtocolActions {
  refresh: () => Promise<{ ok: boolean; totalUnread: number }>;
  markAllRead: () => { ok: boolean };
  selectFeed: (feedId: string) => { ok: boolean };
  addFeed: (url: string, name?: string) => Promise<{ ok: boolean; feedId: string }>;
}

function getTotalUnread(): number {
  const vals = Object.values(state.unreadCounts) as number[];
  return vals.reduce((a, b) => a + b, 0);
}

function getCurrentArticles(): Article[] {
  const art = state.articles;
  if (state.selectedFeedId === 'all') {
    const all: Article[] = [];
    for (const feed of state.feeds) all.push(...(art[feed.id] || []));
    return all.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  }
  return art[state.selectedFeedId || ''] || [];
}

export function registerAppProtocol(actions: ProtocolActions) {
  if (!app) return;

  app.register({
    appId: 'rss-reader',
    name: 'RSS Reader',
    state: {
      unreadCount: { description: 'Total unread article count', handler: () => getTotalUnread() },
      feeds: {
        description: 'All feeds with unread counts',
        handler: () => state.feeds.map(f => ({
          id: f.id, name: f.name, url: f.url,
          unreadCount: state.unreadCounts[f.id] || 0,
        })),
      },
      articles: {
        description: 'Current visible articles (max 50)',
        handler: (): Array<{ title: string; feedName: string; pubDate: string; isRead: boolean; link: string }> =>
          getCurrentArticles().slice(0, 50).map(a => ({
            title: a.title, feedName: a.feedName, pubDate: a.pubDate,
            isRead: state.readArticleIds.includes(a.id), link: a.link,
          })),
      },
      selectedArticle: {
        description: 'Currently selected article or null',
        handler: () => {
          const a = state.selectedArticle;
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
        handler: (p: Record<string, unknown>) => actions.selectFeed(p.feedId as string),
      },
      addFeed: {
        description: 'Add a new feed by URL',
        params: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url'] },
        handler: (p: Record<string, unknown>) => actions.addFeed(p.url as string, p.name as string | undefined),
      },
    },
  });
}

export function notifyUnreadUpdate(totalUnread: number) {
  if (!app) return;
  app.sendInteraction({ event: 'unread_update', totalUnread });
}
