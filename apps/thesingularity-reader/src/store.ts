import { createSignal, batch } from '@bundled/solid-js';
import type { Post, AppSettings, Recommendation } from './types';
import { storage } from '@bundled/yaar';

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

// 원본 보기 (screenshot)
export const [showOriginal, setShowOriginal] = createSignal(false);
export const [screenshotSrc, setScreenshotSrc] = createSignal<string | null>(null);
export const [screenshotLoading, setScreenshotLoading] = createSignal(false);

// 도배기 안 보기 (localStorage에 저장)
const HIDE_SPAMMER_KEY = 'singularity-hide-spammer';
const savedHideSpammer = localStorage.getItem(HIDE_SPAMMER_KEY);
export const [hideSpammer, setHideSpammer] = createSignal<boolean>(
  savedHideSpammer !== null ? savedHideSpammer === 'true' : true
);

export function toggleHideSpammer() {
  const next = !hideSpammer();
  setHideSpammer(next);
  localStorage.setItem(HIDE_SPAMMER_KEY, String(next));
}

// AI 추천
export const [recommendation, setRecommendation] = createSignal<Recommendation | null>(null);
export const [recLoading, setRecLoading] = createSignal(false);
export const [showRec, setShowRec] = createSignal(false);

// 키워드 필터 (파던 주제 클릭 시)
export const [filterKeyword, setFilterKeyword] = createSignal<string | null>(null);

export async function loadSettings() {
  if (!storage) return;
  try {
    const saved = await storage.read('settings.json', { as: 'json' }).catch(() => null) as AppSettings | null;
    if (saved) {
      setSettings(saved);
    }
  } catch {
    // ignore
  }
}

export async function saveSettings(newSettings: AppSettings) {
  setSettings(newSettings);
  if (!storage) return;
  try {
    await storage.save('settings.json', JSON.stringify(newSettings));
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
