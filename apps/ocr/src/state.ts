// Signals shared by the UI, the protocol handlers, and the headless hook.
import { createSignal } from '@bundled/solid-js';
import { DEFAULT_DET_MODEL } from './engine/detect';
import { DEFAULT_ASSIST, DEFAULT_MODEL, modelById, type RecResult } from './engine/model';
import type { PageResult } from './workflows/pipeline';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrRecord extends RecResult {
  rect: Rect;
  /** The recognizer whose decode won, which is not always the selected primary. */
  modelId: string;
  /** What the other recognizers made of the same region. Empty when only one ran. */
  alternatives: { modelId: string; text: string; confidence: number }[];
  elapsedMs: number;
  inputWidth: number;
  at: number;
}

export const [status, setStatus] = createSignal('Drop, paste, or open an image to start.');
export const [busy, setBusy] = createSignal(false);
/** True while weights are downloading. Separate from `busy`: nothing is being read. */
export const [loading, setLoading] = createSignal(false);
/** Weight-download progress, 0..1, or null when not downloading. */
export const [downloadRatio, setDownloadRatio] = createSignal<number | null>(null);
/**
 * Models resident in this page session, as `det:id` / `rec:id` keys.
 *
 * Written only by `ensureModels`, so a read cannot believe a model is loaded that it
 * would in fact have to fetch. See warm.ts for why this is not persisted.
 */
export const [loadedModels, setLoadedModels] = createSignal<string[]>([]);
export const [modelId, setModelId] = createSignal(DEFAULT_MODEL);
/** Extra recognizers run beside the primary, arbitrated per line. See ensemble.ts. */
export const [assistIds, setAssistIds] = createSignal<string[]>([...DEFAULT_ASSIST]);
export const [detModelId, setDetModelId] = createSignal(DEFAULT_DET_MODEL);
export const [backend, setBackend] = createSignal('checking…');
export const [imageSize, setImageSize] = createSignal<{ w: number; h: number } | null>(null);
export const [selection, setSelection] = createSignal<Rect | null>(null);
export const [results, setResults] = createSignal<OcrRecord[]>([]);
export const [error, setError] = createSignal<string | null>(null);
/** The last whole-page read: its boxes are what the canvas overlay draws. */
export const [page, setPage] = createSignal<PageResult | null>(null);
/** Index into `page().lines` of the box the user clicked, or null. */
export const [activeLine, setActiveLine] = createSignal<number | null>(null);

/**
 * Every recognizer a read should use, primary first.
 *
 * The single source of this list, so the toolbar, the protocol and the headless hook
 * cannot disagree about which models ran. An assist that duplicates the primary is
 * dropped here rather than at each call site.
 */
export function recognizerIds(): string[] {
  const primary = modelById(modelId()).id;
  return [
    primary,
    ...assistIds()
      .map((id) => modelById(id).id)
      .filter((id) => id !== primary),
  ];
}

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
  // Boxes belong to the image they were found on; leaving them up would draw the last
  // page's overlay over the new one.
  setPage(null);
  setActiveLine(null);
}

export function latest(): OcrRecord | null {
  return results()[0] ?? null;
}

export function pushResult(record: OcrRecord): void {
  setResults((prev) => [record, ...prev].slice(0, 50));
}
