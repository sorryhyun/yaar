import * as Tone from '@bundled/tone';

let ready = false;

export async function ensureAudio(): Promise<void> {
  if (ready) return;
  await Tone.start();
  ready = true;
}

function synth(options: Tone.SynthOptions) {
  return new Tone.Synth(options).toDestination();
}

function makeMoveSound() {
  const s = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.05 },
    volume: -18,
  }).toDestination();
  return () => {
    try { s.triggerAttackRelease('C4', '32n'); } catch {}
  };
}

function makeRotateSound() {
  const s = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
    volume: -16,
  }).toDestination();
  return () => {
    try { s.triggerAttackRelease('E4', '32n'); } catch {}
  };
}

function makeDropSound() {
  const s = new Tone.Synth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.08 },
    volume: -14,
  }).toDestination();
  return () => {
    try { s.triggerAttackRelease('G3', '16n'); } catch {}
  };
}

function makeLockSound() {
  const s = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.06 },
    volume: -20,
  }).toDestination();
  return () => {
    try { s.triggerAttackRelease('A3', '32n'); } catch {}
  };
}

function makeClearSound() {
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.4 },
    volume: -10,
  }).toDestination();
  return (lines: number) => {
    try {
      if (lines === 4) {
        s.triggerAttackRelease(['C5', 'E5', 'G5', 'B5'], '8n');
      } else if (lines === 3) {
        s.triggerAttackRelease(['C5', 'E5', 'G5'], '8n');
      } else if (lines === 2) {
        s.triggerAttackRelease(['C5', 'E5'], '8n');
      } else {
        s.triggerAttackRelease(['C5'], '8n');
      }
    } catch {}
  };
}

function makeGameOverSound() {
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.05, decay: 0.4, sustain: 0.2, release: 0.6 },
    volume: -12,
  }).toDestination();
  return () => {
    try {
      const now = Tone.now();
      s.triggerAttackRelease('G4', '8n', now);
      s.triggerAttackRelease('Eb4', '8n', now + 0.15);
      s.triggerAttackRelease('C4', '4n', now + 0.3);
    } catch {}
  };
}

function makeLevelUpSound() {
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.3 },
    volume: -12,
  }).toDestination();
  return () => {
    try {
      const now = Tone.now();
      s.triggerAttackRelease('C5', '16n', now);
      s.triggerAttackRelease('E5', '16n', now + 0.1);
      s.triggerAttackRelease('G5', '8n', now + 0.2);
    } catch {}
  };
}

export const sounds = {
  move: makeMoveSound(),
  rotate: makeRotateSound(),
  drop: makeDropSound(),
  lock: makeLockSound(),
  clear: makeClearSound(),
  gameOver: makeGameOverSound(),
  levelUp: makeLevelUpSound(),
};
