import { EditorStore } from './state';
import { createEditorUI } from './ui';
import { renderEditor } from './render';
import { loadPrefs, savePrefs, ALLOWED_PLAYBACK_RATES } from './prefs';
import type { EditorPrefs } from './prefs';
import { parseNumber, clamp } from './utils/time';
import type { Composition } from '../core/types';
import { DEFAULT_CONFIG } from '../core/types';
import { createScene } from '../core/scene-registry';
import type { SceneProps } from '../core/scene-registry';
import { createFileBrowser } from './file-browser';
import { createEditMode } from './edit-mode';
import { createCreatorMode } from './creator-mode';
import { setupKeyboardShortcuts } from './keyboard';
import { getDefaultPropsForType } from './scene-defaults';
import { normalizeStoragePath, toStorageUrl } from './storage-utils';
import { DEFAULT_STORAGE_LIST_PATH } from './storage-utils';

// Register all scene types (side-effect imports)
import '../scenes/solid';
import '../scenes/text';
import '../scenes/shape';
import '../scenes/image';
import '../scenes/video-clip';

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

export function createEditorController(parent: HTMLElement): EditorControllerApi {
  const store = new EditorStore();
  const ui = createEditorUI(parent);
  let prefs = loadPrefs();

  const persistPrefs = (patch: Partial<EditorPrefs>): void => {
    prefs = { ...prefs, ...patch };
    savePrefs(prefs);
  };

  // Create sub-controllers
  const editMode = createEditMode(ui, store, {
    getPrefs: () => prefs,
    persistPrefs,
  });

  const creatorMode = createCreatorMode(ui, store);

  const fileBrowser = createFileBrowser(ui, {
    persistPrefs,
    onFileSelect: (storageUrl, storagePath) => editMode.loadSourceUrl(storageUrl, storagePath),
  });

  setupKeyboardShortcuts(store, editMode, creatorMode);

  // === Initialize from prefs ===
  ui.urlInput.value = prefs.lastUrl;
  ui.storagePathInput.value = normalizeStoragePath(prefs.lastStorageListPath) || DEFAULT_STORAGE_LIST_PATH;
  ui.video.playbackRate = prefs.playbackRate;
  store.setPlaybackRate(prefs.playbackRate);
  store.setLoopPreview(prefs.loopPreview);

  // === Event listeners: Edit mode ===

  ui.loadUrlButton.addEventListener('click', () => {
    void editMode.loadSourceUrl(ui.urlInput.value);
  });

  ui.urlInput.addEventListener('change', () => {
    persistPrefs({ lastUrl: ui.urlInput.value.trim() });
  });

  ui.refreshFilesButton.addEventListener('click', () => {
    void fileBrowser.refresh();
  });

  ui.storagePathInput.addEventListener('change', () => {
    const nextPath = normalizeStoragePath(ui.storagePathInput.value) || DEFAULT_STORAGE_LIST_PATH;
    ui.storagePathInput.value = nextPath;
    persistPrefs({ lastStorageListPath: nextPath });
    void fileBrowser.refresh();
  });

  ui.fileSearch.addEventListener('input', () => {
    fileBrowser.applyFilter();
  });

  ui.pickFileButton.addEventListener('click', async () => {
    const pickedFromStorage = await editMode.tryPickStorageVideo();
    if (pickedFromStorage) return;
    ui.fileInput.click();
  });

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    editMode.setFromFile(file);
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

  ui.video.addEventListener('play', () => { store.setPlaying(true); });
  ui.video.addEventListener('pause', () => { store.setPlaying(false); });

  ui.startRange.addEventListener('input', () => {
    editMode.applyTrimStart(parseNumber(ui.startRange.value));
  });

  ui.endRange.addEventListener('input', () => {
    editMode.applyTrimEnd(parseNumber(ui.endRange.value));
  });

  ui.startInput.addEventListener('change', () => {
    editMode.applyTrimStart(parseNumber(ui.startInput.value));
  });

  ui.endInput.addEventListener('change', () => {
    editMode.applyTrimEnd(parseNumber(ui.endInput.value));
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
    void editMode.exportTrimmedSegment();
  });

  // === Event listeners: Mode toggle ===

  ui.editTabButton.addEventListener('click', () => {
    store.setMode('edit');
    const player = creatorMode.getPreviewPlayer();
    if (player) {
      player.pause();
      store.setCreatorPlaying(false);
    }
  });

  ui.createTabButton.addEventListener('click', () => {
    store.setMode('create');
    creatorMode.ensureComposition();
    creatorMode.syncPlayerToComposition();
  });

  // === Event listeners: Creator mode ===

  ui.creatorPlayButton.addEventListener('click', () => {
    creatorMode.handleCreatorPlayPause();
  });

  ui.creatorExportButton.addEventListener('click', () => {
    void creatorMode.handleCreatorExport();
  });

  ui.creatorFrameSlider.addEventListener('input', () => {
    const frame = parseNumber(ui.creatorFrameSlider.value);
    if (Number.isNaN(frame)) return;
    const player = creatorMode.getPreviewPlayer();
    if (player) {
      player.pause();
      store.setCreatorPlaying(false);
      player.seek(frame);
    }
    store.setCreatorFrame(frame);
  });

  ui.addSceneButton.addEventListener('click', () => {
    const type = ui.addSceneSelect.value;
    creatorMode.addSceneToComposition(type);
  });

  ui.scenePanel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const deleteId = target.dataset.deleteSceneId;
    if (deleteId) {
      store.removeScene(deleteId);
      creatorMode.syncPlayerToComposition();
      return;
    }
    const item = target.closest<HTMLElement>('.scene-item');
    if (item?.dataset.sceneId) {
      store.setSelectedScene(item.dataset.sceneId);
    }
  });

  ui.timelineTrack.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.sceneId) {
      store.setSelectedScene(target.dataset.sceneId);
    }
  });

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
      creatorMode.syncPlayerToComposition();
    }
  };

  ui.compWidthInput.addEventListener('change', handleCompSettingChange);
  ui.compHeightInput.addEventListener('change', handleCompSettingChange);
  ui.compFpsInput.addEventListener('change', handleCompSettingChange);
  ui.compDurationInput.addEventListener('change', handleCompSettingChange);

  // === Initialization ===
  void fileBrowser.refresh();

  store.subscribe((state) => {
    renderEditor(ui, state);
  });

  window.addEventListener('beforeunload', () => {
    editMode.releaseActiveObjectUrl();
    creatorMode.destroy();
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
      const loaded = editMode.loadSourceUrl(targetUrl, pathParam || null);
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
      creatorMode.syncPlayerToComposition();
      return { ok: true as const, config };
    },

    addScene: (params) => {
      const id = creatorMode.addSceneToComposition(params.type, params.from, params.durationInFrames, params.props);
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
      creatorMode.syncPlayerToComposition();
      return { ok: true as const };
    },

    removeScene: (params) => {
      store.removeScene(params.id);
      creatorMode.syncPlayerToComposition();
      return { ok: true as const };
    },

    reorderScenes: (params) => {
      store.reorderScenes(params.ids);
      creatorMode.syncPlayerToComposition();
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
      creatorMode.ensureComposition();
      creatorMode.syncPlayerToComposition();
      const player = creatorMode.getPreviewPlayer();
      if (player) {
        player.play();
        store.setCreatorPlaying(true);
      }
      return { ok: true as const };
    },

    exportVideo: async () => {
      await creatorMode.handleCreatorExport();
      return { ok: true as const };
    },
  };
}
