// Whole-page read: detect → order → crop → batch-recognize → assemble.
//
// The page counterpart to recognize.ts, and the same kind of funnel: the toolbar
// button, the `readPage` command, and the headless hook all come through here, so
// status, error, and history behave identically however the read was asked for.
import { errMsg } from '@bundled/yaar';
import { detect, detModelById, type DetectOptions } from './detect';
import { cropQuad } from './crop';
import { quadAngle, quadBounds, readingOrder, type Point } from './geometry';
import { recognizeCrops, modelById } from './model';
import {
  busy,
  detModelId,
  imageSize,
  modelId,
  pushResult,
  setActiveLine,
  setBusy,
  setDownloadRatio,
  setError,
  setPage,
  setStatus,
  sourceCanvas,
} from './state';

export interface PageLine {
  text: string;
  /** Recognition confidence: mean per-character probability. */
  confidence: number;
  /** Detection confidence: DB's mean probability inside the box. */
  score: number;
  /** Axis-aligned bounds in source pixels, plus the box's tilt in degrees. */
  box: { x: number; y: number; w: number; h: number; angle: number };
  quad: Point[];
  /**
   * False when detection found a box but the recognizer returned nothing.
   *
   * This is Phase 2's new failure mode and is deliberately not collapsed into "no
   * text": the detector is script-agnostic and will happily box Korean or Cyrillic
   * that the recognizer has no labels for. "Found 9 lines, read 6" is a dictionary
   * problem; "found 0 lines" is a detection problem. They need different fixes.
   */
  readable: boolean;
}

export interface PageResult {
  /** Lines joined with newlines; boxes sharing a line joined with spaces. */
  text: string;
  lines: PageLine[];
  /** True when `max_candidates` capped detection — the page is partial. */
  truncated: boolean;
  detected: number;
  unreadable: number;
  detectMs: number;
  recognizeMs: number;
  elapsedMs: number;
  modelId: string;
  detModelId: string;
  at: number;
}

export interface ReadPageOptions {
  detect?: DetectOptions;
  /** Push each line into the per-line results history as well. Off by default. */
  keepLines?: boolean;
}

export async function runPageRead(options: ReadPageOptions = {}): Promise<PageResult> {
  const canvas = sourceCanvas();
  const size = imageSize();
  if (!canvas || !size) throw new Error('no image loaded');
  if (busy()) throw new Error('a recognition is already running');

  const recId = modelId();
  const detId = options.detect?.detModelId ?? detModelId();
  const startedAt = performance.now();

  setBusy(true);
  setError(null);
  setPage(null);
  setActiveLine(null);
  setStatus(`Finding text with ${detModelById(detId).id}…`);
  try {
    const detection = await detect(canvas, size.w, size.h, {
      ...options.detect,
      detModelId: detId,
      onProgress: (p) => {
        setDownloadRatio(p.ratio);
        setStatus(`Downloading ${detModelById(detId).id} detector — ${Math.round(p.ratio * 100)}%`);
      },
    });
    setDownloadRatio(null);

    if (detection.boxes.length === 0) {
      const empty: PageResult = {
        text: '',
        lines: [],
        truncated: detection.truncated,
        detected: 0,
        unreadable: 0,
        detectMs: detection.elapsedMs,
        recognizeMs: 0,
        elapsedMs: performance.now() - startedAt,
        modelId: recId,
        detModelId: detId,
        at: Date.now(),
      };
      setPage(empty);
      setStatus('No text found on this image.');
      return empty;
    }

    // One flat pass in reading order, so the batch comes back in the order the page
    // is written in and the groups only decide where the line breaks go.
    const groups = readingOrder(detection.boxes.map((b) => quadBounds(b.quad)));
    const order = groups.flat();

    setStatus(`Reading ${order.length} lines with ${modelById(recId).id}…`);
    const crops = order.map((i) => cropQuad(canvas, detection.boxes[i].quad));
    const recognized = await recognizeCrops(crops, {
      modelId: recId,
      onProgress: (p) => {
        setDownloadRatio(p.ratio);
        setStatus(`Downloading ${modelById(recId).id} weights — ${Math.round(p.ratio * 100)}%`);
      },
    });
    setDownloadRatio(null);

    const lines: PageLine[] = order.map((boxIndex, n) => {
      const box = detection.boxes[boxIndex];
      const bounds = quadBounds(box.quad);
      const rec = recognized.results[n];
      return {
        text: rec.text,
        confidence: rec.confidence,
        score: box.score,
        box: { ...bounds, angle: (quadAngle(box.quad) * 180) / Math.PI },
        quad: box.quad,
        readable: rec.text.trim().length > 0,
      };
    });

    // `order` is the flattened `groups`, so walking it with a cursor recovers which
    // lines shared a visual row without a second lookup table.
    let cursor = 0;
    const rows = groups.map((group) => {
      const row = lines.slice(cursor, cursor + group.length);
      cursor += group.length;
      return row
        .map((l) => l.text)
        .filter(Boolean)
        .join(' ');
    });

    const unreadable = lines.filter((l) => !l.readable).length;
    const result: PageResult = {
      text: rows.filter(Boolean).join('\n'),
      lines,
      truncated: detection.truncated,
      detected: detection.boxes.length,
      unreadable,
      detectMs: detection.elapsedMs,
      recognizeMs: recognized.elapsedMs,
      elapsedMs: performance.now() - startedAt,
      modelId: recId,
      detModelId: detId,
      at: Date.now(),
    };
    setPage(result);

    if (options.keepLines) {
      for (const line of lines) {
        pushResult({
          text: line.text,
          confidence: line.confidence,
          charScores: [],
          timesteps: 0,
          rect: line.box,
          modelId: recId,
          elapsedMs: 0,
          inputWidth: 0,
          at: result.at,
        });
      }
    }

    setStatus(
      [
        `Read ${lines.length - unreadable} of ${lines.length} lines`,
        `in ${Math.round(result.elapsedMs)} ms`,
        unreadable ? `— ${unreadable} detected but not readable (unsupported script?)` : '',
        detection.truncated ? '— hit the 3000-box limit, this page is partial' : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    return result;
  } catch (e) {
    const message = errMsg(e);
    setError(message);
    setStatus('Page read failed.');
    throw new Error(message);
  } finally {
    setBusy(false);
    setDownloadRatio(null);
  }
}
