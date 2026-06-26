import { createStore } from '@bundled/solid-js/store';
import { createPersistedSignal } from '@bundled/yaar';
import type { Post, Comment, TabMode, Subscription, AppSettings } from './types';

const DEFAULT_SETTINGS: AppSettings = { refreshInterval: 300 };
export const [settings, setSettings] = createPersistedSignal<AppSettings>(
  'settings.json',
  DEFAULT_SETTINGS,
);

export const [state, setState] = createStore({
  // Feed
  posts: [] as Post[],
  loading: false,
  error: null as string | null,
  lastUpdated: null as Date | null,
  newPostCount: 0,
  countdown: 0,
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
  showSettings: false,

  // Subscriptions
  subscriptions: [] as Subscription[],
  selectedSub: null as Subscription | null,
});

// Tracks which post ids we've already seen on page 1 so doRefresh can surface a
// "N new posts" badge. Reset on tab/page change (different result set).
let knownPostIds = new Set<string>();

/** Forget the seen-post set so the next updatePosts() treats it as a fresh load. */
export function resetNewPostTracking(): void {
  knownPostIds = new Set<string>();
}

export function updatePosts(newPosts: Post[]): void {
  const onFirstPage = state.page === 1;
  const isFirstLoad = knownPostIds.size === 0;
  const newIds = new Set(newPosts.map((p) => p.id));
  let count = 0;

  if (onFirstPage && !isFirstLoad) {
    for (const id of newIds) {
      if (!knownPostIds.has(id)) count++;
    }
  }

  if (onFirstPage) knownPostIds = newIds;

  setState({
    posts: newPosts,
    newPostCount: onFirstPage ? count : 0,
    lastUpdated: new Date(),
  });
}
