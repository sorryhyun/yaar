import type { EditorState, TrimPatch } from './types';
import { clamp } from './utils/time';

const EPSILON = 0.01;

type Listener = (state: EditorState) => void;

export class EditorStore {
  private state: EditorState = {
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

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
