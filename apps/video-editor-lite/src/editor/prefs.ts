const PREFS_KEY = 'video-editor-lite/prefs.json';
const storage = (window as any).yaar?.storage;

export const ALLOWED_PLAYBACK_RATES = new Set([0.5, 1, 1.5, 2]);

export interface EditorPrefs {
  playbackRate: number;
  loopPreview: boolean;
  lastUrl: string;
  lastStoragePath: string;
  lastStorageListPath: string;
}

export const DEFAULT_PREFS: EditorPrefs = {
  playbackRate: 1,
  loopPreview: false,
  lastUrl: '',
  lastStoragePath: '',
  lastStorageListPath: 'mounts/lecture-materials',
};

export async function loadPrefs(): Promise<EditorPrefs> {
  try {
    const parsed = await storage?.read(PREFS_KEY, { as: 'json' }) as Partial<EditorPrefs> | null;
    if (!parsed) return { ...DEFAULT_PREFS };

    const playbackRate =
      typeof parsed.playbackRate === 'number' && ALLOWED_PLAYBACK_RATES.has(parsed.playbackRate)
        ? parsed.playbackRate : DEFAULT_PREFS.playbackRate;
    const loopPreview =
      typeof parsed.loopPreview === 'boolean' ? parsed.loopPreview : DEFAULT_PREFS.loopPreview;
    const lastUrl = typeof parsed.lastUrl === 'string' ? parsed.lastUrl : DEFAULT_PREFS.lastUrl;
    const lastStoragePath =
      typeof parsed.lastStoragePath === 'string' ? parsed.lastStoragePath : DEFAULT_PREFS.lastStoragePath;
    const lastStorageListPath =
      typeof parsed.lastStorageListPath === 'string' && parsed.lastStorageListPath.trim()
        ? parsed.lastStorageListPath : DEFAULT_PREFS.lastStorageListPath;

    return { playbackRate, loopPreview, lastUrl, lastStoragePath, lastStorageListPath };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function savePrefs(prefs: EditorPrefs): Promise<void> {
  try {
    await storage?.save(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // no-op
  }
}
