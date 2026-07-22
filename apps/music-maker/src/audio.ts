import * as Tone from '@bundled/tone';
import type { DrumPattern, MelodyNote, StepSettingsPattern, TrackSettings, TrackKey } from './types';
import { STEP_COUNT } from './types';
import { setCurrentStep } from './store';

const kick = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 8, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 } }).toDestination();
const snare = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 } }).toDestination();
const hihat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.05, release: 0.01 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).toDestination();
const perc = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.1, release: 0.05 }, harmonicity: 3.1, modulationIndex: 16, resonance: 2000, octaves: 0.5 }).toDestination();
hihat.frequency.value = 400; perc.frequency.value = 200;
const reverb = new Tone.Reverb({ decay: 1.5, wet: 0.25 }).toDestination();
const melodySynth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.5 } }).connect(reverb);
const click = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.035, sustain: 0, release: 0.02 } }).toDestination();
click.volume.value = -18;

let drumSeq: Tone.Sequence | null = null;
let melodyPart: Tone.Part | null = null;
let metroSeq: Tone.Sequence | null = null;
const instruments: Record<TrackKey, { volume: { value: number }; triggerAttackRelease: (note: string, duration: string, time: number, velocity?: number) => void }> = { kick, snare, hihat, perc };

export function startTransport(value: number) { Tone.getTransport().bpm.value = value; Tone.getTransport().start(); }
export function stopTransport() {
  Tone.getTransport().stop(); Tone.getTransport().position = 0; setCurrentStep(-1);
  [drumSeq, melodyPart, metroSeq].forEach(seq => seq?.stop());
}
export function setBpmValue(value: number) { Tone.getTransport().bpm.value = value; }

export function setMixer(mix: TrackSettings) {
  const hasSolo = Object.values(mix).some(t => t.solo);
  (Object.keys(instruments) as TrackKey[]).forEach(key => {
    const setting = mix[key];
    instruments[key].volume.value = setting.muted || (hasSolo && !setting.solo) ? -60 : -30 + setting.volume * 30;
  });
}

export function scheduleMetronome(enabled: boolean) {
  if (metroSeq) { metroSeq.stop(); metroSeq.dispose(); metroSeq = null; }
  if (!enabled) return;
  metroSeq = new Tone.Sequence((time, beat) => {
    click.triggerAttackRelease(beat === 0 ? 'C6' : 'G5', '32n', time);
  }, [0, 1, 2, 3], '4n');
  metroSeq.loop = true; metroSeq.start(0);
}

export function scheduleDrums(pattern: DrumPattern, settings: StepSettingsPattern, startAt = 0) {
  if (drumSeq) { drumSeq.stop(); drumSeq.dispose(); drumSeq = null; }
  drumSeq = new Tone.Sequence((time, step) => {
    const s = step as number; setCurrentStep(s);
    (Object.keys(instruments) as TrackKey[]).forEach(track => {
      const detail = settings[track][s];
      if (pattern[track][s] && Math.random() <= detail.probability) {
        const note = track === 'kick' ? 'C1' : track === 'perc' ? 'C2' : track === 'hihat' ? 'C4' : '8n';
        instruments[track].triggerAttackRelease(note, '8n', time, detail.velocity);
      }
    });
  }, Array.from({ length: STEP_COUNT }, (_, i) => i), '8n');
  drumSeq.loop = true; drumSeq.start(startAt);
}

export function scheduleMelody(notes: MelodyNote[], startAt = 0) {
  if (melodyPart) { melodyPart.stop(); melodyPart.dispose(); melodyPart = null; }
  if (!notes.length) return;
  const events = notes.map(n => ({ time: `${n.time * 0.5}*8n` as Tone.Unit.Time, note: n.note, duration: n.duration }));
  melodyPart = new Tone.Part((time, ev: { note: string; duration: string }) => melodySynth.triggerAttackRelease(ev.note, ev.duration, time), events);
  melodyPart.loop = true; melodyPart.loopEnd = '1m'; melodyPart.start(startAt);
}
export async function initAudio() { await Tone.start(); }