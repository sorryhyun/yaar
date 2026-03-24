import { createEffect, onMount, onCleanup, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

import type { ScaleType, ChordProgression } from './types';
import { SCALE_LABELS, STEP_COUNT } from './types';
import {
  bpm, setBpm, isPlaying, setIsPlaying,
  scale, setScale, chordProgression, setChordProgression,
  drumPattern, setDrumPattern, melodyPattern, setMelodyPattern,
  currentStep,
} from './store';
import { generateMelody, randomizeDrumPattern } from './melody';
import {
  initAudio, startTransport, stopTransport, setBpmValue,
  scheduleDrums, scheduleMelody,
} from './audio';
import { drawVisualizer } from './canvas';
import { registerProtocol } from './protocol';
import { showToast } from '@bundled/yaar';

const SCALES: ScaleType[] = ['major', 'minor', 'pentatonic', 'blues', 'dorian', 'mixolydian'];
const PROGRESSIONS: ChordProgression[] = ['I-IV-V-I', 'I-V-vi-IV', 'ii-V-I', 'I-vi-IV-V', 'I-IV-I-V'];

const TRACK_COLORS: Record<string, string> = {
  kick: '#f85149', snare: '#e3b341', hihat: '#58a6ff', perc: '#bc8cff',
};

const TRACK_KEYS = ['kick', 'snare', 'hihat', 'perc'] as const;

function App() {
  let canvasRef!: HTMLCanvasElement;
  let rafId = 0;
  let audioReady = false;

  async function ensureAudio() {
    if (!audioReady) {
      await initAudio();
      audioReady = true;
    }
  }

  async function handlePlay() {
    await ensureAudio();
    if (isPlaying()) {
      stopTransport();
      setIsPlaying(false);
    } else {
      scheduleDrums(drumPattern());
      scheduleMelody(melodyPattern());
      startTransport(bpm());
      setIsPlaying(true);
    }
  }

  function handleStop() {
    stopTransport();
    setIsPlaying(false);
  }

  function handleGenerate() {
    const notes = generateMelody(scale(), chordProgression());
    setMelodyPattern(notes);
    if (isPlaying()) scheduleMelody(notes);
    showToast(`Generated ${notes.length} notes`, 'success');
  }

  function handleRandomizeDrums() {
    const pat = randomizeDrumPattern();
    setDrumPattern(pat);
    if (isPlaying()) scheduleDrums(pat);
    showToast('Drums randomized!', 'success');
  }

  function toggleStep(track: typeof TRACK_KEYS[number], step: number) {
    const pat = { ...drumPattern() };
    const arr = [...pat[track]];
    arr[step] = !arr[step];
    pat[track] = arr;
    setDrumPattern(pat);
    if (isPlaying()) scheduleDrums(pat);
  }

  function handleBpmInput(e: Event) {
    const v = parseInt((e.target as HTMLInputElement).value);
    setBpm(v);
    setBpmValue(v);
  }

  // Canvas render loop
  function startRaf() {
    function loop() {
      if (canvasRef) {
        // Resize canvas to display size
        const rect = canvasRef.getBoundingClientRect();
        if (canvasRef.width !== rect.width || canvasRef.height !== rect.height) {
          canvasRef.width = rect.width;
          canvasRef.height = rect.height;
        }
        drawVisualizer(canvasRef, currentStep(), drumPattern(), melodyPattern(), isPlaying());
      }
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
  }

  onMount(() => {
    startRaf();
    // Generate initial melody
    const notes = generateMelody(scale(), chordProgression());
    setMelodyPattern(notes);
    registerProtocol(handlePlay, handleStop);
  });

  onCleanup(() => {
    cancelAnimationFrame(rafId);
    stopTransport();
  });

  return html`
    <div class="app-root">
      <!-- Header -->
      <div class="header">
        <div class="header-title">
          <span class="icon">🎹</span>
          <span>Music Maker</span>
        </div>
        <div class="header-controls">
          <div class=${() => `transport-badge ${isPlaying() ? 'active' : ''}`}>
            <div class="dot"></div>
            ${() => isPlaying() ? 'Playing' : 'Stopped'}
          </div>
        </div>
      </div>

      <!-- Transport bar -->
      <div class="transport">
        <button
          class=${() => `btn-play ${isPlaying() ? 'playing' : ''}`}
          onClick=${handlePlay}
        >
          ${() => isPlaying() ? '■' : '▶'}
        </button>

        <div class="bpm-control">
          <label>BPM</label>
          <input
            type="range" class="bpm-slider"
            min="60" max="200" step="1"
            value=${bpm}
            onInput=${handleBpmInput}
          />
          <span class="bpm-value">${bpm}</span>
        </div>

        <button class="y-btn y-btn-sm" onClick=${handleGenerate}>
          ✨ Generate Melody
        </button>
        <button class="y-btn y-btn-sm" onClick=${handleRandomizeDrums}>
          🎲 Random Drums
        </button>
      </div>

      <!-- Main -->
      <div class="main">
        <!-- Sidebar -->
        <div class="sidebar">
          <div class="sidebar-section">
            <label>Scale</label>
            <select class="y-select" style="width:100%"
              value=${scale}
              onChange=${(e: Event) => setScale((e.target as HTMLSelectElement).value as ScaleType)}
            >
              ${() => SCALES.map(s => html`
                <option value=${s} selected=${() => scale() === s}>
                  ${SCALE_LABELS[s]}
                </option>
              `)}
            </select>
          </div>

          <div class="sidebar-section">
            <label>Chord Progression</label>
            <select class="y-select" style="width:100%"
              value=${chordProgression}
              onChange=${(e: Event) => setChordProgression((e.target as HTMLSelectElement).value as ChordProgression)}
            >
              ${() => PROGRESSIONS.map(p => html`
                <option value=${p} selected=${() => chordProgression() === p}>
                  ${p}
                </option>
              `)}
            </select>
          </div>

          <div class="sidebar-section">
            <label>Info</label>
            <div style="font-size:11px;color:var(--yaar-text-muted);line-height:1.6">
              <div>Scale: <span style="color:var(--yaar-text)">${() => SCALE_LABELS[scale()]}</span></div>
              <div>Prog: <span style="color:var(--yaar-text)">${chordProgression}</span></div>
              <div>Notes: <span style="color:var(--yaar-accent)">${() => melodyPattern().length}</span></div>
              <div>Step: <span style="color:var(--yaar-accent)">${() => currentStep() >= 0 ? currentStep() + 1 : '-'}/16</span></div>
            </div>
          </div>

          <div class="sidebar-section">
            <label>Tracks</label>
            ${() => TRACK_KEYS.map(t => html`
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <span style=${`width:8px;height:8px;border-radius:50%;background:${TRACK_COLORS[t]};display:inline-block`}></span>
                <span style="font-size:11px">${t.toUpperCase()}</span>
                <span style="margin-left:auto;font-size:10px;color:var(--yaar-text-muted)">
                  ${() => drumPattern()[t].filter(Boolean).length}/16
                </span>
              </div>
            `)}
          </div>
        </div>

        <!-- Canvas + Drum grid -->
        <div class="canvas-area">
          <canvas ref=${(el: HTMLCanvasElement) => { canvasRef = el; }} class="visualizer-canvas"></canvas>

          <!-- Interactive drum grid -->
          <div class="drum-grid">
            <div class="drum-grid-header">
              <span>STEP SEQUENCER</span>
              <span style="color:var(--yaar-text-muted);font-size:10px">click to toggle steps</span>
            </div>

            <!-- Beat markers -->
            <div class="drum-beat-markers">
              ${() => Array.from({ length: STEP_COUNT }, (_, i) => html`
                <div class=${`beat-marker ${i % 4 === 0 ? 'strong' : ''}`}>
                  ${i % 4 === 0 ? String(i / 4 + 1) : ''}
                </div>
              `)}
            </div>

            ${() => TRACK_KEYS.map(track => html`
              <div class="drum-row">
                <span class="drum-label" style=${`color:${TRACK_COLORS[track]}`}>
                  ${track.toUpperCase()}
                </span>
                <div class="drum-steps">
                  ${() => drumPattern()[track].map((active, si) => html`
                    <button
                      class=${() =>
                        `step-btn${active ? ' active' : ''}${si === currentStep() && isPlaying() ? ' current-step' : ''}`
                      }
                      style=${() =>
                        active
                          ? `background:${TRACK_COLORS[track]}${si === currentStep() && isPlaying() ? '' : '99'};border-color:transparent`
                          : `background:transparent`
                      }
                      onClick=${() => toggleStep(track, si)}
                    ></button>
                  `)}
                </div>
              </div>
            `)}
          </div>
        </div>
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.body);
