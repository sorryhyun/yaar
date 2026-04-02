import { createStore } from '@bundled/solid-js/store';
import type { Post, Comment, TabMode, Subscription } from './types';

export const [state, setState] = createStore({
  // Feed
  posts: [] as Post[],
  loading: false,
  error: null as string | null,
  lastUpdated: null as Date | null,
  page: 1,
  tabMode: 'recommend' as TabMode,

  // Post detail
  selectedPost: null as Post | null,
  postContent: null as string | null,
  postLoading: false,
  postError: null as string | null,

  // Comments
  comments: [] as Comment[],
  showComments: false,

  // Panel
  activePanel: 'feed' as 'feed' | 'subscriptions',

  // Subscriptions
  subscriptions: [] as Subscription[],
  selectedSub: null as Subscription | null,
});
