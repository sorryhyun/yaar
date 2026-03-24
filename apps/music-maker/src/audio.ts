import * as Tone from '@bundled/tone';
import type { DrumPattern, MelodyNote } from './types';
import { STEP_COUNT } from './types';
import { setCurrentStep } from './store';

// ── Instruments ──────────────────────────────────────────────────────────────

const kick = new Tone.MembraneSynth({
  pitchDecay: 0.08, octaves: 8,
  envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
}).toDestination();

const snare = new Tone.NoiseSynth({
  noise: { type: 'white' },
  envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 },
}).toDestination();
snare.volume.value = -6;

const hihat = new Tone.MetalSynth({
  envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
  harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5,
}).toDestination();
hihat.frequency.value = 400;
hihat.volume.value = -12;

const perc = new Tone.MetalSynth({
  envelope: { attack: 0.001, decay: 0.1, release: 0.05 },
  harmonicity: 3.1, modulationIndex: 16, resonance: 2000, octaves: 0.5,
}).toDestination();
perc.frequency.value = 200;
perc.volume.value = -8;

const reverb = new Tone.Reverb({ decay: 1.5, wet: 0.25 }).toDestination();

const melodySynth = new Tone.PolySynth(Tone.Synth, {
  oscillator: { type: 'triangle' },
  envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.5 },
}).connect(reverb);
melodySynth.volume.value = -6;

// ── Sequences ─────────────────────────────────────────────────────────────────

let drumSeq: Tone.Sequence | null = null;
let melodyPart: Tone.Part | null = null;

export function startTransport(bpm: number) {
  Tone.getTransport().bpm.value = bpm;
  Tone.getTransport().start();
}

export function stopTransport() {
  Tone.getTransport().stop();
  Tone.getTransport().position = 0;
  setCurrentStep(-1);
}

export function setBpmValue(bpm: number) {
  Tone.getTransport().bpm.value = bpm;
}

export function scheduleDrums(pattern: DrumPattern) {
  if (drumSeq) { drumSeq.stop(); drumSeq.dispose(); drumSeq = null; }

  const steps = Array.from({ length: STEP_COUNT }, (_, i) => i);

  drumSeq = new Tone.Sequence((time, step) => {
    setCurrentStep(step as number);
    const s = step as number;
    if (pattern.kick[s])  kick.triggerAttackRelease('C1', '8n', time);
    if (pattern.snare[s]) snare.triggerAttackRelease('8n', time);
    if (pattern.hihat[s]) hihat.triggerAttackRelease('8n', time);
    if (pattern.perc[s])  perc.triggerAttackRelease('8n', time);
  }, steps, '8n');

  drumSeq.start(0);
}

export function scheduleMelody(notes: MelodyNote[]) {
  if (melodyPart) { melodyPart.stop(); melodyPart.dispose(); melodyPart = null; }
  if (notes.length === 0) return;

  const events = notes.map(n => ({
    time: `${n.time * 0.5}*8n` as Tone.Unit.Time,
    note: n.note,
    duration: n.duration,
  }));

  melodyPart = new Tone.Part((time, ev: { note: string; duration: string }) => {
    melodySynth.triggerAttackRelease(ev.note, ev.duration, time);
  }, events);

  melodyPart.loop = true;
  melodyPart.loopEnd = '1m';
  melodyPart.start(0);
}

export async function initAudio() {
  await Tone.start();
}
