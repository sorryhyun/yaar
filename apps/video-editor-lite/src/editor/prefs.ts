import { createPersistedSignal, appStorage } from '@bundled/yaar';

export interface EditorPrefs {
  playbackRate: number;
  loopPreview: boolean;
  lastUrl: string;
  lastStoragePath: string;
  lastStorageListPath: string;
}

export const ALLOWED_PLAYBACK_RATES = new Set([0.5, 1, 1.5, 2]);

const PREFS_KEY = 'prefs.json';

export const DEFAULT_PREFS: EditorPrefs = {
  playbackRate: 1,
  loopPreview: false,
  lastUrl: '',
  lastStoragePath: '',
  lastStorageListPath: 'mounts/lecture-materials',
};

// Signal: auto-persists to storage on every setPrefs() call.
// savePrefs() is no longer needed — just call setPrefs(prev => ({ ...prev, patch })).
export const [prefs, setPrefs] = createPersistedSignal<EditorPrefs>(PREFS_KEY, DEFAULT_PREFS);

/** Awaitable startup loader with field validation (used once in main.ts init block). */
export async function loadPrefs(): Promise<EditorPrefs> {
  const raw = await appStorage.readJsonOr<Partial<EditorPrefs>>(PREFS_KEY, {});
  return {
    playbackRate: ALLOWED_PLAYBACK_RATES.has(raw.playbackRate as number)
      ? (raw.playbackRate as number) : DEFAULT_PREFS.playbackRate,
    loopPreview: typeof raw.loopPreview === 'boolean'
      ? raw.loopPreview : DEFAULT_PREFS.loopPreview,
    lastUrl: typeof raw.lastUrl === 'string'
      ? raw.lastUrl : DEFAULT_PREFS.lastUrl,
    lastStoragePath: typeof raw.lastStoragePath === 'string'
      ? raw.lastStoragePath : DEFAULT_PREFS.lastStoragePath,
    lastStorageListPath: (typeof raw.lastStorageListPath === 'string' && raw.lastStorageListPath.trim())
      ? raw.lastStorageListPath : DEFAULT_PREFS.lastStorageListPath,
  };
}
