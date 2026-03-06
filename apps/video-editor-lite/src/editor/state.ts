import { createSignal } from '@bundled/solid-js';
import type { EditorState, EditorMode, TrimPatch } from './types';
import type { Composition, Scene, Layer } from '../core/types';
import { makeDefaultLayer } from '../core/types';
import { clamp } from './utils/time';

const EPSILON = 0.01;

export class EditorStore {
  readonly mode = createSignal<EditorMode>('edit');
  readonly sourceKind = createSignal<'url' | 'file' | null>(null);
  readonly sourceValue = createSignal('');
  readonly objectUrl = createSignal<string | null>(null);
  readonly duration = createSignal(0);
  readonly trimStart = createSignal(0);
  readonly trimEnd = createSignal(0);
  readonly currentTime = createSignal(0);
  readonly playbackRate = createSignal(1);
  readonly loopPreview = createSignal(false);
  readonly playing = createSignal(false);
  readonly exporting = createSignal(false);
  readonly exportProgress = createSignal(0);
  readonly exportMessage = createSignal<string | null>(null);
  readonly error = createSignal<string | null>(null);
  readonly composition = createSignal<Composition | null>(null);
  readonly selectedSceneId = createSignal<string | null>(null);
  readonly selectedLayerId = createSignal<string | null>(null);
  readonly creatorPlaying = createSignal(false);
  readonly creatorFrame = createSignal(0);

  getState(): EditorState {
    return {
      mode: this.mode[0](),
      sourceKind: this.sourceKind[0](),
      sourceValue: this.sourceValue[0](),
      objectUrl: this.objectUrl[0](),
      duration: this.duration[0](),
      trimStart: this.trimStart[0](),
      trimEnd: this.trimEnd[0](),
      currentTime: this.currentTime[0](),
      playbackRate: this.playbackRate[0](),
      loopPreview: this.loopPreview[0](),
      playing: this.playing[0](),
      exporting: this.exporting[0](),
      exportProgress: this.exportProgress[0](),
      exportMessage: this.exportMessage[0](),
      error: this.error[0](),
      composition: this.composition[0](),
      selectedSceneId: this.selectedSceneId[0](),
      selectedLayerId: this.selectedLayerId[0](),
      creatorPlaying: this.creatorPlaying[0](),
      creatorFrame: this.creatorFrame[0](),
    };
  }

  setMode(mode: EditorMode): void {
    this.mode[1](mode);
    this.error[1](null);
    this.exportMessage[1](null);
  }

  setSource(kind: 'url' | 'file', sourceValue: string, objectUrl: string | null): void {
    this.sourceKind[1](kind);
    this.sourceValue[1](sourceValue);
    this.objectUrl[1](objectUrl);
    this.duration[1](0);
    this.trimStart[1](0);
    this.trimEnd[1](0);
    this.currentTime[1](0);
    this.exporting[1](false);
    this.exportProgress[1](0);
    this.exportMessage[1](null);
    this.error[1](null);
  }

  setDuration(duration: number): void {
    const n = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.duration[1](n);
    this.trimStart[1](0);
    this.trimEnd[1](n);
    this.currentTime[1](0);
    this.exporting[1](false);
    this.exportProgress[1](0);
    this.exportMessage[1](null);
    this.error[1](null);
  }

  setCurrentTime(currentTime: number): void {
    this.currentTime[1](clamp(currentTime, 0, this.duration[0]() || 0));
  }

  setPlaying(playing: boolean): void { this.playing[1](playing); }
  setLoopPreview(loopPreview: boolean): void { this.loopPreview[1](loopPreview); }
  setPlaybackRate(playbackRate: number): void { this.playbackRate[1](playbackRate); }

  setTrim(patch: TrimPatch): boolean {
    const duration = this.duration[0]();
    if (duration <= 0) { this.error[1]('Load a video first.'); return false; }
    const nextStart = patch.trimStart ?? this.trimStart[0]();
    const nextEnd = patch.trimEnd ?? this.trimEnd[0]();
    const clampedStart = clamp(nextStart, 0, duration);
    const clampedEnd = clamp(nextEnd, 0, duration);
    if (clampedStart >= clampedEnd - EPSILON) {
      this.error[1]('Trim start must be less than trim end.');
      return false;
    }
    this.trimStart[1](clampedStart);
    this.trimEnd[1](clampedEnd);
    this.error[1](null);
    return true;
  }

  setExportState(patch: { exporting?: boolean; exportProgress?: number; exportMessage?: string | null }): void {
    if (patch.exporting !== undefined) this.exporting[1](patch.exporting);
    if (patch.exportProgress !== undefined) this.exportProgress[1](patch.exportProgress);
    if (patch.exportMessage !== undefined) this.exportMessage[1](patch.exportMessage ?? null);
  }

  clearExportMessage(): void { if (this.exportMessage[0]()) this.exportMessage[1](null); }
  clearError(): void { if (this.error[0]()) this.error[1](null); }

  setComposition(composition: Composition | null): void {
    this.composition[1](composition);
    this.selectedSceneId[1](null);
    this.creatorFrame[1](0);
    // Auto-select first layer
    const firstLayerId = composition?.layers[0]?.id ?? null;
    this.selectedLayerId[1](firstLayerId);
  }

  // ── Layer management ─────────────────────────────────────────────────────

  addLayer(layer: Layer): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({ ...comp, layers: [...comp.layers, layer] });
    this.selectedLayerId[1](layer.id);
  }

  removeLayer(layerId: string): void {
    const comp = this.composition[0]();
    if (!comp) return;
    if (comp.layers.length <= 1) return; // keep at least one layer
    const newLayers = comp.layers.filter((l) => l.id !== layerId);
    this.composition[1]({ ...comp, layers: newLayers });
    // If removed was selected, select last remaining
    if (this.selectedLayerId[0]() === layerId) {
      this.selectedLayerId[1](newLayers[newLayers.length - 1]?.id ?? null);
    }
    if (this.selectedSceneId[0]()) {
      const stillExists = newLayers.some((l) => l.scenes.some((s) => s.id === this.selectedSceneId[0]()));
      if (!stillExists) this.selectedSceneId[1](null);
    }
  }

  updateLayer(layerId: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'locked'>>): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({
      ...comp,
      layers: comp.layers.map((l) => l.id === layerId ? { ...l, ...patch } : l),
    });
  }

  setSelectedLayer(layerId: string | null): void {
    this.selectedLayerId[1](layerId);
  }

  reorderLayers(ids: string[]): void {
    const comp = this.composition[0]();
    if (!comp) return;
    const layerMap = new Map(comp.layers.map((l) => [l.id, l]));
    const reordered = ids.map((id) => layerMap.get(id)).filter(Boolean) as Layer[];
    for (const l of comp.layers) {
      if (!ids.includes(l.id)) reordered.push(l);
    }
    this.composition[1]({ ...comp, layers: reordered });
  }

  // ── Scene management (layer-aware) ───────────────────────────────────────

  /** Add a scene to the currently selected layer (or first layer if none selected) */
  addScene(scene: Scene): void {
    const comp = this.composition[0]();
    if (!comp) return;
    const targetLayerId = this.selectedLayerId[0]() ?? comp.layers[0]?.id;
    if (!targetLayerId) return;
    this.composition[1]({
      ...comp,
      layers: comp.layers.map((l) =>
        l.id === targetLayerId
          ? { ...l, scenes: [...l.scenes, scene] }
          : l
      ),
    });
    this.selectedSceneId[1](scene.id);
  }

  removeScene(id: string): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({
      ...comp,
      layers: comp.layers.map((l) => ({
        ...l,
        scenes: l.scenes.filter((s) => s.id !== id),
      })),
    });
    if (this.selectedSceneId[0]() === id) this.selectedSceneId[1](null);
  }

  updateScene(id: string, updatedScene: Scene): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({
      ...comp,
      layers: comp.layers.map((l) => ({
        ...l,
        scenes: l.scenes.map((s) => (s.id === id ? updatedScene : s)),
      })),
    });
  }

  reorderScenes(ids: string[]): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({
      ...comp,
      layers: comp.layers.map((l) => {
        const layerSceneIds = l.scenes.map((s) => s.id);
        const orderedIds = ids.filter((id) => layerSceneIds.includes(id));
        if (orderedIds.length === 0) return l;
        const sceneMap = new Map(l.scenes.map((s) => [s.id, s]));
        const reordered = orderedIds.map((id) => sceneMap.get(id)!);
        for (const s of l.scenes) {
          if (!orderedIds.includes(s.id)) reordered.push(s);
        }
        return { ...l, scenes: reordered };
      }),
    });
  }

  setSelectedScene(id: string | null): void { this.selectedSceneId[1](id); }
  setCreatorPlaying(playing: boolean): void { this.creatorPlaying[1](playing); }
  setCreatorFrame(frame: number): void { this.creatorFrame[1](frame); }

  updateCompositionConfig(patch: { width?: number; height?: number; fps?: number; durationInFrames?: number }): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({ ...comp, config: { ...comp.config, ...patch } });
  }
}
