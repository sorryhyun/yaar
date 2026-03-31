import { setState, state } from './store';
import { fetchPosts, fetchPostDetail } from './fetcher';
import type { Post } from './types';
import { errMsg } from '@bundled/yaar';

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
