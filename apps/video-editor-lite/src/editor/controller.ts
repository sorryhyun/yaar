import { EditorStore } from './state';
import { createEditorUI, renderEditor } from './ui';
import { clamp, parseNumber } from './utils/time';

const STORAGE_KEY = 'video-editor-lite:prefs';
const MIN_TRIM_GAP = 0.01;
const ALLOWED_PLAYBACK_RATES = new Set([0.5, 1, 1.5, 2]);
const STORAGE_VIDEO_FILE_RE = /\.(mp4|m4v|webm|mov|avi|mkv|ogv|ogg)$/i;
const STORAGE_SCAN_LIMIT = 200;
const STORAGE_URL_PREFIX = '/api/storage/';

type StorageEntry = {
  path: string;
  isDirectory: boolean;
};

type YaarStorageApi = {
  list: (dirPath?: string) => Promise<StorageEntry[]>;
  url?: (path: string) => string;
};

interface EditorPrefs {
  playbackRate: number;
  loopPreview: boolean;
  lastUrl: string;
  lastStoragePath: string;
}

const DEFAULT_PREFS: EditorPrefs = {
  playbackRate: 1,
  loopPreview: false,
  lastUrl: '',
  lastStoragePath: '',
};

function loadPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }

    const parsed = JSON.parse(raw) as Partial<EditorPrefs>;
    const playbackRate =
      typeof parsed.playbackRate === 'number' && ALLOWED_PLAYBACK_RATES.has(parsed.playbackRate)
        ? parsed.playbackRate
        : DEFAULT_PREFS.playbackRate;
    const loopPreview =
      typeof parsed.loopPreview === 'boolean' ? parsed.loopPreview : DEFAULT_PREFS.loopPreview;
    const lastUrl = typeof parsed.lastUrl === 'string' ? parsed.lastUrl : DEFAULT_PREFS.lastUrl;
    const lastStoragePath =
      typeof parsed.lastStoragePath === 'string'
        ? parsed.lastStoragePath
        : DEFAULT_PREFS.lastStoragePath;

    return {
      playbackRate,
      loopPreview,
      lastUrl,
      lastStoragePath,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: EditorPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // no-op; prefer functional editor even when storage is unavailable
  }
}

export function createEditorController(parent: HTMLElement): void {
  const store = new EditorStore();
  const ui = createEditorUI(parent);
  let activeObjectUrl: string | null = null;
  let prefs = loadPrefs();

  const persistPrefs = (patch: Partial<EditorPrefs>): void => {
    prefs = { ...prefs, ...patch };
    savePrefs(prefs);
  };

  const getStorageApi = (): YaarStorageApi | null => {
    const maybeStorage = (window as { yaar?: { storage?: unknown } }).yaar?.storage;
    if (!maybeStorage || typeof (maybeStorage as YaarStorageApi).list !== 'function') {
      return null;
    }
    return maybeStorage as YaarStorageApi;
  };

  const normalizeStoragePath = (path: string): string => {
    const trimmed = path.trim();
    if (!trimmed) {
      return '';
    }
    if (trimmed.startsWith(STORAGE_URL_PREFIX)) {
      return trimmed.slice(STORAGE_URL_PREFIX.length);
    }
    return trimmed.replace(/^\/+/, '');
  };

  const encodeStoragePath = (path: string): string =>
    path
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

  const toStorageUrl = (storagePath: string): string => {
    const normalizedPath = normalizeStoragePath(storagePath);
    const storageApi = getStorageApi();
    if (storageApi?.url) {
      return storageApi.url(normalizedPath);
    }
    return `${STORAGE_URL_PREFIX}${encodeStoragePath(normalizedPath)}`;
  };

  const collectStorageVideoPaths = async (
    storageApi: YaarStorageApi,
    dirPath = '',
    visited = new Set<string>(),
    collected: string[] = [],
  ): Promise<string[]> => {
    if (collected.length >= STORAGE_SCAN_LIMIT) {
      return collected;
    }

    const visitKey = dirPath || '/';
    if (visited.has(visitKey)) {
      return collected;
    }
    visited.add(visitKey);

    let entries: StorageEntry[] = [];
    try {
      entries = await storageApi.list(dirPath);
    } catch {
      return collected;
    }

    for (const entry of entries) {
      if (collected.length >= STORAGE_SCAN_LIMIT) {
        break;
      }

      if (entry.isDirectory) {
        await collectStorageVideoPaths(storageApi, entry.path, visited, collected);
        continue;
      }

      const path = normalizeStoragePath(entry.path);
      if (STORAGE_VIDEO_FILE_RE.test(path)) {
        collected.push(path);
      }
    }

    return collected;
  };

  const tryPickStorageVideo = async (): Promise<boolean> => {
    const storageApi = getStorageApi();
    if (!storageApi) {
      return false;
    }

    const storageVideos = await collectStorageVideoPaths(storageApi);
    if (!storageVideos.length) {
      return false;
    }

    storageVideos.sort((a, b) => a.localeCompare(b));
    const fallbackPath = storageVideos[0];
    const defaultPath = storageVideos.includes(prefs.lastStoragePath)
      ? prefs.lastStoragePath
      : fallbackPath;

    const previewList = storageVideos
      .slice(0, 12)
      .map((path, index) => `${index + 1}. ${path}`)
      .join('\n');
    const extraCount = storageVideos.length - 12;
    const extraText = extraCount > 0 ? `\n...and ${extraCount} more` : '';

    const selectionRaw = window.prompt(
      `Pick a storage video (number or path):\n${previewList}${extraText}`,
      defaultPath,
    );
    if (selectionRaw === null) {
      return false;
    }

    const selection = selectionRaw.trim();
    if (!selection) {
      return false;
    }

    let selectedPath = '';
    const selectedIndex = Number(selection);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= storageVideos.length) {
      selectedPath = storageVideos[selectedIndex - 1];
    } else {
      selectedPath = normalizeStoragePath(selection);
    }

    if (!selectedPath) {
      return false;
    }

    const storageUrl = toStorageUrl(selectedPath);
    releaseActiveObjectUrl();
    persistPrefs({
      lastStoragePath: selectedPath,
      lastUrl: storageUrl,
    });
    ui.urlInput.value = storageUrl;
    store.setSource('url', storageUrl, null);
    setVideoSource(storageUrl);
    return true;
  };

  const setVideoSource = (src: string): void => {
    ui.video.src = src;
    ui.video.playbackRate = prefs.playbackRate;
    ui.video.load();
  };

  const releaseActiveObjectUrl = (): void => {
    if (!activeObjectUrl) {
      return;
    }
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  };

  const seekBy = (deltaSeconds: number): void => {
    const duration = ui.video.duration || 0;
    if (duration <= 0) {
      return;
    }

    const nextTime = clamp((ui.video.currentTime || 0) + deltaSeconds, 0, duration);
    ui.video.currentTime = nextTime;
  };

  const togglePlayPause = async (): Promise<void> => {
    if (ui.video.paused) {
      await ui.video.play().catch(() => undefined);
      return;
    }
    ui.video.pause();
  };

  const applyTrimStart = (value: number): void => {
    if (Number.isNaN(value)) {
      return;
    }
    const ok = store.setTrim({ trimStart: value });
    if (!ok) {
      return;
    }

    const state = store.getState();
    if (ui.video.currentTime < state.trimStart || ui.video.currentTime > state.trimEnd) {
      ui.video.currentTime = state.trimStart;
    }
  };

  const applyTrimEnd = (value: number): void => {
    if (Number.isNaN(value)) {
      return;
    }
    const ok = store.setTrim({ trimEnd: value });
    if (!ok) {
      return;
    }

    const state = store.getState();
    if (ui.video.currentTime > state.trimEnd) {
      ui.video.currentTime = state.trimStart;
    }
  };

  const resetTrimToFullDuration = (): void => {
    const state = store.getState();
    if (state.duration <= 0) {
      return;
    }

    const ok = store.setTrim({ trimStart: 0, trimEnd: state.duration });
    if (!ok) {
      return;
    }

    ui.video.currentTime = 0;
  };

  const isTypingContext = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const tagName = target.tagName.toLowerCase();
    return (
      tagName === 'input' ||
      tagName === 'textarea' ||
      tagName === 'select' ||
      Boolean(target.closest('input, textarea, select'))
    );
  };

  ui.urlInput.value = prefs.lastUrl;
  ui.video.playbackRate = prefs.playbackRate;
  store.setPlaybackRate(prefs.playbackRate);
  store.setLoopPreview(prefs.loopPreview);

  ui.loadUrlButton.addEventListener('click', () => {
    const url = ui.urlInput.value.trim();
    if (!url) {
      return;
    }

    persistPrefs({ lastUrl: url });
    releaseActiveObjectUrl();
    store.setSource('url', url, null);
    setVideoSource(url);
  });

  ui.urlInput.addEventListener('change', () => {
    persistPrefs({ lastUrl: ui.urlInput.value.trim() });
  });

  ui.pickFileButton.addEventListener('click', async () => {
    const pickedFromStorage = await tryPickStorageVideo();
    if (pickedFromStorage) {
      return;
    }
    ui.fileInput.click();
  });

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    if (!file) {
      return;
    }

    releaseActiveObjectUrl();
    activeObjectUrl = URL.createObjectURL(file);
    store.setSource('file', file.name, activeObjectUrl);
    setVideoSource(activeObjectUrl);
  });

  ui.video.addEventListener('loadedmetadata', () => {
    store.setDuration(ui.video.duration || 0);
    ui.video.playbackRate = store.getState().playbackRate;
  });

  ui.video.addEventListener('timeupdate', () => {
    store.setCurrentTime(ui.video.currentTime || 0);

    const state = store.getState();
    if (state.loopPreview && ui.video.currentTime >= state.trimEnd) {
      ui.video.currentTime = state.trimStart;
      void ui.video.play();
    }
  });

  ui.video.addEventListener('play', () => {
    store.setPlaying(true);
  });

  ui.video.addEventListener('pause', () => {
    store.setPlaying(false);
  });

  ui.startRange.addEventListener('input', () => {
    applyTrimStart(parseNumber(ui.startRange.value));
  });

  ui.endRange.addEventListener('input', () => {
    applyTrimEnd(parseNumber(ui.endRange.value));
  });

  ui.startInput.addEventListener('change', () => {
    applyTrimStart(parseNumber(ui.startInput.value));
  });

  ui.endInput.addEventListener('change', () => {
    applyTrimEnd(parseNumber(ui.endInput.value));
  });

  ui.speedSelect.addEventListener('change', () => {
    const nextRate = parseNumber(ui.speedSelect.value);
    if (!ALLOWED_PLAYBACK_RATES.has(nextRate)) {
      ui.speedSelect.value = String(store.getState().playbackRate);
      return;
    }

    ui.video.playbackRate = nextRate;
    store.setPlaybackRate(nextRate);
    persistPrefs({ playbackRate: nextRate });
  });

  ui.loopButton.addEventListener('click', async () => {
    const state = store.getState();
    const nextLoop = !state.loopPreview;
    store.setLoopPreview(nextLoop);
    persistPrefs({ loopPreview: nextLoop });

    if (nextLoop) {
      ui.video.currentTime = state.trimStart;
      await ui.video.play().catch(() => undefined);
      return;
    }

    ui.video.pause();
  });

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (isTypingContext(event.target)) {
      return;
    }

    const state = store.getState();

    if (event.code === 'Space') {
      event.preventDefault();
      void togglePlayPause();
      return;
    }

    if (event.key === 'I' || event.key === 'i') {
      event.preventDefault();
      if (state.duration <= 0) {
        return;
      }
      const nextStart = Math.min(ui.video.currentTime || 0, Math.max(0, state.trimEnd - MIN_TRIM_GAP));
      applyTrimStart(nextStart);
      return;
    }

    if (event.key === 'O' || event.key === 'o') {
      event.preventDefault();
      if (state.duration <= 0) {
        return;
      }
      const nextEnd = Math.max(ui.video.currentTime || 0, state.trimStart + MIN_TRIM_GAP);
      applyTrimEnd(nextEnd);
      return;
    }

    if (event.key === 'X' || event.key === 'x') {
      event.preventDefault();
      resetTrimToFullDuration();
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.shiftKey ? 1 : 0.04;
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      seekBy(direction * step);
    }
  });

  store.subscribe((state) => {
    renderEditor(ui, state);
  });

  window.addEventListener('beforeunload', () => {
    releaseActiveObjectUrl();
  });
}
