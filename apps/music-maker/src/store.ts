import { createSignal } from '@bundled/solid-js';
import type { ScaleType, ChordProgression, DrumPattern, MelodyNote, AppState } from './types';
import { STEP_COUNT } from './types';

function emptyDrum(): boolean[] {
  return Array(STEP_COUNT).fill(false);
}

function defaultDrum(): DrumPattern {
  const kick   = emptyDrum();
  const snare  = emptyDrum();
  const hihat  = emptyDrum();
  const perc   = emptyDrum();
  // basic 4-on-the-floor
  kick[0] = kick[4] = kick[8] = kick[12] = true;
  snare[4] = snare[12] = true;
  hihat[0] = hihat[2] = hihat[4] = hihat[6] = hihat[8] = hihat[10] = hihat[12] = hihat[14] = true;
  return { kick, snare, hihat, perc };
}

export const [bpm, setBpm] = createSignal(120);
export const [isPlaying, setIsPlaying] = createSignal(false);
export const [scale, setScale] = createSignal<ScaleType>('minor');
export const [chordProgression, setChordProgression] = createSignal<ChordProgression>('I-V-vi-IV');
export const [drumPattern, setDrumPattern] = createSignal<DrumPattern>(defaultDrum());
export const [melodyPattern, setMelodyPattern] = createSignal<MelodyNote[]>([]);
export const [currentStep, setCurrentStep] = createSignal(-1);

export function getFullState(): AppState {
  return {
    bpm: bpm(),
    isPlaying: isPlaying(),
    scale: scale(),
    chordProgression: chordProgression(),
    drumPattern: drumPattern(),
    melodyPattern: melodyPattern(),
    currentStep: currentStep(),
  };
}
