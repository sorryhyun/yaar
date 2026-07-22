import { app, defineCommand } from '@bundled/yaar';
import { getFullState, scale, chordProgression, drumPattern, stepSettings, trackSettings, setBpm, setScale, setDrumPattern, setStepSettings, setMelodyPattern, setTrackSettings } from './store';
import type { ScaleType, TrackKey } from './types';
import { generateMelody, randomizeDrumPattern } from './melody';
import { setBpmValue, scheduleDrums, scheduleMelody, setMixer } from './audio';

export function registerProtocol(onPlay: () => void, onStop: () => void) {
  if (!app) return;
  app.register({
    appId: 'music-maker', name: 'Music Maker',
    state: { getState: { description: 'Get the current transport, sequencer, mixer, probability and velocity state.', handler: getFullState } },
    commands: {
      play: defineCommand({ description: 'Start playback with the current transport settings.', handler: onPlay }),
      stop: defineCommand({ description: 'Stop playback and return to step one.', handler: onStop }),
      setBpm: defineCommand({ description: 'Set BPM (60–200).', params: { type: 'object', properties: { bpm: { type: 'number' } }, required: ['bpm'] }, handler: p => { setBpm(p.bpm); setBpmValue(p.bpm); return { bpm: p.bpm }; } }),
      setScale: defineCommand({ description: 'Set musical scale.', params: { type: 'object', properties: { scale: { type: 'string' } }, required: ['scale'] }, handler: p => setScale(p.scale as ScaleType) }),
      generateMelody: defineCommand({ description: 'Generate a melody from the current scale and progression.', handler: () => { const notes = generateMelody(scale(), chordProgression()); setMelodyPattern(notes); scheduleMelody(notes); return { noteCount: notes.length }; } }),
      setDrumStep: defineCommand({ description: 'Set a drum step and optionally its velocity/chance.', params: { type: 'object', properties: { track: { type: 'string', enum: ['kick','snare','hihat','perc'] }, step: { type: 'number' }, active: { type: 'boolean' }, velocity: { type: 'number' }, probability: { type: 'number' } }, required: ['track','step','active'] }, handler: p => {
        const track = p.track as TrackKey; const pat = { ...drumPattern(), [track]: [...drumPattern()[track]] }; pat[track][p.step] = p.active;
        const steps = { ...stepSettings(), [track]: [...stepSettings()[track]] };
        if (p.velocity !== undefined || p.probability !== undefined) steps[track][p.step] = { ...steps[track][p.step], ...(p.velocity !== undefined ? { velocity: p.velocity } : {}), ...(p.probability !== undefined ? { probability: p.probability } : {}) };
        setDrumPattern(pat); setStepSettings(steps); scheduleDrums(pat, steps);
      } }),
      setTrackMix: defineCommand({ description: 'Set a track volume (0–1), mute, or solo state.', params: { type: 'object', properties: { track: { type: 'string', enum: ['kick','snare','hihat','perc'] }, volume: { type: 'number' }, muted: { type: 'boolean' }, solo: { type: 'boolean' } }, required: ['track'] }, handler: p => { const track = p.track as TrackKey; const next = { ...trackSettings(), [track]: { ...trackSettings()[track], ...(p.volume !== undefined ? { volume: p.volume } : {}), ...(p.muted !== undefined ? { muted: p.muted } : {}), ...(p.solo !== undefined ? { solo: p.solo } : {}) } }; setTrackSettings(next); setMixer(next); return next[track]; } }),
      randomizeDrums: defineCommand({ description: 'Randomize the current drum pattern.', handler: () => { const pat = randomizeDrumPattern(); setDrumPattern(pat); scheduleDrums(pat, stepSettings()); } }),
    },
  });
}