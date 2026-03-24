export type ScaleType = 'major' | 'minor' | 'pentatonic' | 'blues' | 'dorian' | 'mixolydian';
export type ChordProgression = 'I-IV-V-I' | 'I-V-vi-IV' | 'ii-V-I' | 'I-vi-IV-V' | 'I-IV-I-V';

export interface DrumPattern {
  kick: boolean[];
  snare: boolean[];
  hihat: boolean[];
  perc: boolean[];
}

export interface MelodyNote {
  note: string;
  duration: string;
  time: number; // in steps
}

export interface AppState {
  bpm: number;
  isPlaying: boolean;
  scale: ScaleType;
  chordProgression: ChordProgression;
  drumPattern: DrumPattern;
  melodyPattern: MelodyNote[];
  currentStep: number;
}

export const SCALES: Record<ScaleType, number[]> = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  blues:      [0, 3, 5, 6, 7, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export const CHORD_PROGRESSIONS: Record<ChordProgression, number[][]> = {
  'I-IV-V-I':   [[0,4,7],[5,9,12],[7,11,14],[0,4,7]],
  'I-V-vi-IV':  [[0,4,7],[7,11,14],[9,12,16],[5,9,12]],
  'ii-V-I':     [[2,5,9],[7,11,14],[0,4,7],[0,4,7]],
  'I-vi-IV-V':  [[0,4,7],[9,12,16],[5,9,12],[7,11,14]],
  'I-IV-I-V':   [[0,4,7],[5,9,12],[0,4,7],[7,11,14]],
};

export const SCALE_LABELS: Record<ScaleType, string> = {
  major: 'Major', minor: 'Minor', pentatonic: 'Pentatonic',
  blues: 'Blues', dorian: 'Dorian', mixolydian: 'Mixolydian',
};

export const STEP_COUNT = 16;
export const ROOT_NOTE = 'C4';
export const ROOT_MIDI = 60;
