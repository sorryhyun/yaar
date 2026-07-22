import { createSignal } from '@bundled/solid-js';
import type { ScaleType, ChordProgression, DrumPattern, MelodyNote, AppState, StepSettingsPattern, TrackSettings, TrackKey } from './types';
import { STEP_COUNT } from './types';

const keys: TrackKey[] = ['kick', 'snare', 'hihat', 'perc'];
function emptyDrum(): boolean[] { return Array(STEP_COUNT).fill(false); }
function defaultDrum(): DrumPattern {
  const kick = emptyDrum(), snare = emptyDrum(), hihat = emptyDrum(), perc = emptyDrum();
  [0,4,8,12].forEach(i => kick[i] = true);
  [4,12].forEach(i => snare[i] = true);
  [0,2,4,6,8,10,12,14].forEach(i => hihat[i] = true);
  return { kick, snare, hihat, perc };
}
function defaultSteps(): StepSettingsPattern {
  return Object.fromEntries(keys.map(k => [k, Array.from({ length: STEP_COUNT }, () => ({ velocity: 0.8, probability: 1 }))])) as StepSettingsPattern;
}
function defaultTracks(): TrackSettings {
  return Object.fromEntries(keys.map(k => [k, { volume: 0.8, muted: false, solo: false }])) as TrackSettings;
}
export const [bpm, setBpm] = createSignal(120);
export const [isPlaying, setIsPlaying] = createSignal(false);
export const [scale, setScale] = createSignal<ScaleType>('minor');
export const [chordProgression, setChordProgression] = createSignal<ChordProgression>('I-V-vi-IV');
export const [drumPattern, setDrumPattern] = createSignal<DrumPattern>(defaultDrum());
export const [stepSettings, setStepSettings] = createSignal<StepSettingsPattern>(defaultSteps());
export const [trackSettings, setTrackSettings] = createSignal<TrackSettings>(defaultTracks());
export const [metronome, setMetronome] = createSignal(false);
export const [countIn, setCountIn] = createSignal(false);
export const [melodyPattern, setMelodyPattern] = createSignal<MelodyNote[]>([]);
export const [currentStep, setCurrentStep] = createSignal(-1);

export function getFullState(): AppState {
  return { bpm: bpm(), isPlaying: isPlaying(), scale: scale(), chordProgression: chordProgression(), drumPattern: drumPattern(), melodyPattern: melodyPattern(), currentStep: currentStep(), metronome: metronome(), countIn: countIn(), trackSettings: trackSettings(), stepSettings: stepSettings() };
}