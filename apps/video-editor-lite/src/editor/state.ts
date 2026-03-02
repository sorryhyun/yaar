import { signal } from '@bundled/yaar';
import type { EditorState, EditorMode, TrimPatch } from './types';
import type { Composition, Scene } from '../core/types';
import { clamp } from './utils/time';

const EPSILON = 0.01;

export class EditorStore {
  // Public signals — readable directly from templates
  readonly mode = signal<EditorMode>('edit');
  readonly sourceKind = signal<'url' | 'file' | null>(null);
  readonly sourceValue = signal('');
  readonly objectUrl = signal<string | null>(null);
  readonly duration = signal(0);
  readonly trimStart = signal(0);
  readonly trimEnd = signal(0);
  readonly currentTime = signal(0);
  readonly playbackRate = signal(1);
  readonly loopPreview = signal(false);
  readonly playing = signal(false);
  readonly exporting = signal(false);
  readonly exportProgress = signal(0);
  readonly exportMessage = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly composition = signal<Composition | null>(null);
  readonly selectedSceneId = signal<string | null>(null);
  readonly creatorPlaying = signal(false);
  readonly creatorFrame = signal(0);

  // Backward-compat snapshot (used by callers that still call getState())
  getState(): EditorState {
    return {
      mode: this.mode(),
      sourceKind: this.sourceKind(),
      sourceValue: this.sourceValue(),
      objectUrl: this.objectUrl(),
      duration: this.duration(),
      trimStart: this.trimStart(),
      trimEnd: this.trimEnd(),
      currentTime: this.currentTime(),
      playbackRate: this.playbackRate(),
      loopPreview: this.loopPreview(),
      playing: this.playing(),
      exporting: this.exporting(),
      exportProgress: this.exportProgress(),
      exportMessage: this.exportMessage(),
      error: this.error(),
      composition: this.composition(),
      selectedSceneId: this.selectedSceneId(),
      creatorPlaying: this.creatorPlaying(),
      creatorFrame: this.creatorFrame(),
    };
  }

  setMode(mode: EditorMode): void {
    this.mode(mode);
    this.error(null);
    this.exportMessage(null);
  }

  setSource(kind: 'url' | 'file', sourceValue: string, objectUrl: string | null): void {
    this.sourceKind(kind);
    this.sourceValue(sourceValue);
    this.objectUrl(objectUrl);
    this.duration(0);
    this.trimStart(0);
    this.trimEnd(0);
    this.currentTime(0);
    this.exporting(false);
    this.exportProgress(0);
    this.exportMessage(null);
    this.error(null);
  }

  setDuration(duration: number): void {
    const n = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.duration(n);
    this.trimStart(0);
    this.trimEnd(n);
    this.currentTime(0);
    this.exporting(false);
    this.exportProgress(0);
    this.exportMessage(null);
    this.error(null);
  }

  setCurrentTime(currentTime: number): void {
    this.currentTime(clamp(currentTime, 0, this.duration() || 0));
  }

  setPlaying(playing: boolean): void { this.playing(playing); }
  setLoopPreview(loopPreview: boolean): void { this.loopPreview(loopPreview); }
  setPlaybackRate(playbackRate: number): void { this.playbackRate(playbackRate); }

  setTrim(patch: TrimPatch): boolean {
    const duration = this.duration();
    if (duration <= 0) { this.error('Load a video first.'); return false; }
    const nextStart = patch.trimStart ?? this.trimStart();
    const nextEnd = patch.trimEnd ?? this.trimEnd();
    const clampedStart = clamp(nextStart, 0, duration);
    const clampedEnd = clamp(nextEnd, 0, duration);
    if (clampedStart >= clampedEnd - EPSILON) {
      this.error('Trim start must be less than trim end.');
      return false;
    }
    this.trimStart(clampedStart);
    this.trimEnd(clampedEnd);
    this.error(null);
    return true;
  }

  setExportState(patch: { exporting?: boolean; exportProgress?: number; exportMessage?: string | null }): void {
    if (patch.exporting !== undefined) this.exporting(patch.exporting);
    if (patch.exportProgress !== undefined) this.exportProgress(patch.exportProgress);
    if (patch.exportMessage !== undefined) this.exportMessage(patch.exportMessage ?? null);
  }

  clearExportMessage(): void { if (this.exportMessage()) this.exportMessage(null); }
  clearError(): void { if (this.error()) this.error(null); }

  setComposition(composition: Composition | null): void {
    this.composition(composition);
    this.selectedSceneId(null);
    this.creatorFrame(0);
  }

  addScene(scene: Scene): void {
    const comp = this.composition();
    if (!comp) return;
    this.composition({ ...comp, scenes: [...comp.scenes, scene] });
    this.selectedSceneId(scene.id);
  }

  removeScene(id: string): void {
    const comp = this.composition();
    if (!comp) return;
    this.composition({ ...comp, scenes: comp.scenes.filter((s) => s.id !== id) });
    if (this.selectedSceneId() === id) this.selectedSceneId(null);
  }

  updateScene(id: string, updatedScene: Scene): void {
    const comp = this.composition();
    if (!comp) return;
    this.composition({ ...comp, scenes: comp.scenes.map((s) => (s.id === id ? updatedScene : s)) });
  }

  reorderScenes(ids: string[]): void {
    const comp = this.composition();
    if (!comp) return;
    const sceneMap = new Map(comp.scenes.map((s) => [s.id, s]));
    const reordered = ids.map((id) => sceneMap.get(id)).filter(Boolean) as Scene[];
    for (const scene of comp.scenes) {
      if (!ids.includes(scene.id)) reordered.push(scene);
    }
    this.composition({ ...comp, scenes: reordered });
  }

  setSelectedScene(id: string | null): void { this.selectedSceneId(id); }
  setCreatorPlaying(playing: boolean): void { this.creatorPlaying(playing); }
  setCreatorFrame(frame: number): void { this.creatorFrame(frame); }

  updateCompositionConfig(patch: { width?: number; height?: number; fps?: number; durationInFrames?: number }): void {
    const comp = this.composition();
    if (!comp) return;
    this.composition({ ...comp, config: { ...comp.config, ...patch } });
  }
}
