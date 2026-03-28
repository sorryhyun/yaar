import { createEffect } from '@bundled/solid-js';
import { createStore } from '@bundled/solid-js/store';
import { createPersistedSignal } from '@bundled/yaar';
import type { Post, AppSettings, Recommendation, Comment, Credentials } from './types';

const DEFAULT_SETTINGS: AppSettings = { refreshInterval: 300 };
export const [settings, setSettings] = createPersistedSignal<AppSettings>('settings.json', DEFAULT_SETTINGS);

const HIDE_SPAMMER_KEY = 'singularity-hide-spammer';

export const [state, setState] = createStore({
  // Feed
  posts: [] as Post[],
  loading: false,
  error: null as string | null,
  lastUpdated: null as Date | null,
  newPostCount: 0,
  countdown: 0,
  page: 1,

  // Post detail
  selectedPost: null as Post | null,
  postContent: null as string | null,
  postLoading: false,

  // Screenshot
  showOriginal: false,
  screenshotSrc: null as string | null,
  screenshotLoading: false,

  // Comments
  comments: [] as Comment[],
  commentsLoading: false,
  showComments: false,

  // Comment write
  commentSubmitting: false,
  commentText: '',

  // AI recommendation
  recommendation: null as Recommendation | null,
  recLoading: false,
  showRec: false,

  // UI
  showSettings: false,
  showLogin: false,
  hideSpammer: localStorage.getItem(HIDE_SPAMMER_KEY) !== 'false',
  filterKeyword: null as string | null,

  // Auth
  savedCredentials: null as Credentials | null,
  isLoggedIn: false,
  loginLoading: false,
});

createEffect(() => {
  localStorage.setItem(HIDE_SPAMMER_KEY, String(state.hideSpammer));
});

export function toggleHideSpammer() {
  setState('hideSpammer', !state.hideSpammer);
}

let knownPostIds = new Set<string>();

export function updatePosts(newPosts: Post[]) {
  const onFirstPage = state.page === 1;
  const isFirstLoad = knownPostIds.size === 0;
  const newIds = new Set(newPosts.map(p => p.id));
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
