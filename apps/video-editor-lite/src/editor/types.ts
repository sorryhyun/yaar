import type { Composition } from '../core/types';

export type SourceKind = 'url' | 'file' | null;
export type EditorMode = 'edit' | 'create';

export interface EditorState {
  mode: EditorMode;
  sourceKind: SourceKind;
  sourceValue: string;
  objectUrl: string | null;
  duration: number;
  trimStart: number;
  trimEnd: number;
  currentTime: number;
  playbackRate: number;
  loopPreview: boolean;
  playing: boolean;
  exporting: boolean;
  exportProgress: number;
  exportMessage: string | null;
  error: string | null;
  // Creator mode state
  composition: Composition | null;
  selectedSceneId: string | null;
  creatorPlaying: boolean;
  creatorFrame: number;
}

export interface TrimPatch {
  trimStart?: number;
  trimEnd?: number;
}
