import { createEffect } from '@bundled/solid-js';
import { createStore } from '@bundled/solid-js/store';
import { createPersistedSignal } from '@bundled/yaar';
import type { Post, AppSettings, Recommendation, Comment } from './types';

// ── Persisted settings (auto-load + auto-save) ──────────────────────────────
const DEFAULT_SETTINGS: AppSettings = { refreshInterval: 300 };
export const [settings, setSettings] = createPersistedSignal<AppSettings>('settings.json', DEFAULT_SETTINGS);

// ── Main app state (one store replaces 23 signals) ──────────────────────────
const HIDE_SPAMMER_KEY = 'singularity-hide-spammer';

export const [state, setState] = createStore({
  // Feed
  posts: [] as Post[],
  loading: false,
  error: null as string | null,
  lastUpdated: null as Date | null,
  newPostCount: 0,
  countdown: 0,

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

  // AI recommendation
  recommendation: null as Recommendation | null,
  recLoading: false,
  showRec: false,

  // UI
  showSettings: false,
  hideSpammer: localStorage.getItem(HIDE_SPAMMER_KEY) !== 'false',
  filterKeyword: null as string | null,
});

// Auto-sync hideSpammer to localStorage
createEffect(() => {
  localStorage.setItem(HIDE_SPAMMER_KEY, String(state.hideSpammer));
});

export function toggleHideSpammer() {
  setState('hideSpammer', !state.hideSpammer);
}

// ── Post update logic (tracks new post IDs) ─────────────────────────────────
let knownPostIds = new Set<string>();

export function updatePosts(newPosts: Post[]) {
  const isFirstLoad = knownPostIds.size === 0;
  const newIds = new Set(newPosts.map(p => p.id));
  let count = 0;

  if (!isFirstLoad) {
    for (const id of newIds) {
      if (!knownPostIds.has(id)) count++;
    }
  }

  knownPostIds = newIds;

  setState({
    posts: newPosts,
    newPostCount: count,
    lastUpdated: new Date(),
  });
}
