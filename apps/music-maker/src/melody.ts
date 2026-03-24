import type { ScaleType, ChordProgression, MelodyNote } from './types';
import { SCALES, CHORD_PROGRESSIONS, ROOT_MIDI, STEP_COUNT } from './types';

function midiToNote(midi: number): string {
  const notes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const octave = Math.floor(midi / 12) - 1;
  const name = notes[midi % 12];
  return `${name}${octave}`;
}

function getScaleNotes(scaleType: ScaleType, rootMidi: number, octaves = 2): string[] {
  const intervals = SCALES[scaleType];
  const notes: string[] = [];
  for (let oct = 0; oct < octaves; oct++) {
    for (const interval of intervals) {
      notes.push(midiToNote(rootMidi + oct * 12 + interval));
    }
  }
  return notes;
}

const DURATIONS = ['8n', '8n', '8n', '4n', '4n', '16n'];

// Markov-style weights: prefer staying near current note
function nextNoteIndex(current: number, total: number): number {
  const weights: number[] = [];
  for (let i = 0; i < total; i++) {
    const dist = Math.abs(i - current);
    weights.push(Math.max(0.1, 1 / (dist + 1) ** 1.5));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < total; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return current;
}

export function generateMelody(
  scaleType: ScaleType,
  progression: ChordProgression,
  steps = STEP_COUNT
): MelodyNote[] {
  const scaleNotes = getScaleNotes(scaleType, ROOT_MIDI, 2);
  const chords = CHORD_PROGRESSIONS[progression];
  const notes: MelodyNote[] = [];

  let noteIdx = Math.floor(scaleNotes.length / 4); // start mid-low
  let stepPos = 0;

  const stepsPerChord = steps / chords.length; // 4 steps each

  for (let ci = 0; ci < chords.length; ci++) {
    const chordMidis = chords[ci].map(i => ROOT_MIDI + i);
    const chordNoteNames = chordMidis.map(m => midiToNote(m));

    // On chord change, snap to nearest chord tone
    const chordIndices = scaleNotes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => chordNoteNames.some(cn => cn === n || cn.replace(/\d/, '') === n.replace(/\d/, '')))
      .map(({ i }) => i);

    if (chordIndices.length > 0) {
      noteIdx = chordIndices.reduce((closest, idx) =>
        Math.abs(idx - noteIdx) < Math.abs(closest - noteIdx) ? idx : closest
      , chordIndices[0]);
    }

    let localStep = 0;
    while (localStep < stepsPerChord) {
      const dur = DURATIONS[Math.floor(Math.random() * DURATIONS.length)];
      const durSteps = dur === '4n' ? 2 : dur === '16n' ? 0.5 : 1;

      // Occasional rest (20%)
      if (Math.random() < 0.2) {
        localStep += durSteps;
        stepPos += durSteps;
        continue;
      }

      notes.push({
        note: scaleNotes[noteIdx],
        duration: dur,
        time: stepPos,
      });

      noteIdx = nextNoteIndex(noteIdx, scaleNotes.length);
      // Clamp
      noteIdx = Math.max(0, Math.min(scaleNotes.length - 1, noteIdx));

      localStep += durSteps;
      stepPos += durSteps;
    }
  }

  return notes;
}

export function randomizeDrumPattern() {
  const rand = (density: number) =>
    Array.from({ length: STEP_COUNT }, () => Math.random() < density);
  return {
    kick:  rand(0.25),
    snare: rand(0.20),
    hihat: rand(0.50),
    perc:  rand(0.15),
  };
}
