import type { EditorState, EditorMode, TrimPatch } from './types';
import type { Composition, Scene } from '../core/types';
import { clamp } from './utils/time';

const EPSILON = 0.01;

type Listener = (state: EditorState) => void;

export class EditorStore {
  private state: EditorState = {
    mode: 'edit',
    sourceKind: null,
    sourceValue: '',
    objectUrl: null,
    duration: 0,
    trimStart: 0,
    trimEnd: 0,
    currentTime: 0,
    playbackRate: 1,
    loopPreview: false,
    playing: false,
    exporting: false,
    exportProgress: 0,
    exportMessage: null,
    error: null,
    composition: null,
    selectedSceneId: null,
    creatorPlaying: false,
    creatorFrame: 0,
  };

  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): EditorState {
    return { ...this.state };
  }

  setMode(mode: EditorMode): void {
    this.state = { ...this.state, mode, error: null, exportMessage: null };
    this.emit();
  }

  setSource(kind: 'url' | 'file', sourceValue: string, objectUrl: string | null): void {
    this.state = {
      ...this.state,
      sourceKind: kind,
      sourceValue,
      objectUrl,
      duration: 0,
      trimStart: 0,
      trimEnd: 0,
      currentTime: 0,
      exporting: false,
      exportProgress: 0,
      exportMessage: null,
      error: null,
    };
    this.emit();
  }

  setDuration(duration: number): void {
    const normalizedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.state = {
      ...this.state,
      duration: normalizedDuration,
      trimStart: 0,
      trimEnd: normalizedDuration,
      currentTime: 0,
      exporting: false,
      exportProgress: 0,
      exportMessage: null,
      error: null,
    };
    this.emit();
  }

  setCurrentTime(currentTime: number): void {
    this.state = {
      ...this.state,
      currentTime: clamp(currentTime, 0, this.state.duration || 0),
    };
    this.emit();
  }

  setPlaying(playing: boolean): void {
    this.state = { ...this.state, playing };
    this.emit();
  }

  setLoopPreview(loopPreview: boolean): void {
    this.state = { ...this.state, loopPreview };
    this.emit();
  }

  setPlaybackRate(playbackRate: number): void {
    this.state = { ...this.state, playbackRate };
    this.emit();
  }

  setTrim(patch: TrimPatch): boolean {
    const duration = this.state.duration;
    const hasDuration = duration > 0;

    const nextStart = patch.trimStart ?? this.state.trimStart;
    const nextEnd = patch.trimEnd ?? this.state.trimEnd;

    if (!hasDuration) {
      this.state = { ...this.state, error: 'Load a video first.' };
      this.emit();
      return false;
    }

    const clampedStart = clamp(nextStart, 0, duration);
    const clampedEnd = clamp(nextEnd, 0, duration);

    if (clampedStart >= clampedEnd - EPSILON) {
      this.state = {
        ...this.state,
        error: 'Trim start must be less than trim end.',
      };
      this.emit();
      return false;
    }

    this.state = {
      ...this.state,
      trimStart: clampedStart,
      trimEnd: clampedEnd,
      error: null,
    };
    this.emit();
    return true;
  }

  setExportState(patch: { exporting?: boolean; exportProgress?: number; exportMessage?: string | null }): void {
    this.state = {
      ...this.state,
      exporting: patch.exporting ?? this.state.exporting,
      exportProgress: patch.exportProgress ?? this.state.exportProgress,
      exportMessage: patch.exportMessage ?? this.state.exportMessage,
    };
    this.emit();
  }

  clearExportMessage(): void {
    if (!this.state.exportMessage) {
      return;
    }
    this.state = { ...this.state, exportMessage: null };
    this.emit();
  }

  clearError(): void {
    if (!this.state.error) {
      return;
    }
    this.state = { ...this.state, error: null };
    this.emit();
  }

  // Creator mode methods

  setComposition(composition: Composition | null): void {
    this.state = { ...this.state, composition, selectedSceneId: null, creatorFrame: 0 };
    this.emit();
  }

  addScene(scene: Scene): void {
    if (!this.state.composition) return;
    const scenes = [...this.state.composition.scenes, scene];
    this.state = {
      ...this.state,
      composition: { ...this.state.composition, scenes },
      selectedSceneId: scene.id,
    };
    this.emit();
  }

  removeScene(id: string): void {
    if (!this.state.composition) return;
    const scenes = this.state.composition.scenes.filter((s) => s.id !== id);
    this.state = {
      ...this.state,
      composition: { ...this.state.composition, scenes },
      selectedSceneId: this.state.selectedSceneId === id ? null : this.state.selectedSceneId,
    };
    this.emit();
  }

  updateScene(id: string, updatedScene: Scene): void {
    if (!this.state.composition) return;
    const scenes = this.state.composition.scenes.map((s) => (s.id === id ? updatedScene : s));
    this.state = {
      ...this.state,
      composition: { ...this.state.composition, scenes },
    };
    this.emit();
  }

  reorderScenes(ids: string[]): void {
    if (!this.state.composition) return;
    const sceneMap = new Map(this.state.composition.scenes.map((s) => [s.id, s]));
    const reordered = ids.map((id) => sceneMap.get(id)).filter(Boolean) as Scene[];
    // Add any scenes not in the list at the end
    for (const scene of this.state.composition.scenes) {
      if (!ids.includes(scene.id)) reordered.push(scene);
    }
    this.state = {
      ...this.state,
      composition: { ...this.state.composition, scenes: reordered },
    };
    this.emit();
  }

  setSelectedScene(id: string | null): void {
    this.state = { ...this.state, selectedSceneId: id };
    this.emit();
  }

  setCreatorPlaying(playing: boolean): void {
    this.state = { ...this.state, creatorPlaying: playing };
    this.emit();
  }

  setCreatorFrame(frame: number): void {
    this.state = { ...this.state, creatorFrame: frame };
    this.emit();
  }

  updateCompositionConfig(patch: { width?: number; height?: number; fps?: number; durationInFrames?: number }): void {
    if (!this.state.composition) return;
    this.state = {
      ...this.state,
      composition: {
        ...this.state.composition,
        config: { ...this.state.composition.config, ...patch },
      },
    };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
