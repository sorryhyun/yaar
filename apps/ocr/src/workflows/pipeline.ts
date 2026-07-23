// Whole-page read: detect → order → crop → batch-recognize → assemble.
//
// The page counterpart to recognize.ts, and the same kind of funnel: the toolbar
// button, the `readPage` command, and the headless hook all come through here, so
// status, error, and history behave identically however the read was asked for.
import { errMsg } from '@bundled/yaar';
import { detect, detModelById, type DetectOptions, type DetectResult } from '../engine/detect';
import { cropQuad } from '../engine/crop';
import { readLines, type EnsembleResult, type Judged } from '../engine/ensemble';
import { quadAngle, quadBounds, readingOrder, type Point } from '../engine/geometry';
import { ensureModels, pageModels, requireLoaded } from './warm';
import {
  busy,
  loading,
  detModelId,
  imageSize,
  modelId,
  pushResult,
  recognizerIds,
  setActiveLine,
  setBusy,
  setDownloadRatio,
  setError,
  setPage,
  setStatus,
  sourceCanvas,
} from '../state';

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
   * False when detection found a box but no recognizer returned anything.
   *
   * Deliberately not collapsed into "no text": the detector is script-agnostic and will
   * happily box a script none of the loaded dictionaries has labels for. "Found 9 lines,
   * read 6" is a dictionary problem; "found 0 lines" is a detection problem. They need
   * different fixes — and with the Korean assist on, the first one is usually already
   * fixed, so a line that still comes back unreadable means a script neither model has.
   */
  readable: boolean;
  /** Which recognizer's decode won this line. See ensemble.ts. */
  readBy: string;
  /** What the other recognizers made of this line. Empty when only one ran. */
  alternatives: Judged[];
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
  /** The primary recognizer. `modelIds` is everything that ran, primary first. */
  modelId: string;
  modelIds: string[];
  /** Lines won by a model other than the primary — how much the assist earned. */
  assisted: number;
  detModelId: string;
  at: number;
}

export interface ReadPageOptions {
  detect?: DetectOptions;
  /** Push each line into the per-line results history as well. Off by default. */
  keepLines?: boolean;
  /** Fetch missing weights instead of refusing. Off by default — see warm.ts. */
  download?: boolean;
}

/** Pair detected boxes with their recognition results in the already-computed reading order. */
function buildPageLines(
  detection: DetectResult,
  order: number[],
  recognized: EnsembleResult,
): PageLine[] {
  return order.map((boxIndex, index) => {
    const box = detection.boxes[boxIndex];
    const bounds = quadBounds(box.quad);
    const rec = recognized.results[index];
    return {
      text: rec.text,
      confidence: rec.confidence,
      score: box.score,
      box: { ...bounds, angle: (quadAngle(box.quad) * 180) / Math.PI },
      quad: box.quad,
      readable: rec.text.trim().length > 0,
      readBy: rec.modelId,
      alternatives: rec.alternatives,
    };
  });
}

/** Reinsert line breaks after the recognizer has processed a flat, reading-ordered list. */
function joinPageRows(groups: number[][], lines: PageLine[]): string {
  let cursor = 0;
  return groups
    .map((group) => {
      const row = lines.slice(cursor, cursor + group.length);
      cursor += group.length;
      return row
        .map((line) => line.text)
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean)
    .join('\n');
}

export async function runPageRead(options: ReadPageOptions = {}): Promise<PageResult> {
  const canvas = sourceCanvas();
  const size = imageSize();
  if (!canvas || !size) throw new Error('no image loaded');
  if (busy()) throw new Error('a recognition is already running');
  if (loading()) throw new Error('the models are still downloading');

  const recIds = recognizerIds();
  const recId = modelId();
  const detId = options.detect?.detModelId ?? detModelId();
  const needed = pageModels(recIds, detId);
  if (!options.download) requireLoaded(needed);
  const startedAt = performance.now();

  setBusy(true);
  setError(null);
  setPage(null);
  setActiveLine(null);
  setStatus(`Finding text with ${detModelById(detId).id}…`);
  try {
    // Everything the read needs, before the read: a mid-page pause to fetch a 13 MB
    // recognizer after detection has already run reads as a hang, not as a download.
    await ensureModels(needed, {
      onProgress: setDownloadRatio,
      onModel: (ref) => setStatus(`Downloading the ${ref.id} ${ref.kind}…`),
    });
    setDownloadRatio(null);

    const detection = await detect(canvas, size.w, size.h, {
      ...options.detect,
      detModelId: detId,
    });

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
        modelIds: recIds,
        assisted: 0,
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

    setStatus(`Reading ${order.length} lines with ${recIds.join(' + ')}…`);
    const crops = order.map((i) => cropQuad(canvas, detection.boxes[i].quad));
    const recognized = await readLines(crops, {
      modelIds: recIds,
      onModel: (id, index, total) =>
        setStatus(
          total > 1
            ? `Reading ${order.length} lines with ${id}… (${index + 1} of ${total})`
            : `Reading ${order.length} lines with ${id}…`,
        ),
    });

    const lines = buildPageLines(detection, order, recognized);

    const unreadable = lines.filter((l) => !l.readable).length;
    const assisted = lines.filter((l) => l.readable && l.readBy !== recId).length;
    const result: PageResult = {
      text: joinPageRows(groups, lines),
      lines,
      truncated: detection.truncated,
      detected: detection.boxes.length,
      unreadable,
      detectMs: detection.elapsedMs,
      recognizeMs: recognized.elapsedMs,
      elapsedMs: performance.now() - startedAt,
      modelId: recId,
      modelIds: recIds,
      assisted,
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
          modelId: line.readBy,
          alternatives: line.alternatives,
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
        assisted ? `— ${assisted} read by the assist` : '',
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
