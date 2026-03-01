import { EditorStore } from './state';
import { createEditorUI, renderEditor } from './ui';
import { clamp, parseNumber } from './utils/time';
import type { Composition } from '../core/types';
import { DEFAULT_CONFIG } from '../core/types';
import { createScene } from '../core/scene-registry';
import type { SceneProps } from '../core/scene-registry';
import { PreviewPlayer } from '../player/preview-player';
import { exportComposition, downloadBlob } from '../player/exporter';

// Register all scene types (side-effect imports)
import '../scenes/solid';
import '../scenes/text';
import '../scenes/shape';
import '../scenes/image';
import '../scenes/video-clip';

const STORAGE_KEY = 'video-editor-lite:prefs';
const MIN_TRIM_GAP = 0.01;
const ALLOWED_PLAYBACK_RATES = new Set([0.5, 1, 1.5, 2]);
const STORAGE_VIDEO_FILE_RE = /\.(mp4|m4v|webm|mov|avi|mkv|ogv|ogg)$/i;
const DEFAULT_STORAGE_LIST_PATH = 'mounts/lecture-materials';
const STORAGE_SCAN_LIMIT = 200;
const STORAGE_URL_PREFIX = '/api/storage/';
const EXPORT_PROGRESS_TICK_MS = 120;
const EXPORT_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const;

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
  lastStorageListPath: string;
}

const DEFAULT_PREFS: EditorPrefs = {
  playbackRate: 1,
  loopPreview: false,
  lastUrl: '',
  lastStoragePath: '',
  lastStorageListPath: DEFAULT_STORAGE_LIST_PATH,
};

export interface EditorControllerApi {
  getCurrentSource: () => { sourceKind: 'url' | 'file' | null; sourceValue: string; objectUrl: string | null };
  getPlaybackState: () => { playing: boolean; paused: boolean; playbackRate: number; loopPreview: boolean };
  getTimeline: () => { currentTime: number; duration: number };
  getTrimRange: () => { trimStart: number; trimEnd: number; selectedDuration: number };
  loadSource: (params: { url?: string; path?: string }) => { ok: true; source: string };
  play: () => Promise<{ ok: true }>;
  pause: () => { ok: true };
  seek: (time: number) => { ok: true; currentTime: number };
  setPlaybackRate: (rate: number) => { ok: true; playbackRate: number };
  // Creator mode API
  createComposition: (params: { width?: number; height?: number; fps?: number; durationInFrames?: number }) => { ok: true; config: Composition['config'] };
  addScene: (params: { type: string; from?: number; durationInFrames?: number; props?: SceneProps }) => { ok: true; sceneId: string };
  updateScene: (params: { id: string; from?: number; durationInFrames?: number; props?: SceneProps }) => { ok: true };
  removeScene: (params: { id: string }) => { ok: true };
  reorderScenes: (params: { ids: string[] }) => { ok: true };
  getComposition: () => { composition: Composition | null };
  preview: () => { ok: true };
  exportVideo: () => Promise<{ ok: true }>;
}

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
    const lastStorageListPath =
      typeof parsed.lastStorageListPath === 'string' && parsed.lastStorageListPath.trim()
        ? parsed.lastStorageListPath
        : DEFAULT_PREFS.lastStorageListPath;

    return {
      playbackRate,
      loopPreview,
      lastUrl,
      lastStoragePath,
      lastStorageListPath,
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

function pickExportMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }

  for (const candidate of EXPORT_MIME_CANDIDATES) {
    if (!candidate || MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return '';
}

function exportExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) {
    return 'mp4';
  }
  return 'webm';
}

function makeExportFilename(extension: string, prefix = 'trim'): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${prefix}-${stamp}.${extension}`;
}

let sceneIdCounter = 0;
function nextSceneId(): string {
  return `s${++sceneIdCounter}${Date.now().toString(36)}`;
}

export function createEditorController(parent: HTMLElement): EditorControllerApi {
  const store = new EditorStore();
  const ui = createEditorUI(parent);
  let activeObjectUrl: string | null = null;
  let exportingInProgress = false;
  let prefs = loadPrefs();
  let previewPlayer: PreviewPlayer | null = null;
  let currentStorageFiles: string[] = [];

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

    const entries = await storageApi.list(dirPath);

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

  const setSidebarMessage = (message: string): void => {
    ui.fileListStatus.textContent = message;
  };

  const clearSidebarList = (): void => {
    ui.fileList.textContent = '';
  };

  const applyFileFilter = (): void => {
    const query = ui.fileSearch.value.trim().toLowerCase();
    const filtered = query
      ? currentStorageFiles.filter((p) => p.toLowerCase().includes(query))
      : currentStorageFiles;

    clearSidebarList();

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'storage-empty';
      empty.textContent = query ? `No files match "${query}".` : 'No video files found in this path.';
      ui.fileList.appendChild(empty);
      return;
    }

    for (const path of filtered) {
      const segments = path.split('/');
      const filename = segments.pop() ?? path;
      const dir = segments.length ? segments.join('/') + '/' : '';

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'storage-item';
      item.title = path;

      const nameEl = document.createElement('div');
      nameEl.className = 'file-name';
      nameEl.textContent = '▶  ' + filename;
      item.appendChild(nameEl);

      if (dir) {
        const dirEl = document.createElement('div');
        dirEl.className = 'file-dir';
        dirEl.textContent = dir;
        item.appendChild(dirEl);
      }

      item.addEventListener('click', () => {
        const loaded = loadSourceUrl(toStorageUrl(path), path);
        if (loaded) {
          setSidebarMessage(`Loaded: ${filename}`);
          ui.fileList.querySelectorAll<HTMLElement>('.storage-item').forEach((el) =>
            el.classList.remove('active'),
          );
          item.classList.add('active');
        }
      });

      ui.fileList.appendChild(item);
    }
  };

  const renderSidebarFiles = (paths: string[]): void => {
    currentStorageFiles = [...paths];
    applyFileFilter();
  };

  const refreshStorageList = async (): Promise<void> => {
    const storageApi = getStorageApi();
    if (!storageApi) {
      clearSidebarList();
      setSidebarMessage('Storage API unavailable in this environment.');
      return;
    }

    const basePath = normalizeStoragePath(ui.storagePathInput.value) || DEFAULT_STORAGE_LIST_PATH;
    ui.storagePathInput.value = basePath;
    persistPrefs({ lastStorageListPath: basePath });

    ui.refreshFilesButton.disabled = true;
    setSidebarMessage(`Scanning ${basePath}...`);

    try {
      const storageVideos = await collectStorageVideoPaths(storageApi, basePath);
      storageVideos.sort((a, b) => a.localeCompare(b));
      renderSidebarFiles(storageVideos);
      setSidebarMessage(`Found ${storageVideos.length} video file${storageVideos.length === 1 ? '' : 's'} in ${basePath}.`);
    } catch {
      clearSidebarList();
      setSidebarMessage(`Unable to list files in ${basePath}.`);
    } finally {
      ui.refreshFilesButton.disabled = false;
    }
  };

  const tryPickStorageVideo = async (): Promise<boolean> => {
    const storageApi = getStorageApi();
    if (!storageApi) {
      return false;
    }

    let storageVideos: string[] = [];
    try {
      storageVideos = await collectStorageVideoPaths(storageApi);
    } catch {
      return false;
    }

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
    return loadSourceUrl(storageUrl, selectedPath);
  };

  const setVideoSource = (src: string): void => {
    ui.video.src = src;
    ui.video.playbackRate = prefs.playbackRate;
    ui.video.load();
  };

  const loadSourceUrl = (url: string, storagePath: string | null = null): boolean => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      return false;
    }

    releaseActiveObjectUrl();
    const prefsPatch: Partial<EditorPrefs> = { lastUrl: trimmedUrl };
    if (storagePath !== null) {
      prefsPatch.lastStoragePath = normalizeStoragePath(storagePath);
    }
    persistPrefs(prefsPatch);
    ui.urlInput.value = trimmedUrl;
    store.setSource('url', trimmedUrl, null);
    setVideoSource(trimmedUrl);
    return true;
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

  const waitForLoadedMetadata = (video: HTMLVideoElement): Promise<void> => {
    if (video.readyState >= 1) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        reject(new Error('Unable to read video metadata for export.'));
      };

      const cleanup = (): void => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  };

  const exportTrimmedSegment = async (): Promise<void> => {
    if (exportingInProgress) {
      return;
    }

    const state = store.getState();
    if (state.duration <= 0) {
      store.setExportState({ exportMessage: 'Load a video before exporting.' });
      return;
    }

    const trimStart = clamp(state.trimStart, 0, state.duration);
    const trimEnd = clamp(state.trimEnd, 0, state.duration);
    const selectedDuration = trimEnd - trimStart;
    if (selectedDuration <= MIN_TRIM_GAP) {
      store.setExportState({ exportMessage: 'Trim range is too small to export.' });
      return;
    }

    const sourceUrl = ui.video.currentSrc || ui.video.src;
    if (!sourceUrl) {
      store.setExportState({ exportMessage: 'No active media source to export.' });
      return;
    }

    const mimeType = pickExportMimeType();
    if (typeof MediaRecorder === 'undefined') {
      store.setExportState({ exportMessage: 'MediaRecorder is not available in this browser.' });
      return;
    }

    const wasPlaying = !ui.video.paused;
    const resumeTime = ui.video.currentTime || 0;

    const exporterVideo = document.createElement('video');
    exporterVideo.src = sourceUrl;
    exporterVideo.preload = 'auto';
    exporterVideo.playsInline = true;
    exporterVideo.muted = true;
    exporterVideo.volume = 0;

    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let progressTimer = 0;

    exportingInProgress = true;
    store.setExportState({
      exporting: true,
      exportProgress: 0,
      exportMessage: 'Preparing export...',
    });

    try {
      await waitForLoadedMetadata(exporterVideo);
      exporterVideo.currentTime = trimStart;

      const streamVideo = exporterVideo as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captureStreamFn =
        streamVideo.captureStream?.bind(streamVideo) ?? streamVideo.mozCaptureStream?.bind(streamVideo);
      if (!captureStreamFn) {
        throw new Error('This browser does not support capturing media streams from video.');
      }

      stream = captureStreamFn() as MediaStream;

      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      });

      const stopped = new Promise<void>((resolve, reject) => {
        recorder!.addEventListener('stop', () => resolve(), { once: true });
        recorder!.addEventListener('error', () => reject(new Error('Recorder failed while exporting.')), {
          once: true,
        });
      });

      recorder.start(250);

      progressTimer = window.setInterval(() => {
        const elapsed = clamp(exporterVideo.currentTime - trimStart, 0, selectedDuration);
        const progress = clamp(elapsed / selectedDuration, 0, 1);
        store.setExportState({
          exportProgress: progress,
          exportMessage: `Exporting ${Math.round(progress * 100)}%`,
        });

        if (exporterVideo.currentTime >= trimEnd - 0.01 && recorder && recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, EXPORT_PROGRESS_TICK_MS);

      await exporterVideo.play();
      await stopped;

      const blobType = mimeType || recorder.mimeType || 'video/webm';
      const outputBlob = new Blob(chunks, { type: blobType });
      if (outputBlob.size <= 0) {
        throw new Error('Export produced an empty file.');
      }

      const extension = exportExtensionFromMimeType(blobType);
      const anchor = document.createElement('a');
      const downloadUrl = URL.createObjectURL(outputBlob);
      anchor.href = downloadUrl;
      anchor.download = makeExportFilename(extension);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);

      store.setExportState({
        exporting: false,
        exportProgress: 1,
        exportMessage: `Export complete. Downloaded ${selectedDuration.toFixed(2)}s clip.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown export error.';
      store.setExportState({
        exporting: false,
        exportProgress: 0,
        exportMessage: `Export failed: ${message}`,
      });
    } finally {
      exportingInProgress = false;
      window.clearInterval(progressTimer);
      exporterVideo.pause();
      exporterVideo.removeAttribute('src');
      exporterVideo.load();

      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      stream?.getTracks().forEach((track) => track.stop());

      ui.video.currentTime = clamp(resumeTime, 0, state.duration);
      if (wasPlaying) {
        await ui.video.play().catch(() => undefined);
      }
    }
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

  // === Creator mode helpers ===

  const ensureComposition = (): Composition => {
    const state = store.getState();
    if (state.composition) return state.composition;
    const comp: Composition = { config: { ...DEFAULT_CONFIG }, scenes: [] };
    store.setComposition(comp);
    return comp;
  };

  const syncPlayerToComposition = (): void => {
    const state = store.getState();
    if (!state.composition) return;

    if (previewPlayer) {
      previewPlayer.setComposition(state.composition);
    } else {
      previewPlayer = new PreviewPlayer(ui.compositionCanvas, state.composition);
      previewPlayer.setOnFrameChange((frame) => {
        store.setCreatorFrame(frame);
      });
    }

    // Render current frame
    previewPlayer.seek(state.creatorFrame);
  };

  const addSceneToComposition = (type: string, from?: number, durationInFrames?: number, props?: SceneProps): string => {
    const comp = ensureComposition();
    const id = nextSceneId();
    const sceneFrom = from ?? 0;
    const sceneDur = durationInFrames ?? Math.min(comp.config.durationInFrames, 90);
    const sceneProps = props ?? getDefaultPropsForType(type);

    const scene = createScene(type, id, sceneFrom, sceneDur, sceneProps);
    store.addScene(scene);
    syncPlayerToComposition();
    return id;
  };

  const getDefaultPropsForType = (type: string): SceneProps => {
    switch (type) {
      case 'solid':
        return { color: '#1a1a2e' };
      case 'text':
        return { text: 'Hello World', fontSize: 64, color: '#ffffff', animation: 'fadeIn' };
      case 'shape':
        return { shape: 'rect', x: 200, y: 200, width: 200, height: 150, color: '#3498db' };
      case 'image':
        return { src: '' };
      case 'video-clip':
        return { src: '' };
      default:
        return {};
    }
  };

  const handleCreatorPlayPause = (): void => {
    if (!previewPlayer) {
      syncPlayerToComposition();
      if (!previewPlayer) return;
    }

    if (previewPlayer.getState() === 'playing') {
      previewPlayer.pause();
      store.setCreatorPlaying(false);
    } else {
      previewPlayer.play();
      store.setCreatorPlaying(true);
    }
  };

  const handleCreatorExport = async (): Promise<void> => {
    const state = store.getState();
    if (!state.composition || exportingInProgress) return;

    exportingInProgress = true;
    store.setExportState({ exporting: true, exportProgress: 0, exportMessage: 'Exporting composition...' });

    try {
      const blob = await exportComposition(state.composition, (p) => {
        store.setExportState({
          exportProgress: p.percent,
          exportMessage: `Exporting ${Math.round(p.percent * 100)}% (frame ${p.frame}/${p.totalFrames})`,
        });
      });

      downloadBlob(blob, makeExportFilename('webm', 'composition'));
      store.setExportState({
        exporting: false,
        exportProgress: 1,
        exportMessage: 'Export complete!',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown export error.';
      store.setExportState({
        exporting: false,
        exportProgress: 0,
        exportMessage: `Export failed: ${message}`,
      });
    } finally {
      exportingInProgress = false;
    }
  };

  // === Event listeners: Edit mode ===

  ui.urlInput.value = prefs.lastUrl;
  ui.storagePathInput.value =
    normalizeStoragePath(prefs.lastStorageListPath) || DEFAULT_STORAGE_LIST_PATH;
  ui.video.playbackRate = prefs.playbackRate;
  store.setPlaybackRate(prefs.playbackRate);
  store.setLoopPreview(prefs.loopPreview);

  ui.loadUrlButton.addEventListener('click', () => {
    void loadSourceUrl(ui.urlInput.value);
  });

  ui.urlInput.addEventListener('change', () => {
    persistPrefs({ lastUrl: ui.urlInput.value.trim() });
  });

  ui.refreshFilesButton.addEventListener('click', () => {
    void refreshStorageList();
  });

  ui.storagePathInput.addEventListener('change', () => {
    const nextPath = normalizeStoragePath(ui.storagePathInput.value) || DEFAULT_STORAGE_LIST_PATH;
    ui.storagePathInput.value = nextPath;
    persistPrefs({ lastStorageListPath: nextPath });
    void refreshStorageList();
  });

  ui.fileSearch.addEventListener('input', () => {
    applyFileFilter();
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

  ui.exportButton.addEventListener('click', () => {
    void exportTrimmedSegment();
  });

  // === Event listeners: Mode toggle ===

  ui.editTabButton.addEventListener('click', () => {
    store.setMode('edit');
    if (previewPlayer) {
      previewPlayer.pause();
      store.setCreatorPlaying(false);
    }
  });

  ui.createTabButton.addEventListener('click', () => {
    store.setMode('create');
    ensureComposition();
    syncPlayerToComposition();
  });

  // === Event listeners: Creator mode ===

  ui.creatorPlayButton.addEventListener('click', () => {
    handleCreatorPlayPause();
  });

  ui.creatorExportButton.addEventListener('click', () => {
    void handleCreatorExport();
  });

  ui.creatorFrameSlider.addEventListener('input', () => {
    const frame = parseNumber(ui.creatorFrameSlider.value);
    if (Number.isNaN(frame)) return;
    if (previewPlayer) {
      previewPlayer.pause();
      store.setCreatorPlaying(false);
      previewPlayer.seek(frame);
    }
    store.setCreatorFrame(frame);
  });

  ui.addSceneButton.addEventListener('click', () => {
    const type = ui.addSceneSelect.value;
    addSceneToComposition(type);
  });

  // Scene panel click delegation
  ui.scenePanel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Delete button
    const deleteId = target.dataset.deleteSceneId;
    if (deleteId) {
      store.removeScene(deleteId);
      syncPlayerToComposition();
      return;
    }

    // Select scene
    const item = target.closest<HTMLElement>('.scene-item');
    if (item?.dataset.sceneId) {
      store.setSelectedScene(item.dataset.sceneId);
    }
  });

  // Timeline click delegation
  ui.timelineTrack.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.sceneId) {
      store.setSelectedScene(target.dataset.sceneId);
    }
  });

  // Composition settings
  const handleCompSettingChange = (): void => {
    const w = parseNumber(ui.compWidthInput.value);
    const h = parseNumber(ui.compHeightInput.value);
    const fps = parseNumber(ui.compFpsInput.value);
    const dur = parseNumber(ui.compDurationInput.value);

    const patch: Record<string, number> = {};
    if (!Number.isNaN(w) && w >= 100) patch.width = w;
    if (!Number.isNaN(h) && h >= 100) patch.height = h;
    if (!Number.isNaN(fps) && fps >= 1) patch.fps = fps;
    if (!Number.isNaN(dur) && dur >= 1) patch.durationInFrames = dur;

    if (Object.keys(patch).length) {
      store.updateCompositionConfig(patch);
      syncPlayerToComposition();
    }
  };

  ui.compWidthInput.addEventListener('change', handleCompSettingChange);
  ui.compHeightInput.addEventListener('change', handleCompSettingChange);
  ui.compFpsInput.addEventListener('change', handleCompSettingChange);
  ui.compDurationInput.addEventListener('change', handleCompSettingChange);

  // === Keyboard shortcuts ===

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
      if (state.mode === 'create') {
        handleCreatorPlayPause();
      } else {
        void togglePlayPause();
      }
      return;
    }

    // Edit-mode-only shortcuts
    if (state.mode === 'edit') {
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
    }

    // Create-mode arrow keys: scrub frames
    if (state.mode === 'create') {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const nextFrame = clamp(state.creatorFrame + direction * step, 0, (state.composition?.config.durationInFrames ?? 1) - 1);
        if (previewPlayer) {
          previewPlayer.pause();
          store.setCreatorPlaying(false);
          previewPlayer.seek(nextFrame);
        }
        store.setCreatorFrame(nextFrame);
      }
    }
  });

  void refreshStorageList();

  store.subscribe((state) => {
    renderEditor(ui, state);
  });

  window.addEventListener('beforeunload', () => {
    releaseActiveObjectUrl();
    previewPlayer?.destroy();
  });

  // === Public API ===

  return {
    getCurrentSource: () => {
      const state = store.getState();
      return {
        sourceKind: state.sourceKind,
        sourceValue: state.sourceValue,
        objectUrl: state.objectUrl,
      };
    },
    getPlaybackState: () => {
      const state = store.getState();
      return {
        playing: state.playing,
        paused: ui.video.paused,
        playbackRate: state.playbackRate,
        loopPreview: state.loopPreview,
      };
    },
    getTimeline: () => {
      const state = store.getState();
      return {
        currentTime: state.currentTime,
        duration: state.duration,
      };
    },
    getTrimRange: () => {
      const state = store.getState();
      return {
        trimStart: state.trimStart,
        trimEnd: state.trimEnd,
        selectedDuration: Math.max(0, state.trimEnd - state.trimStart),
      };
    },
    loadSource: (params) => {
      const urlParam = typeof params.url === 'string' ? params.url.trim() : '';
      const pathParam = typeof params.path === 'string' ? normalizeStoragePath(params.path) : '';
      if (!urlParam && !pathParam) {
        throw new Error('Provide either "url" or "path".');
      }

      const targetUrl = urlParam || toStorageUrl(pathParam);
      const loaded = loadSourceUrl(targetUrl, pathParam || null);
      if (!loaded) {
        throw new Error('Unable to load source.');
      }
      return { ok: true as const, source: targetUrl };
    },
    play: async () => {
      await ui.video.play();
      return { ok: true as const };
    },
    pause: () => {
      ui.video.pause();
      return { ok: true as const };
    },
    seek: (time) => {
      if (!Number.isFinite(time)) {
        throw new Error('time must be a number.');
      }
      const duration = ui.video.duration || store.getState().duration || 0;
      if (duration <= 0) {
        throw new Error('Load a video before seeking.');
      }
      ui.video.currentTime = clamp(time, 0, duration);
      return { ok: true as const, currentTime: ui.video.currentTime };
    },
    setPlaybackRate: (rate) => {
      if (!ALLOWED_PLAYBACK_RATES.has(rate)) {
        throw new Error('Unsupported playback rate.');
      }
      ui.video.playbackRate = rate;
      store.setPlaybackRate(rate);
      persistPrefs({ playbackRate: rate });
      return { ok: true as const, playbackRate: rate };
    },

    // Creator mode API
    createComposition: (params) => {
      const config = {
        width: params.width ?? DEFAULT_CONFIG.width,
        height: params.height ?? DEFAULT_CONFIG.height,
        fps: params.fps ?? DEFAULT_CONFIG.fps,
        durationInFrames: params.durationInFrames ?? DEFAULT_CONFIG.durationInFrames,
      };
      const comp: Composition = { config, scenes: [] };
      store.setComposition(comp);
      store.setMode('create');
      syncPlayerToComposition();
      return { ok: true as const, config };
    },

    addScene: (params) => {
      const id = addSceneToComposition(params.type, params.from, params.durationInFrames, params.props);
      return { ok: true as const, sceneId: id };
    },

    updateScene: (params) => {
      const state = store.getState();
      if (!state.composition) throw new Error('No composition.');
      const existing = state.composition.scenes.find((s) => s.id === params.id);
      if (!existing) throw new Error(`Scene "${params.id}" not found.`);

      const from = params.from ?? existing.from;
      const dur = params.durationInFrames ?? existing.durationInFrames;
      const mergedProps = { ...getDefaultPropsForType(existing.type), ...params.props };
      const updated = createScene(existing.type, existing.id, from, dur, mergedProps);
      store.updateScene(params.id, updated);
      syncPlayerToComposition();
      return { ok: true as const };
    },

    removeScene: (params) => {
      store.removeScene(params.id);
      syncPlayerToComposition();
      return { ok: true as const };
    },

    reorderScenes: (params) => {
      store.reorderScenes(params.ids);
      syncPlayerToComposition();
      return { ok: true as const };
    },

    getComposition: () => {
      const state = store.getState();
      if (!state.composition) return { composition: null };
      return {
        composition: {
          config: { ...state.composition.config },
          scenes: state.composition.scenes.map((s) => ({
            id: s.id,
            type: s.type,
            from: s.from,
            durationInFrames: s.durationInFrames,
            render: s.render,
          })),
        },
      };
    },

    preview: () => {
      store.setMode('create');
      ensureComposition();
      syncPlayerToComposition();
      if (previewPlayer) {
        previewPlayer.play();
        store.setCreatorPlaying(true);
      }
      return { ok: true as const };
    },

    exportVideo: async () => {
      await handleCreatorExport();
      return { ok: true as const };
    },
  };
}
