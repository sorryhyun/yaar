export type SourceKind = 'url' | 'file' | null;

export interface EditorState {
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
  error: string | null;
}

export interface TrimPatch {
  trimStart?: number;
  trimEnd?: number;
}
