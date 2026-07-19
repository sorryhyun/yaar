import { createEffect } from '@bundled/solid-js';
import { createStore } from '@bundled/solid-js/store';
import { appStorage, createPersistedSignal } from '@bundled/yaar';
import type { Post, AppSettings, Recommendation, Comment, Credentials, SearchType } from './types';

const DEFAULT_SETTINGS: AppSettings = { refreshInterval: 300 };
export const [settings, setSettings] = createPersistedSignal<AppSettings>('settings.json', DEFAULT_SETTINGS);

const HIDE_SPAMMER_KEY = 'hide-spammer.json';
const HIDE_SPAMMER_DEFAULT = true;

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

  // Post write (new post)
  showWrite: false,
  writeTitle: '',
  writeContent: '',
  writeCategory: null as string | null,
  writeSubmitting: false,

  // AI recommendation
  recommendation: null as Recommendation | null,
  recLoading: false,
  showRec: false,

  // UI
  showSettings: false,
  showLogin: false,
  hideSpammer: HIDE_SPAMMER_DEFAULT,
  filterKeyword: null as string | null,
  selectedCategory: null as string | null,

  // Search (DCinside in-gallery search)
  searchActive: false,
  searchKeyword: '',
  searchType: 'subject_m' as SearchType,

  // Auth
  savedCredentials: null as Credentials | null,
  isLoggedIn: false,
  loginLoading: false,
});

// `hideSpammer` lives in the store rather than a signal, so it can't use
// createPersistedSignal. Mirror its guard instead: the store starts at the
// default, the stored value arrives asynchronously, and a user toggle that
// lands first wins over the late-arriving load.
let hideSpammerWritten = false;
let hideSpammerLoaded = false;

void appStorage
  .readJsonOr<boolean>(HIDE_SPAMMER_KEY, HIDE_SPAMMER_DEFAULT)
  .then((stored) => {
    if (!hideSpammerWritten) setState('hideSpammer', stored);
    hideSpammerLoaded = true;
  });

createEffect(() => {
  const value = state.hideSpammer;
  // Don't let the initial default overwrite a stored value still in flight.
  if (!hideSpammerLoaded && !hideSpammerWritten) return;
  void appStorage.trySave(HIDE_SPAMMER_KEY, JSON.stringify(value), {
    label: 'hide spammer setting',
  });
});

export function toggleHideSpammer() {
  hideSpammerWritten = true;
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
