import DOMPurify from '@bundled/dompurify';
import * as z from '@bundled/zod';
import type { Feed, Article } from './types';
import { state, setState, showToast } from './store';
import { stripHtml, extractFirstImage } from './utils';
import { Rss2JsonResponse } from './schema';

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
  const parsed = z.safeParse(Rss2JsonResponse, await res.json());
  if (!parsed.success) {
    console.error('rss2json response failed validation', parsed.error.issues);
    throw new Error('The feed service returned an unsupported response.');
  }
  const json = parsed.data;
  if (json.status !== 'ok') throw new Error(json.message || 'Feed error');
  return (json.items ?? []).map((item) => {
    const raw = item.link || item.title || Math.random().toString();
    const id = `${feed.id}_${djb2Hash(raw)}`;
    return {
      id, feedId: feed.id, feedName: feed.name,
      title: item.title || 'Untitled', link: item.link || '',
      pubDate: item.pubDate || '', author: item.author || '',
      description: stripHtml(item.description || '').slice(0, 300),
      // Feed HTML is fully attacker-controlled (any URL can be added as a feed, and
      // rss2json passes item content through verbatim). Sanitize HERE, at ingestion,
      // so `state` only ever holds clean HTML and every present/future sink is safe by
      // construction.
      //
      // Deviation from the baseline `sanitize(dirty)` call: DOMPurify's default
      // allowlist permits <form> and form controls. Those are safe against XSS but not
      // against phishing — a hostile feed could render a credential form inside the
      // reader that POSTs to an attacker origin, visually indistinguishable from app
      // chrome. Article prose has no legitimate use for them, so drop them.
      content: DOMPurify.sanitize(item.content || item.description || '', {
        FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option'],
      }),
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

  const promises = state.feeds.map(async (feed) => {
    setState('loadingFeedIds', [...state.loadingFeedIds, feed.id]);
    const ef = { ...state.errorFeeds };
    ef[feed.id] = '';
    setState('errorFeeds', ef);

    try {
      const items = await fetchFeed(feed);
      localArticles[feed.id] = items;
      localUnreadCounts[feed.id] = items.filter(a => !state.readArticleIds.includes(a.id)).length;
    } catch (e: any) {
      localErrors[feed.id] = e.message || 'Failed to load';
      localArticles[feed.id] = [];
      localUnreadCounts[feed.id] = 0;
    } finally {
      setState('loadingFeedIds', state.loadingFeedIds.filter(id => id !== feed.id));
    }
  });

  await Promise.allSettled(promises);
  setState('articles', localArticles);
  setState('unreadCounts', localUnreadCounts);
  setState('errorFeeds', { ...state.errorFeeds, ...localErrors });
  isRefreshing = false;
}

export async function fetchSingleFeed(feed: Feed): Promise<void> {
  setState('loadingFeedIds', [...state.loadingFeedIds, feed.id]);
  const ef = { ...state.errorFeeds };
  ef[feed.id] = '';
  setState('errorFeeds', ef);

  try {
    const items = await fetchFeed(feed);
    setState('articles', { ...state.articles, [feed.id]: items });
    setState('unreadCounts', {
      ...state.unreadCounts,
      [feed.id]: items.filter(a => !state.readArticleIds.includes(a.id)).length,
    });
  } catch (e: any) {
    setState('errorFeeds', { ...state.errorFeeds, [feed.id]: e.message || 'Failed to load' });
    setState('articles', { ...state.articles, [feed.id]: [] });
    setState('unreadCounts', { ...state.unreadCounts, [feed.id]: 0 });
    showToast(`Failed to load: ${feed.name}`, 'error');
  } finally {
    setState('loadingFeedIds', state.loadingFeedIds.filter(id => id !== feed.id));
  }
}
