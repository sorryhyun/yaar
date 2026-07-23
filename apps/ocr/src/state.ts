// Signals shared by the UI, the protocol handlers, and the headless hook.
import { createSignal } from '@bundled/solid-js';
import { DEFAULT_MODEL, type RecResult } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrRecord extends RecResult {
  rect: Rect;
  modelId: string;
  elapsedMs: number;
  inputWidth: number;
  at: number;
}

export const [status, setStatus] = createSignal('Drop, paste, or open an image to start.');
export const [busy, setBusy] = createSignal(false);
/** Weight-download progress, 0..1, or null when not downloading. */
export const [downloadRatio, setDownloadRatio] = createSignal<number | null>(null);
export const [modelId, setModelId] = createSignal(DEFAULT_MODEL);
export const [backend, setBackend] = createSignal('checking…');
export const [imageSize, setImageSize] = createSignal<{ w: number; h: number } | null>(null);
export const [selection, setSelection] = createSignal<Rect | null>(null);
export const [results, setResults] = createSignal<OcrRecord[]>([]);
export const [error, setError] = createSignal<string | null>(null);

/**
 * The loaded image at native resolution.
 *
 * Deliberately outside the signal graph: it is a large mutable canvas read by
 * `preprocess`, never rendered reactively, and putting it in a signal would make
 * every selection drag diff a bitmap. `imageSize` is the reactive shadow of it.
 */
let source: HTMLCanvasElement | null = null;

export function sourceCanvas(): HTMLCanvasElement | null {
  return source;
}

export function setSourceImage(image: CanvasImageSource, w: number, h: number): void {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not get a 2D context for the source image');
  ctx.drawImage(image, 0, 0);
  source = canvas;
  setImageSize({ w, h });
  setSelection(null);
  setError(null);
}

export function latest(): OcrRecord | null {
  return results()[0] ?? null;
}

export function pushResult(record: OcrRecord): void {
  setResults((prev) => [record, ...prev].slice(0, 50));
}
