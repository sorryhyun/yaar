import { setState, state, settings, updatePosts, resetNewPostTracking } from './store';
import { fetchPosts, fetchPostDetail } from './fetcher';
import type { Post, Comment, SeriesLink, Subscription } from './types';
import { errMsg } from '@bundled/yaar';
import {
  loadSubscriptions,
  saveSubscriptions,
  subscribe as subSubscribe,
  unsubscribe as subUnsubscribe,
  checkUpdates,
  checkAllUpdates,
  markAsRead,
} from './subscriptions';

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let fetchVersion = 0;

// In-memory cache for post detail results (body HTML + parsed comments), keyed
// by post.id. Avoids re-fetching when a user re-clicks an already-viewed post.
type CachedDetail = { content: string; comments: Comment[]; ts: number };
const POST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const POST_CACHE_MAX = 80;
const postDetailCache = new Map<string, CachedDetail>();

function cacheGet(id: string): CachedDetail | null {
  const hit = postDetailCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.ts > POST_CACHE_TTL) {
    postDetailCache.delete(id);
    return null;
  }
  return hit;
}

function cacheSet(id: string, content: string, comments: Comment[]): void {
  if (postDetailCache.size >= POST_CACHE_MAX) {
    const firstKey = postDetailCache.keys().next().value;
    if (firstKey) postDetailCache.delete(firstKey);
  }
  postDetailCache.set(id, { content, comments, ts: Date.now() });
}

export function clearTimers(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  refreshTimer = null;
  countdownTimer = null;
}

export async function doRefresh(): Promise<void> {
  if (state.loading) return;
  setState({ loading: true, error: null });
  try {
    const posts = await fetchPosts(state.tabMode, state.page);
    updatePosts(posts);
    setState({ loading: false, countdown: settings().refreshInterval });
  } catch (err) {
    setState({ error: errMsg(err), loading: false });
  }
}

/**
 * Drive periodic refresh + the header countdown off the persisted refresh
 * interval. Each tick refreshes only what the user is actively looking at and
 * never re-navigates the whole feed:
 *   - an open post  → re-fetch its comments
 *   - an open sub   → checkUpdates over HTTP
 * The feed list refreshes only on explicit action (mount, 갱신, tab/page change).
 */
export function startRefreshTimer(): void {
  clearTimers();
  const interval = settings().refreshInterval;
  setState('countdown', interval);

  refreshTimer = setInterval(() => {
    if (state.activePanel === 'feed' && state.selectedPost) {
      refreshOpenPost();
    } else if (state.activePanel === 'subscriptions' && state.selectedSub) {
      refreshSelectedSub();
    }
  }, interval * 1000);

  countdownTimer = setInterval(() => {
    setState('countdown', (c) => (c <= 1 ? settings().refreshInterval : c - 1));
  }, 1000);
}

export async function selectPost(post: Post): Promise<void> {
  if (state.selectedPost?.id === post.id && state.postContent) return;

  // Cache hit: instant render.
  const cached = cacheGet(post.id);
  if (cached) {
    ++fetchVersion;
    setState({
      selectedPost: post,
      postContent: cached.content,
      postLoading: false,
      postError: null,
      comments: cached.comments,
      showComments: false,
    });
    return;
  }

  const version = ++fetchVersion;
  setState({
    selectedPost: post,
    postContent: null,
    postLoading: true,
    postError: null,
    comments: [],
    showComments: false,
  });
  try {
    const { content, comments } = await fetchPostDetail(post);
    if (version !== fetchVersion) return;
    cacheSet(post.id, content, comments);
    setState({ postContent: content, comments, postLoading: false });
  } catch (err) {
    if (version !== fetchVersion) return;
    setState({ postError: errMsg(err), postLoading: false });
  }
}

/**
 * Re-fetch the currently-open post to surface new comments. Only the comments
 * are written back to state — the body HTML is left in place so the reader's
 * scroll position and already-loaded images aren't disrupted on each tick.
 */
export async function refreshOpenPost(): Promise<void> {
  const post = state.selectedPost;
  if (!post || state.postLoading) return;
  const version = fetchVersion;
  try {
    const { content, comments } = await fetchPostDetail(post);
    // Bail if the user navigated to a different post while we were fetching.
    if (version !== fetchVersion || state.selectedPost?.id !== post.id) return;
    cacheSet(post.id, content, comments);
    setState({ comments });
  } catch {
    // Keep the current comments on a failed refresh.
  }
}

export function setTab(mode: 'all' | 'recommend'): void {
  resetNewPostTracking();
  setState({ tabMode: mode, page: 1, posts: [], selectedPost: null, postContent: null });
  doRefresh();
}

export function setPage(page: number): void {
  resetNewPostTracking();
  setState({ page, posts: [], selectedPost: null, postContent: null });
  doRefresh();
}

export async function loadSubs(): Promise<void> {
  const subs = await loadSubscriptions();
  setState({ subscriptions: subs });
}

export async function subscribeSeries(link: SeriesLink): Promise<void> {
  await subSubscribe(link);
  const subs = await loadSubscriptions();
  setState({ subscriptions: subs });
}

export async function unsubscribeSeries(id: string): Promise<void> {
  await subUnsubscribe(id);
  const subs = await loadSubscriptions();
  setState({
    subscriptions: subs,
    selectedSub: state.selectedSub?.id === id ? null : state.selectedSub,
  });
}

/**
 * Explicit "refresh all" — only run on direct user action (the 갱신 button),
 * never on the background timer.
 */
export async function refreshAllSubs(): Promise<void> {
  if (state.subscriptions.length === 0) return;
  const updated = await checkAllUpdates(state.subscriptions);
  setState({ subscriptions: updated });
}

/** Refresh just the currently-open subscription. */
export async function refreshSelectedSub(): Promise<void> {
  const sel = state.selectedSub;
  if (!sel) return;
  try {
    const fresh = await checkUpdates(sel);
    const subs = state.subscriptions.map((s) => (s.id === fresh.id ? fresh : s));
    setState({ subscriptions: subs, selectedSub: fresh });
    await saveSubscriptions(subs);
  } catch {
    // Keep the cached posts on a failed refresh.
  }
}

export async function openSubDetail(sub: Subscription): Promise<void> {
  setState({ selectedSub: sub });
  // Fetch this single subscription's latest posts on demand rather than
  // relying on a background sweep of every subscription.
  let subs = state.subscriptions;
  try {
    const fresh = await checkUpdates(sub);
    subs = subs.map((s) => (s.id === fresh.id ? fresh : s));
    setState({ subscriptions: subs, selectedSub: fresh });
  } catch {
    // Fall back to cached posts if the on-demand fetch fails.
  }
  const updated = await markAsRead(subs, sub.id);
  setState({ subscriptions: updated, selectedSub: updated.find((s) => s.id === sub.id) ?? null });
}

export function closeSubDetail(): void {
  setState({ selectedSub: null });
}
