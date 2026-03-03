import { createSignal } from '@bundled/solid-js';
import type { EditorState, EditorMode, TrimPatch } from './types';
import type { Composition, Scene } from '../core/types';
import { clamp } from './utils/time';

const EPSILON = 0.01;

export class EditorStore {
  // Public signals — readable directly from templates
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
  readonly creatorPlaying = createSignal(false);
  readonly creatorFrame = createSignal(0);

  // Backward-compat snapshot (used by callers that still call getState())
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
  }

  addScene(scene: Scene): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({ ...comp, scenes: [...comp.scenes, scene] });
    this.selectedSceneId[1](scene.id);
  }

  removeScene(id: string): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({ ...comp, scenes: comp.scenes.filter((s) => s.id !== id) });
    if (this.selectedSceneId[0]() === id) this.selectedSceneId[1](null);
  }

  updateScene(id: string, updatedScene: Scene): void {
    const comp = this.composition[0]();
    if (!comp) return;
    this.composition[1]({ ...comp, scenes: comp.scenes.map((s) => (s.id === id ? updatedScene : s)) });
  }

  reorderScenes(ids: string[]): void {
    const comp = this.composition[0]();
    if (!comp) return;
    const sceneMap = new Map(comp.scenes.map((s) => [s.id, s]));
    const reordered = ids.map((id) => sceneMap.get(id)).filter(Boolean) as Scene[];
    for (const scene of comp.scenes) {
      if (!ids.includes(scene.id)) reordered.push(scene);
    }
    this.composition[1]({ ...comp, scenes: reordered });
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
