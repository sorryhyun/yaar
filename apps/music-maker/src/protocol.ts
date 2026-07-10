import { app, defineCommand } from '@bundled/yaar';
import {
  bpm,
  isPlaying,
  scale,
  chordProgression,
  drumPattern,
  melodyPattern,
  currentStep,
  setBpm,
  setScale,
  setChordProgression,
  setDrumPattern,
  setMelodyPattern,
} from './store';
import type { ScaleType, ChordProgression } from './types';
import { generateMelody, randomizeDrumPattern } from './melody';
import { startTransport, stopTransport, setBpmValue, scheduleDrums, scheduleMelody } from './audio';

export function registerProtocol(onPlay: () => void, onStop: () => void) {
  if (!app) return;

  app.register({
    appId: 'music-maker',
    name: 'Music Maker',
    state: {
      getState: {
        description:
          'Get full app state including bpm, isPlaying, scale, chordProgression, drumPattern, melodyPattern',
        handler: () => ({
          bpm: bpm(),
          isPlaying: isPlaying(),
          scale: scale(),
          chordProgression: chordProgression(),
          drumPattern: drumPattern(),
          melodyPattern: melodyPattern(),
          currentStep: currentStep(),
        }),
      },
    },
    commands: {
      play: defineCommand({
        description: 'Start playback',
        params: { type: 'object', properties: {} },
        handler: () => {
          onPlay();
        },
      }),
      stop: defineCommand({
        description: 'Stop playback',
        params: { type: 'object', properties: {} },
        handler: () => {
          onStop();
        },
      }),
      setBpm: defineCommand({
        description: 'Set BPM',
        params: { type: 'object', properties: { bpm: { type: 'number' } }, required: ['bpm'] },
        handler: (p) => {
          setBpm(p.bpm);
          setBpmValue(p.bpm);
          return { bpm: p.bpm };
        },
      }),
      setScale: defineCommand({
        description: 'Set musical scale',
        params: { type: 'object', properties: { scale: { type: 'string' } }, required: ['scale'] },
        handler: (p) => {
          setScale(p.scale as ScaleType);
        },
      }),
      generateMelody: defineCommand({
        description: 'Generate a new melody based on current scale and chord progression',
        params: { type: 'object', properties: {} },
        handler: () => {
          const notes = generateMelody(scale(), chordProgression());
          setMelodyPattern(notes);
          scheduleMelody(notes);
          return { noteCount: notes.length };
        },
      }),
      setDrumStep: defineCommand({
        description: 'Toggle a drum step on/off',
        params: {
          type: 'object',
          properties: {
            track: { type: 'string', enum: ['kick', 'snare', 'hihat', 'perc'] },
            step: { type: 'number' },
            active: { type: 'boolean' },
          },
          required: ['track', 'step', 'active'],
        },
        handler: (p) => {
          const pat = { ...drumPattern() };
          const arr = [...pat[p.track]];
          arr[p.step] = p.active;
          pat[p.track] = arr;
          setDrumPattern(pat);
          scheduleDrums(pat);
        },
      }),
      randomizeDrums: defineCommand({
        description: 'Randomize the drum pattern',
        params: { type: 'object', properties: {} },
        handler: () => {
          const pat = randomizeDrumPattern();
          setDrumPattern(pat);
          scheduleDrums(pat);
        },
      }),
    },
  });
}
