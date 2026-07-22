import { createSignal, onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import type { ScaleType, ChordProgression, TrackKey, PatternSnapshot, StepSettingsPattern, TrackSettings } from './types';
import { SCALE_LABELS, STEP_COUNT } from './types';
import { bpm, setBpm, isPlaying, setIsPlaying, scale, setScale, chordProgression, setChordProgression, drumPattern, setDrumPattern, stepSettings, setStepSettings, trackSettings, setTrackSettings, metronome, setMetronome, countIn, setCountIn, melodyPattern, setMelodyPattern, currentStep } from './store';
import { generateMelody, randomizeDrumPattern } from './melody';
import { initAudio, startTransport, stopTransport, setBpmValue, scheduleDrums, scheduleMelody, scheduleMetronome, setMixer } from './audio';
import { drawVisualizer } from './canvas';
import { registerProtocol } from './protocol';
import { appStorage, createCollapsiblePanel, showPrompt, showToast } from '@bundled/yaar';

const SCALES: ScaleType[] = ['major', 'minor', 'pentatonic', 'blues', 'dorian', 'mixolydian'];
const PROGRESSIONS: ChordProgression[] = ['I-IV-V-I', 'I-V-vi-IV', 'ii-V-I', 'I-vi-IV-V', 'I-IV-I-V'];
const TRACK_KEYS: TrackKey[] = ['kick', 'snare', 'hihat', 'perc'];
const TRACK_COLORS: Record<TrackKey, string> = { kick: 'var(--yaar-error)', snare: 'var(--yaar-warning)', hihat: 'var(--yaar-accent)', perc: '#bc8cff' };

function App() {
  let canvasRef!: HTMLCanvasElement;
  let rafId = 0;
  let audioReady = false;
  const panel = createCollapsiblePanel({ closeDelayMs: 420, pinKey: 'music-maker.sidebar' });
  const [savedPatterns, setSavedPatterns] = createSignal<string[]>([]);
  const [selectedPattern, setSelectedPattern] = createSignal('');

  async function ensureAudio() { if (!audioReady) { await initAudio(); audioReady = true; setMixer(trackSettings()); } }
  function reschedule(startAt = 0) {
    scheduleDrums(drumPattern(), stepSettings(), startAt);
    scheduleMelody(melodyPattern(), startAt);
    scheduleMetronome(metronome());
  }
  async function handlePlay() {
    await ensureAudio();
    if (isPlaying()) { handleStop(); return; }
    const startAt = countIn() ? 240 / bpm() : 0;
    reschedule(startAt);
    startTransport(bpm());
    setIsPlaying(true);
    showToast(countIn() ? 'Count-in: one bar' : 'Playback started', 'success');
  }
  function handleStop() { stopTransport(); setIsPlaying(false); }
  function handleGenerate() {
    const notes = generateMelody(scale(), chordProgression());
    setMelodyPattern(notes);
    if (isPlaying()) scheduleMelody(notes);
    showToast(`Generated ${notes.length} notes`, 'success');
  }
  function handleRandomizeDrums() {
    const pat = randomizeDrumPattern(); setDrumPattern(pat);
    if (isPlaying()) scheduleDrums(pat, stepSettings());
    showToast('Drums randomized', 'success');
  }
  function updateMixer(track: TrackKey, patch: Partial<TrackSettings[TrackKey]>) {
    const next = { ...trackSettings(), [track]: { ...trackSettings()[track], ...patch } };
    setTrackSettings(next); setMixer(next);
  }
  function editStep(track: TrackKey, step: number, event: MouseEvent) {
    const pat = { ...drumPattern(), [track]: [...drumPattern()[track]] };
    const details: StepSettingsPattern = { ...stepSettings(), [track]: [...stepSettings()[track]] };
    const current = details[track][step];
    if (event.altKey || event.metaKey) {
      pat[track][step] = true;
      details[track][step] = { ...current, probability: current.probability >= 1 ? 0.5 : Number((current.probability + 0.25).toFixed(2)) };
    } else if (event.shiftKey) {
      pat[track][step] = true;
      details[track][step] = { ...current, velocity: current.velocity >= 1 ? 0.45 : Number((current.velocity + 0.15).toFixed(2)) };
    } else pat[track][step] = !pat[track][step];
    setDrumPattern(pat); setStepSettings(details);
    if (isPlaying()) scheduleDrums(pat, details);
  }
  function handleBpmInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    setBpm(value); setBpmValue(value);
  }
  function snapshot(name: string): PatternSnapshot {
    return { name, bpm: bpm(), scale: scale(), chordProgression: chordProgression(), drumPattern: drumPattern(), stepSettings: stepSettings(), melodyPattern: melodyPattern(), trackSettings: trackSettings(), savedAt: Date.now() };
  }
  async function refreshPatterns() {
    const entries = await appStorage.list('patterns');
    setSavedPatterns(entries.map(entry => entry.path.replace(/^patterns\//, '').replace(/\.json$/, '')).sort());
  }
  async function savePattern(copy = false) {
    const suggestion = copy ? `${selectedPattern() || 'Untitled'} copy` : selectedPattern() || 'Untitled';
    const name = await showPrompt(copy ? 'Name the duplicate pattern' : 'Save pattern as', { title: copy ? 'Duplicate pattern' : 'Save pattern', initial: suggestion });
    if (!name?.trim()) return;
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '-');
    await appStorage.save(`patterns/${clean}.json`, JSON.stringify(snapshot(clean)));
    setSelectedPattern(clean); await refreshPatterns(); showToast(`Saved “${clean}”`, 'success');
  }
  async function loadPattern(name: string) {
    if (!name) return;
    try {
      const saved = await appStorage.readJson<PatternSnapshot>(`patterns/${name}.json`);
      setBpm(saved.bpm); setBpmValue(saved.bpm); setScale(saved.scale); setChordProgression(saved.chordProgression);
      setDrumPattern(saved.drumPattern); setStepSettings(saved.stepSettings); setMelodyPattern(saved.melodyPattern); setTrackSettings(saved.trackSettings); setMixer(saved.trackSettings);
      setSelectedPattern(name); if (isPlaying()) reschedule(); showToast(`Loaded “${name}”`, 'success');
    } catch { showToast('Could not load that pattern', 'error'); }
  }
  function startRaf() {
    const loop = () => {
      if (canvasRef) {
        const rect = canvasRef.getBoundingClientRect();
        if (canvasRef.width !== Math.round(rect.width) || canvasRef.height !== Math.round(rect.height)) { canvasRef.width = Math.round(rect.width); canvasRef.height = Math.round(rect.height); }
        drawVisualizer(canvasRef, currentStep(), drumPattern(), melodyPattern(), isPlaying());
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  onMount(() => {
    startRaf(); setMelodyPattern(generateMelody(scale(), chordProgression())); refreshPatterns(); registerProtocol(handlePlay, handleStop);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { panel.setPin(false); panel.close(); } if (event.code === 'Space' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) { event.preventDefault(); handlePlay(); } };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });
  onCleanup(() => { cancelAnimationFrame(rafId); stopTransport(); });

  return html`
    <div class="app-root">
      <header class="header">
        <div class="header-title"><span class="icon">🎹</span><span>Music Maker</span><span class="header-subtitle">16-step studio</span></div>
        <div class=${() => `transport-badge ${isPlaying() ? 'active' : ''}`}><span class="dot"></span>${() => isPlaying() ? 'Playing' : 'Stopped'}</div>
      </header>
      <section class="transport" aria-label="Transport controls">
        <button class=${() => `btn-play ${isPlaying() ? 'playing' : ''}`} onClick=${handlePlay} aria-label=${() => isPlaying() ? 'Stop playback' : 'Start playback'}>${() => isPlaying() ? '■' : '▶'}</button>
        <div class="bpm-control"><label>BPM</label><input type="range" class="bpm-slider" min="60" max="200" value=${bpm} onInput=${handleBpmInput}/><output class="bpm-value">${bpm}</output></div>
        <button class=${() => `transport-toggle ${metronome() ? 'on' : ''}`} onClick=${() => { setMetronome(!metronome()); if (isPlaying()) scheduleMetronome(!metronome()); }}>⌁ Click</button>
        <button class=${() => `transport-toggle ${countIn() ? 'on' : ''}`} onClick=${() => setCountIn(!countIn())}>1 bar in</button>
        <span class="transport-divider"></span>
        <button class="y-btn y-btn-sm transport-action" onClick=${handleGenerate}>✨ Melody</button>
        <button class="y-btn y-btn-sm transport-action" onClick=${handleRandomizeDrums}>🎲 Drums</button>
      </section>
      <main class="main">
        <aside class=${() => `sidebar ${panel.expanded() ? 'expanded' : ''}`} onMouseEnter=${() => panel.open()} onMouseLeave=${() => panel.scheduleClose()} onFocusIn=${() => panel.open()} onFocusOut=${() => panel.scheduleClose()} aria-label="Music controls">
          <div class="sidebar-rail">
            <button class="rail-button" onClick=${() => panel.togglePin()} aria-label="Toggle controls" aria-expanded=${panel.expanded}>☰</button>
            <span class="rail-glyph">◈</span><span class="rail-glyph">♬</span><span class="rail-glyph">▤</span>
          </div>
          <div class="sidebar-content" aria-hidden=${() => !panel.expanded()}>
            <div class="sidebar-heading"><span>Controls</span><button class=${() => `pin-button ${panel.pinned() ? 'active' : ''}`} onClick=${() => panel.togglePin()} title="Pin controls">⌖</button></div>
            <div class="sidebar-section"><label>Scale</label><select class="y-select" value=${scale} onChange=${(e: Event) => setScale((e.target as HTMLSelectElement).value as ScaleType)}>${() => SCALES.map(s => html`<option value=${s} selected=${() => scale() === s}>${SCALE_LABELS[s]}</option>`)}</select></div>
            <div class="sidebar-section"><label>Chord progression</label><select class="y-select" value=${chordProgression} onChange=${(e: Event) => setChordProgression((e.target as HTMLSelectElement).value as ChordProgression)}>${() => PROGRESSIONS.map(p => html`<option value=${p} selected=${() => chordProgression() === p}>${p}</option>`)}</select></div>
            <div class="sidebar-section"><label>Pattern library</label><select class="y-select" value=${selectedPattern} onChange=${(e: Event) => loadPattern((e.target as HTMLSelectElement).value)}><option value="">Load a saved pattern…</option>${() => savedPatterns().map(name => html`<option value=${name}>${name}</option>`)}</select><div class="pattern-buttons"><button class="mini-button" onClick=${() => savePattern(false)}>Save</button><button class="mini-button" onClick=${() => savePattern(true)}>Duplicate</button></div></div>
            <div class="sidebar-section mixer"><label>Track mixer</label>${() => TRACK_KEYS.map(track => html`<div class="mixer-row"><span class="track-dot" style=${`background:${TRACK_COLORS[track]}`}></span><span class="mixer-name">${track}</span><input type="range" min="0" max="1" step="0.05" value=${() => trackSettings()[track].volume} onInput=${(e: Event) => updateMixer(track, { volume: Number((e.target as HTMLInputElement).value) })}/><button class=${() => `mix-button ${trackSettings()[track].muted ? 'on' : ''}`} onClick=${() => updateMixer(track, { muted: !trackSettings()[track].muted })}>M</button><button class=${() => `mix-button ${trackSettings()[track].solo ? 'on' : ''}`} onClick=${() => updateMixer(track, { solo: !trackSettings()[track].solo })}>S</button></div>`)}</div>
            <div class="sidebar-section session-info"><label>Session</label><span>${() => SCALE_LABELS[scale()]} · ${chordProgression}</span><span>${() => melodyPattern().length} notes · step ${() => currentStep() < 0 ? '—' : currentStep() + 1}/16</span></div>
          </div>
        </aside>
        <section class="canvas-area">
          <div class="workspace-title"><div><span class="eyebrow">Pattern A</span><h1>Beat builder</h1></div><div class="shortcut-hint">Space play · Shift velocity · Alt chance</div></div>
          <canvas ref=${(el: HTMLCanvasElement) => { canvasRef = el; }} class="visualizer-canvas"></canvas>
          <div class="drum-grid">
            <div class="drum-grid-header"><div><strong>STEP SEQUENCER</strong><span>Click toggles · Shift changes velocity · Alt changes probability</span></div><span class="steps-count">16 steps · 1 bar</span></div>
            <div class="drum-beat-markers">${() => Array.from({ length: STEP_COUNT }, (_, i) => html`<div class=${`beat-marker ${i % 4 === 0 ? 'strong' : ''}`}>${i % 4 === 0 ? String(i / 4 + 1) : ''}</div>`)}</div>
            ${() => TRACK_KEYS.map(track => html`<div class="drum-row"><span class="drum-label" style=${`color:${TRACK_COLORS[track]}`}>${track}</span><div class="drum-steps">${() => drumPattern()[track].map((active, si) => { const detail = stepSettings()[track][si]; return html`<button class=${() => `step-btn ${active ? 'active' : ''} ${si === currentStep() && isPlaying() ? 'current-step' : ''}`} style=${() => active ? `--step-color:${TRACK_COLORS[track]};--step-alpha:${detail.velocity}` : ''} title=${() => active ? `Velocity ${Math.round(detail.velocity * 100)}% · Chance ${Math.round(detail.probability * 100)}%` : 'Off'} onClick=${(e: MouseEvent) => editStep(track, si, e)}></button>`; })}</div></div>`)}
          </div>
        </section>
      </main>
    </div>`;
}
render(() => html`<${App} />`, document.getElementById('app')!);