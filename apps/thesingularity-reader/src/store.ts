import { createSignal, batch } from '@bundled/solid-js';
import type { Post, AppSettings } from './types';

const DEFAULT_SETTINGS: AppSettings = {
  refreshInterval: 300, // 5 minutes
};

export const [posts, setPosts] = createSignal<Post[]>([]);
export const [loading, setLoading] = createSignal(false);
export const [error, setError] = createSignal<string | null>(null);
export const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);
export const [newPostCount, setNewPostCount] = createSignal(0);
export const [settings, setSettings] = createSignal<AppSettings>(DEFAULT_SETTINGS);
export const [selectedPost, setSelectedPost] = createSignal<Post | null>(null);
export const [postContent, setPostContent] = createSignal<string | null>(null);
export const [postLoading, setPostLoading] = createSignal(false);
export const [countdown, setCountdown] = createSignal(0);
export const [showSettings, setShowSettings] = createSignal(false);

export async function loadSettings() {
  try {
    const saved = await window.yaar?.storage.read('thesingularity-reader/settings.json', { as: 'json' }).catch(() => null) as AppSettings | null;
    if (saved) {
      setSettings(saved);
    }
  } catch {
    // ignore
  }
}

export async function saveSettings(newSettings: AppSettings) {
  setSettings(newSettings);
  try {
    await window.yaar?.storage.save('thesingularity-reader/settings.json', JSON.stringify(newSettings));
  } catch {
    // ignore
  }
}

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

  batch(() => {
    setPosts(newPosts);
    setNewPostCount(count);
    setLastUpdated(new Date());
  });
}
