import { createStore } from '@bundled/solid-js/store';
import type { Post, Comment, TabMode } from './types';

export const [state, setState] = createStore({
  // Feed
  posts: [] as Post[],
  loading: false,
  error: null as string | null,
  lastUpdated: null as Date | null,
  page: 1,
  tabMode: 'all' as TabMode,

  // Post detail
  selectedPost: null as Post | null,
  postContent: null as string | null,
  postLoading: false,
  postError: null as string | null,

  // Comments
  comments: [] as Comment[],
  showComments: false,
});
