import { STEP_COUNT } from './types';
import type { DrumPattern, MelodyNote } from './types';

const TRACK_LABELS = ['KICK', 'SNARE', 'HIHAT', 'PERC'];
const TRACK_COLORS = ['#f85149', '#e3b341', '#58a6ff', '#bc8cff'];

export function drawVisualizer(
  canvas: HTMLCanvasElement,
  currentStep: number,
  drumPattern: DrumPattern,
  melodyNotes: MelodyNote[],
  isPlaying: boolean
) {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const drumH = H * 0.52;
  const pianoH = H * 0.42;
  const pianoY = drumH + H * 0.06;

  // ── DRUM SECTION ────────────────────────────────────────────────
  const labelW = 52;
  const padW = (W - labelW - 12) / STEP_COUNT;
  const padH = drumH / 4 - 8;
  const tracks = [
    drumPattern.kick,
    drumPattern.snare,
    drumPattern.hihat,
    drumPattern.perc,
  ];

  ctx.fillStyle = '#8b949e';
  ctx.font = 'bold 11px var(--yaar-font, monospace)';
  ctx.textBaseline = 'middle';

  tracks.forEach((track, ti) => {
    const ty = ti * (padH + 8) + 4;
    const cy = ty + padH / 2;

    // Label
    ctx.fillStyle = TRACK_COLORS[ti];
    ctx.fillText(TRACK_LABELS[ti], 6, cy);

    track.forEach((active, si) => {
      const tx = labelW + si * padW + 2;
      const isCurrentStep = si === currentStep && isPlaying;

      // Group bar every 4
      const groupAlpha = si % 4 === 0 ? 0.08 : 0.03;
      ctx.fillStyle = `rgba(255,255,255,${groupAlpha})`;
      ctx.fillRect(tx, ty, padW - 2, padH);

      if (active) {
        const grd = ctx.createLinearGradient(tx, ty, tx, ty + padH);
        grd.addColorStop(0, TRACK_COLORS[ti]);
        grd.addColorStop(1, TRACK_COLORS[ti] + '88');
        ctx.fillStyle = grd;
        ctx.fillRect(tx + 1, ty + 1, padW - 4, padH - 2);

        // Glow when playing
        if (isCurrentStep) {
          ctx.shadowColor = TRACK_COLORS[ti];
          ctx.shadowBlur = 12;
          ctx.fillRect(tx + 1, ty + 1, padW - 4, padH - 2);
          ctx.shadowBlur = 0;
        }
      }

      // Step indicator
      if (isCurrentStep) {
        ctx.strokeStyle = '#ffffff88';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tx + 0.5, ty + 0.5, padW - 3, padH - 1);
      }
    });
  });

  // Current step column highlight
  if (currentStep >= 0 && isPlaying) {
    const tx = labelW + currentStep * padW + 2;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(tx, 0, padW - 2, drumH);
  }

  // Section label
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('DRUM SEQUENCER', 6, drumH - 12);

  // ── DIVIDER ──────────────────────────────────────────────────────
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, drumH + H * 0.025);
  ctx.lineTo(W, drumH + H * 0.025);
  ctx.stroke();

  // ── MELODY PIANO ROLL ─────────────────────────────────────────────
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('MELODY PIANO ROLL', 6, pianoY);

  const rollY = pianoY + 14;
  const rollH = pianoH - 18;
  const rollW = W - 8;

  // Background
  ctx.fillStyle = '#0a0f15';
  ctx.fillRect(4, rollY, rollW, rollH);

  if (melodyNotes.length > 0) {
    const allNotes = melodyNotes.map(n => n.note);
    const noteSet = [...new Set(allNotes)].sort();
    const noteCount = Math.max(noteSet.length, 8);
    const noteH = rollH / noteCount;

    const maxStep = melodyNotes.reduce((m, n) => Math.max(m, n.time + 2), STEP_COUNT);
    const stepW = rollW / maxStep;

    // Grid lines
    for (let i = 0; i <= maxStep; i += 4) {
      ctx.strokeStyle = i % 8 === 0 ? '#21262d' : '#161b22';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4 + i * stepW, rollY);
      ctx.lineTo(4 + i * stepW, rollY + rollH);
      ctx.stroke();
    }

    // Notes
    melodyNotes.forEach(n => {
      const ni = noteSet.indexOf(n.note);
      if (ni < 0) return;
      const y = rollY + rollH - (ni + 1) * noteH;
      const x = 4 + n.time * stepW;
      const durSteps = n.duration === '4n' ? 2 : n.duration === '16n' ? 0.5 : 1;
      const w = Math.max(2, durSteps * stepW - 2);

      const isActive = isPlaying && Math.floor(n.time) === currentStep;
      const color = isActive ? '#58a6ff' : '#3fb95088';
      const borderColor = isActive ? '#58a6ff' : '#3fb950';

      ctx.fillStyle = color;
      ctx.fillRect(x, y + 1, w, noteH - 2);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y + 1, w, noteH - 2);

      if (isActive) {
        ctx.shadowColor = '#58a6ff';
        ctx.shadowBlur = 8;
        ctx.fillRect(x, y + 1, w, noteH - 2);
        ctx.shadowBlur = 0;
      }

      // Note label
      if (noteH > 10) {
        ctx.fillStyle = '#ffffff99';
        ctx.font = '8px monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.note, x + 2, y + noteH / 2);
      }
    });

    // Playhead
    if (currentStep >= 0 && isPlaying) {
      const px = 4 + currentStep * stepW;
      ctx.strokeStyle = '#ffffff55';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, rollY);
      ctx.lineTo(px, rollY + rollH);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#30363d';
    ctx.font = '12px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('Generate a melody to see the piano roll', W / 2, rollY + rollH / 2);
    ctx.textAlign = 'left';
  }
}
