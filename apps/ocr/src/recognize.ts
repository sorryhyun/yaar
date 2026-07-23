// The one funnel every caller uses — toolbar button, protocol command, headless
// hook — so status, error, and history behave identically however OCR was asked for.
import { errMsg } from '@bundled/yaar';
import { recognizeCrop, modelById, type ChannelOrder } from './model';
import {
  busy,
  setBusy,
  setStatus,
  setDownloadRatio,
  setError,
  sourceCanvas,
  imageSize,
  modelId,
  selection,
  pushResult,
  type OcrRecord,
  type Rect,
} from './state';

/** Clamp a rect to the image and reject one too small to hold a glyph. */
function normalizeRect(rect: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(Math.round(rect.x), w - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), h - 1));
  const rw = Math.max(1, Math.min(Math.round(rect.w), w - x));
  const rh = Math.max(1, Math.min(Math.round(rect.h), h - y));
  if (rw < 4 || rh < 4) throw new Error('selection is too small to read');
  return { x, y, w: rw, h: rh };
}

export interface RunOptions {
  /** Defaults to the current selection, or the whole image when nothing is selected. */
  rect?: Rect;
  order?: ChannelOrder;
}

export async function runRecognition(options: RunOptions = {}): Promise<OcrRecord> {
  const canvas = sourceCanvas();
  const size = imageSize();
  if (!canvas || !size) throw new Error('no image loaded');
  if (busy()) throw new Error('a recognition is already running');

  const rect = normalizeRect(
    options.rect ?? selection() ?? { x: 0, y: 0, w: size.w, h: size.h },
    size.w,
    size.h,
  );

  const id = modelId();
  setBusy(true);
  setError(null);
  setStatus(`Recognizing with ${modelById(id).id}…`);
  try {
    const result = await recognizeCrop(canvas, rect.x, rect.y, rect.w, rect.h, {
      modelId: id,
      order: options.order,
      onProgress: (p) => {
        setDownloadRatio(p.ratio);
        setStatus(`Downloading ${modelById(id).id} weights — ${Math.round(p.ratio * 100)}%`);
      },
    });
    setDownloadRatio(null);

    const record: OcrRecord = { ...result, rect, modelId: id, at: Date.now() };
    pushResult(record);
    setStatus(
      result.text
        ? `Read ${result.charScores.length} characters in ${Math.round(result.elapsedMs)} ms.`
        : 'No text found in that region.',
    );
    return record;
  } catch (e) {
    const message = errMsg(e);
    setError(message);
    setStatus('Recognition failed.');
    throw new Error(message);
  } finally {
    setBusy(false);
    setDownloadRatio(null);
  }
}
