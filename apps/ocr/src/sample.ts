// A generated test card, so the app is usable (and verifiable) the moment it opens
// without hunting for a screenshot.
//
// Deliberately multi-script, but only across scripts the dictionary actually
// covers: Latin, digits and punctuation, Chinese, and Japanese kana. Hangul and
// Cyrillic are absent from the v6 dictionary (verified against inference.yml), so
// a Korean or Russian line would decode to nothing and read as a broken app
// rather than as an unsupported script. A Latin-only card, at the other extreme,
// would hide a dictionary that had drifted out of sync with the model.
import { setSourceImage, setStatus, setSelection } from './state';

export const SAMPLE_LINES = [
  'The quick brown fox jumps over the lazy dog',
  'Invoice #48213 — total $1,299.00 (2026-07-23)',
  '简体中文识别测试',
  '日本語のテキスト認識',
];

const LINE_HEIGHT = 72;
const PADDING = 24;
const WIDTH = 900;

export function loadSample(): void {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = PADDING * 2 + LINE_HEIGHT * SAMPLE_LINES.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not get a 2D context for the sample image');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'middle';
  SAMPLE_LINES.forEach((line, i) => {
    ctx.font = '32px system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif';
    ctx.fillText(line, PADDING, PADDING + LINE_HEIGHT * i + LINE_HEIGHT / 2);
  });

  setSourceImage(canvas, canvas.width, canvas.height);
  // Pre-select the first line, so "Recognize" works with zero further input.
  setSelection({ x: PADDING - 8, y: PADDING, w: WIDTH - PADDING * 2, h: LINE_HEIGHT });
  setStatus('Loaded the sample card. Press Recognize, or drag a box over another line.');
}

/** Image-space rect of sample line `i`, for automated checks. */
export function sampleLineRect(i: number): { x: number; y: number; w: number; h: number } {
  return { x: PADDING - 8, y: PADDING + LINE_HEIGHT * i, w: WIDTH - PADDING * 2, h: LINE_HEIGHT };
}
