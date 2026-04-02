import { invoke, read } from '@bundled/yaar';
import type { Subscription, SeriesLink, SeriesPost } from './types';

const STORAGE_KEY = 'yaar://storage/dc-comics/subscriptions.json';

export async function loadSubscriptions(): Promise<Subscription[]> {
  try {
    const result = await read(STORAGE_KEY) as { ok: boolean; data?: string };
    if (!result?.ok || !result.data) return [];
    return JSON.parse(result.data) as Subscription[];
  } catch {
    return [];
  }
}

export async function saveSubscriptions(subs: Subscription[]): Promise<void> {
  await invoke(STORAGE_KEY, { method: 'PUT', body: JSON.stringify(subs) });
}

function extractGallId(url: string): string {
  const match = url.match(/[?&]id=([^&]+)/);
  return match ? match[1] : '';
}

function urlToId(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
}

async function fetchSeriesPosts(url: string): Promise<SeriesPost[]> {
  try {
    const result = await invoke('yaar://http', {
      url,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' },
    }) as { ok: boolean; data?: string };
    const html = result?.data ?? '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('tr.ub-content'));
    const posts: SeriesPost[] = [];
    for (const row of rows) {
      const noAttr = row.getAttribute('data-no');
      if (!noAttr) continue;
      const titleEl = row.querySelector('.gall-tit a, td.gall-tit a');
      const dateEl = row.querySelector('.gall-date, td.gall-date');
      const title = (titleEl?.textContent ?? '').trim() || '(제목 없음)';
      const date = (dateEl?.textContent ?? '').trim();
      posts.push({ id: noAttr, title, date, isNew: false });
    }
    return posts;
  } catch {
    return [];
  }
}

export async function subscribe(seriesLink: SeriesLink): Promise<Subscription> {
  const subs = await loadSubscriptions();
  const existing = subs.find((s) => s.url === seriesLink.url);
  if (existing) return existing;

  const gallId = extractGallId(seriesLink.url);
  const posts = await fetchSeriesPosts(seriesLink.url);
  const lastPostId = posts[0]?.id ?? '';

  const sub: Subscription = {
    id: urlToId(seriesLink.url),
    title: seriesLink.title,
    url: seriesLink.url,
    gallId,
    lastPostId,
    subscribedAt: new Date().toISOString(),
    unreadCount: 0,
    latestPosts: posts.slice(0, 20).map((p) => ({ ...p, isNew: false })),
  };

  subs.push(sub);
  await saveSubscriptions(subs);
  return sub;
}

export async function unsubscribe(id: string): Promise<void> {
  const subs = await loadSubscriptions();
  await saveSubscriptions(subs.filter((s) => s.id !== id));
}

export async function checkUpdates(sub: Subscription): Promise<Subscription> {
  const posts = await fetchSeriesPosts(sub.url);
  const markedPosts = posts.slice(0, 20).map((p) => ({
    ...p,
    isNew: sub.lastPostId ? Number(p.id) > Number(sub.lastPostId) : false,
  }));
  const unreadCount = markedPosts.filter((p) => p.isNew).length;
  return { ...sub, latestPosts: markedPosts, unreadCount };
}

export async function checkAllUpdates(subs: Subscription[]): Promise<Subscription[]> {
  const updated: Subscription[] = [];
  for (const sub of subs) {
    try {
      updated.push(await checkUpdates(sub));
    } catch {
      updated.push(sub);
    }
  }
  await saveSubscriptions(updated);
  return updated;
}

export async function markAsRead(subs: Subscription[], subId: string): Promise<Subscription[]> {
  const updated = subs.map((s) => {
    if (s.id !== subId) return s;
    const latestId = s.latestPosts[0]?.id ?? s.lastPostId;
    return {
      ...s,
      unreadCount: 0,
      lastPostId: latestId,
      latestPosts: s.latestPosts.map((p) => ({ ...p, isNew: false })),
    };
  });
  await saveSubscriptions(updated);
  return updated;
}