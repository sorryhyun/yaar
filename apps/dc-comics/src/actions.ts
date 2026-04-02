import { setState, state } from './store';
import { fetchPosts, fetchPostDetail } from './fetcher';
import type { Post, SeriesLink, Subscription } from './types';
import { errMsg } from '@bundled/yaar';
import {
  loadSubscriptions,
  subscribe as subSubscribe,
  unsubscribe as subUnsubscribe,
  checkAllUpdates,
  markAsRead,
} from './subscriptions';

export async function doRefresh(): Promise<void> {
  setState({ loading: true, error: null });
  try {
    const posts = await fetchPosts(state.tabMode, state.page);
    setState({ posts, lastUpdated: new Date(), loading: false });
  } catch (err) {
    setState({ error: errMsg(err), loading: false });
  }
}

export async function selectPost(post: Post): Promise<void> {
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
    setState({ postContent: content, comments, postLoading: false });
  } catch (err) {
    setState({ postError: errMsg(err), postLoading: false });
  }
}

export function setTab(mode: 'all' | 'recommend'): void {
  setState({ tabMode: mode, page: 1, posts: [], selectedPost: null, postContent: null });
  doRefresh();
}

export function setPage(page: number): void {
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
  setState({ subscriptions: subs, selectedSub: state.selectedSub?.id === id ? null : state.selectedSub });
}

export async function refreshAllSubs(): Promise<void> {
  if (state.subscriptions.length === 0) return;
  const updated = await checkAllUpdates(state.subscriptions);
  setState({ subscriptions: updated });
}

export async function openSubDetail(sub: Subscription): Promise<void> {
  setState({ selectedSub: sub });
  const updated = await markAsRead(state.subscriptions, sub.id);
  setState({ subscriptions: updated, selectedSub: updated.find((s) => s.id === sub.id) ?? null });
}

export function closeSubDetail(): void {
  setState({ selectedSub: null });
}
