const PREFS_KEY = 'prefs.json';

const _yaar = (window as any).yaar;

async function storageSave(path: string, content: string): Promise<void> {
  await _yaar.invoke(`yaar://apps/self/storage/${path}`, { action: 'write', content });
}

async function storageRead(path: string, as: 'text' | 'json' = 'text'): Promise<any> {
  const r = await _yaar.read(`yaar://apps/self/storage/${path}`);
  if (typeof r === 'string') return as === 'json' ? JSON.parse(r) : r;
  return as === 'json' ? r : JSON.stringify(r);
}

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
    if (!_yaar) return { ...DEFAULT_PREFS };
    const parsed = await storageRead(PREFS_KEY, 'json') as Partial<EditorPrefs> | null;
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
    if (!_yaar) return;
    await storageSave(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // no-op
  }
}
