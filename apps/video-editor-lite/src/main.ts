import { createEffect } from '@bundled/solid-js';
import { EditorStore } from './editor/state';
import { createEditorUI } from './editor/ui';
import { renderEditor } from './editor/render';
import { loadPrefs, savePrefs, ALLOWED_PLAYBACK_RATES, DEFAULT_PREFS } from './editor/prefs';
import type { EditorPrefs } from './editor/prefs';
import { parseNumber, clamp } from './editor/utils/time';
import type { Composition, Scene } from './core/types';
import { DEFAULT_CONFIG, getAllScenes, makeDefaultLayer } from './core/types';
import { createScene } from './core/scene-registry';
import type { SceneProps } from './core/scene-registry';
import { getDefaultPropsForType } from './editor/scene-defaults';
import { createFileBrowser } from './editor/file-browser';
import { createEditMode } from './editor/edit-mode';
import { createCreatorMode } from './editor/creator-mode';
import { setupKeyboardShortcuts } from './editor/keyboard';
import { normalizeStoragePath, toStorageUrl, DEFAULT_STORAGE_LIST_PATH } from './editor/storage-utils';
import { registerProtocol } from './protocol';

// Register all scene types (side-effect imports)
import './scenes/solid';
import './scenes/text';
import './scenes/shape';
import './scenes/image';
import './scenes/video-clip';

const store = new EditorStore();
const ui = createEditorUI(document.body, store);
let prefs: EditorPrefs = { ...DEFAULT_PREFS };

const persistPrefs = (patch: Partial<EditorPrefs>): void => {
  prefs = { ...prefs, ...patch };
  void savePrefs(prefs);
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

// === Event listeners: Layer management ===

ui.addLayerButton.addEventListener('click', () => {
  const comp = store.getState().composition;
  if (!comp) {
    creatorMode.ensureComposition();
  }
  const layerCount = store.getState().composition?.layers.length ?? 0;
  const newLayer = makeDefaultLayer(`Layer ${layerCount + 1}`);
  store.addLayer(newLayer);
  creatorMode.syncPlayerToComposition();
});

// Delegated click handler for layer list in sidebar
ui.layerListEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  // Visibility toggle
  const layerVisId = target.dataset.layerVis;
  if (layerVisId) {
    const comp = store.getState().composition;
    const layer = comp?.layers.find((l) => l.id === layerVisId);
    if (layer) {
      store.updateLayer(layerVisId, { visible: !layer.visible });
      creatorMode.syncPlayerToComposition();
    }
    return;
  }

  // Lock toggle
  const layerLockId = target.dataset.layerLock;
  if (layerLockId) {
    const comp = store.getState().composition;
    const layer = comp?.layers.find((l) => l.id === layerLockId);
    if (layer) {
      store.updateLayer(layerLockId, { locked: !layer.locked });
    }
    return;
  }

  // Delete layer
  const layerDeleteId = target.dataset.layerDelete;
  if (layerDeleteId) {
    store.removeLayer(layerDeleteId);
    creatorMode.syncPlayerToComposition();
    return;
  }

  // Select layer
  const layerSelectId = target.dataset.layerSelect;
  if (layerSelectId) {
    store.setSelectedLayer(layerSelectId);
    return;
  }
});

// === Event listeners: Scene management ===

ui.addSceneButton.addEventListener('click', () => {
  const type = ui.addSceneSelect.value;
  const fromVal = parseInt(ui.addSceneFromInput.value, 10) || 0;
  const durRaw = parseInt(ui.addSceneDurInput.value, 10);
  const dur = (durRaw > 0) ? durRaw : undefined; // undefined = auto
  creatorMode.addSceneToComposition(type, fromVal, dur);
});

// Delegated click handler for scene panel (handles both layer headers and scene items)
ui.scenePanel.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  // Layer visibility toggle in scene panel
  const layerVisId = target.dataset.layerVis;
  if (layerVisId) {
    const comp = store.getState().composition;
    const layer = comp?.layers.find((l) => l.id === layerVisId);
    if (layer) {
      store.updateLayer(layerVisId, { visible: !layer.visible });
      creatorMode.syncPlayerToComposition();
    }
    return;
  }

  // Layer lock toggle in scene panel
  const layerLockId = target.dataset.layerLock;
  if (layerLockId) {
    const comp = store.getState().composition;
    const layer = comp?.layers.find((l) => l.id === layerLockId);
    if (layer) {
      store.updateLayer(layerLockId, { locked: !layer.locked });
    }
    return;
  }

  // Select layer from scene panel header
  const layerSelectId = target.dataset.layerSelect;
  if (layerSelectId) {
    store.setSelectedLayer(layerSelectId);
    return;
  }

  // Delete scene
  const deleteId = target.dataset.deleteSceneId;
  if (deleteId) {
    // Check if scene is in a locked layer
    const comp = store.getState().composition;
    if (comp) {
      const layer = comp.layers.find((l) => l.scenes.some((s) => s.id === deleteId));
      if (layer?.locked) return; // locked, do nothing
    }
    store.removeScene(deleteId);
    creatorMode.syncPlayerToComposition();
    return;
  }

  // Select scene
  const item = target.closest<HTMLElement>('.scene-item');
  if (item?.dataset.sceneId) {
    store.setSelectedScene(item.dataset.sceneId);
  }
});

ui.timelineTrack.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  // Click on scene block
  if (target.dataset.sceneId) {
    store.setSelectedScene(target.dataset.sceneId);
    return;
  }

  // Click on layer label
  const layerSelectId = target.dataset.layerSelect;
  if (layerSelectId) {
    store.setSelectedLayer(layerSelectId);
    return;
  }

  // Click on layer row area (not a block)
  const layerRow = target.closest<HTMLElement>('.tl-layer-row');
  if (layerRow?.dataset.layerId) {
    store.setSelectedLayer(layerRow.dataset.layerId);
  }
});

function getCurrentSceneProps(scene: Scene): SceneProps {
  return (scene as any).props ?? getDefaultPropsForType(scene.type);
}

ui.scenePropsPanel.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  const prop = target.dataset.prop;
  if (!prop) return;
  const sceneId = store.selectedSceneId[0]();
  if (!sceneId) return;
  const comp = store.composition[0]();
  if (!comp) return;

  // Find scene across all layers
  const scene = getAllScenes(comp).find((s) => s.id === sceneId);
  if (!scene) return;

  // Check if scene is in a locked layer
  const layer = comp.layers.find((l) => l.scenes.some((s) => s.id === sceneId));
  if (layer?.locked) return;

  let value: string | number = target.value;
  if ((target as HTMLInputElement).type === 'number' || (target as HTMLInputElement).type === 'range') {
    value = parseFloat(value as string);
  }

  if (prop === 'from') {
    const newFrom = Math.max(0, parseInt(String(value), 10) || 0);
    const updated = createScene(scene.type, scene.id, newFrom, scene.durationInFrames, getCurrentSceneProps(scene));
    store.updateScene(sceneId, updated);
  } else if (prop === 'durationInFrames') {
    const newDur = Math.max(1, parseInt(String(value), 10) || 1);
    const updated = createScene(scene.type, scene.id, scene.from, newDur, getCurrentSceneProps(scene));
    store.updateScene(sceneId, updated);
  } else {
    const currentProps = getCurrentSceneProps(scene);
    const updated = createScene(scene.type, scene.id, scene.from, scene.durationInFrames, { ...currentProps, [prop]: value });
    store.updateScene(sceneId, updated);
  }
  creatorMode.syncPlayerToComposition();
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

// === Async initialization from prefs ===
(async () => {
  prefs = await loadPrefs();
  ui.urlInput.value = prefs.lastUrl;
  ui.storagePathInput.value = normalizeStoragePath(prefs.lastStorageListPath) || DEFAULT_STORAGE_LIST_PATH;
  ui.video.playbackRate = prefs.playbackRate;
  store.setPlaybackRate(prefs.playbackRate);
  store.setLoopPreview(prefs.loopPreview);
  void fileBrowser.refresh();
})();

createEffect(() => { renderEditor(ui, store.getState()); });

window.addEventListener('beforeunload', () => {
  editMode.releaseActiveObjectUrl();
  creatorMode.destroy();
});

// === App Protocol API ===
registerProtocol({
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
    const defaultLayer = makeDefaultLayer('Layer 1');
    const comp: Composition = { config, layers: [defaultLayer] };
    store.setComposition(comp);
    store.setMode('create');
    creatorMode.syncPlayerToComposition();
    return { ok: true as const, config };
  },

  addScene: (params) => {
    // If layerId specified, temporarily select that layer
    if (typeof params.layerId === 'string') {
      const comp = store.getState().composition ?? creatorMode.ensureComposition();
      const layer = comp.layers.find((l) => l.id === params.layerId);
      if (!layer) throw new Error(`Layer "${params.layerId}" not found.`);
      store.setSelectedLayer(params.layerId);
    }
    const id = creatorMode.addSceneToComposition(params.type, params.from, params.durationInFrames, params.props);
    return { ok: true as const, sceneId: id };
  },

  updateScene: (params) => {
    const state = store.getState();
    if (!state.composition) throw new Error('No composition.');
    const allScenes = getAllScenes(state.composition);
    const existing = allScenes.find((s) => s.id === params.id);
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
    const scenes = getAllScenes(state.composition);
    return {
      composition: {
        config: { ...state.composition.config },
        scenes: scenes.map((s) => ({
          id: s.id,
          type: s.type,
          from: s.from,
          durationInFrames: s.durationInFrames,
          render: s.render,
        })),
        layers: state.composition.layers.map((l) => ({
          id: l.id,
          name: l.name,
          visible: l.visible,
          locked: l.locked,
          sceneIds: l.scenes.map((s) => s.id),
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

  addLayer: (params) => {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const index = typeof params.index === 'number' ? params.index : undefined;
    creatorMode.ensureComposition();
    const comp = store.getState().composition!;
    const layerCount = comp.layers.length;
    const newLayer = makeDefaultLayer(name ?? `Layer ${layerCount + 1}`);
    store.addLayer(newLayer);
    // If index provided, reorder to put new layer at that index
    if (index !== undefined) {
      const afterComp = store.getState().composition!;
      const ids = afterComp.layers.map((l) => l.id);
      // Move the new layer id to the target index
      const newIdx = Math.max(0, Math.min(index, ids.length - 1));
      const filteredIds = ids.filter((id) => id !== newLayer.id);
      filteredIds.splice(newIdx, 0, newLayer.id);
      store.reorderLayers(filteredIds);
    }
    creatorMode.syncPlayerToComposition();
    return { ok: true as const, layerId: newLayer.id, layerName: newLayer.name };
  },

  removeLayer: (params) => {
    const comp = store.getState().composition;
    if (!comp) throw new Error('No composition.');
    const layer = comp.layers.find((l) => l.id === params.id);
    if (!layer) throw new Error(`Layer "${params.id}" not found.`);
    if (comp.layers.length <= 1) throw new Error('Cannot remove the last layer.');
    store.removeLayer(params.id);
    creatorMode.syncPlayerToComposition();
    return { ok: true as const };
  },

  updateLayer: (params) => {
    const comp = store.getState().composition;
    if (!comp) throw new Error('No composition.');
    const layer = comp.layers.find((l) => l.id === params.id);
    if (!layer) throw new Error(`Layer "${params.id}" not found.`);
    const patch: { name?: string; visible?: boolean; locked?: boolean } = {};
    if (typeof params.name === 'string') patch.name = params.name;
    if (typeof params.visible === 'boolean') patch.visible = params.visible;
    if (typeof params.locked === 'boolean') patch.locked = params.locked;
    store.updateLayer(params.id, patch);
    if (patch.visible !== undefined) creatorMode.syncPlayerToComposition();
    return { ok: true as const };
  },

  reorderLayers: (params) => {
    const comp = store.getState().composition;
    if (!comp) throw new Error('No composition.');
    store.reorderLayers(params.ids);
    creatorMode.syncPlayerToComposition();
    return { ok: true as const };
  },

  selectLayer: (params) => {
    const comp = store.getState().composition;
    if (!comp) throw new Error('No composition.');
    const layer = comp.layers.find((l) => l.id === params.id);
    if (!layer) throw new Error(`Layer "${params.id}" not found.`);
    store.setSelectedLayer(params.id);
    return { ok: true as const };
  },

  moveSceneToLayer: (params) => {
    const comp = store.getState().composition;
    if (!comp) throw new Error('No composition.');
    const targetLayer = comp.layers.find((l) => l.id === params.layerId);
    if (!targetLayer) throw new Error(`Layer "${params.layerId}" not found.`);
    // Find the scene
    const sourceLayer = comp.layers.find((l) => l.scenes.some((s) => s.id === params.sceneId));
    if (!sourceLayer) throw new Error(`Scene "${params.sceneId}" not found.`);
    if (sourceLayer.id === params.layerId) return { ok: true as const }; // already there
    const scene = sourceLayer.scenes.find((s) => s.id === params.sceneId)!;
    // Remove from source, add to target
    const newLayers = comp.layers.map((l) => {
      if (l.id === sourceLayer.id) return { ...l, scenes: l.scenes.filter((s) => s.id !== params.sceneId) };
      if (l.id === params.layerId) return { ...l, scenes: [...l.scenes, scene] };
      return l;
    });
    store.composition[1]({ ...comp, layers: newLayers });
    creatorMode.syncPlayerToComposition();
    return { ok: true as const };
  },

  getLayers: () => {
    const comp = store.getState().composition;
    if (!comp) return { layers: [] };
    return {
      layers: comp.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        locked: l.locked,
        sceneIds: l.scenes.map((s) => s.id),
      })),
    };
  },
});
