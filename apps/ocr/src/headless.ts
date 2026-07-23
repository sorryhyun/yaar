// Automation surface for CDP-driven checks: run the pipeline and read structured
// results without clicking anything. Kept separate from the protocol because this
// is for *verifying the numerics* (raw scores, channel order A/B, resize policy A/B)
// rather than for an agent using the app.
import { capabilities, preprocess, decodeCtc, type ChannelOrder } from './model';
import { loadCharset } from './charset';
import { detect, resizeForDetect, type ResizePolicy } from './detect';
import { quadAngle, quadBounds } from './geometry';
import { loadDataUrl } from './image-input';
import { loadSample, sampleLineRect, SAMPLE_LINES } from './sample';
import { runRecognition } from './recognize';
import { runPageRead } from './pipeline';
import {
  results,
  selection,
  setSelection,
  imageSize,
  setModelId,
  modelId,
  setDetModelId,
  detModelId,
  sourceCanvas,
} from './state';

/** Detection only, boxes as plain rects — no recognizer loaded, no crops taken. */
async function detectOnly(options: { detModelId?: string; resize?: ResizePolicy } = {}) {
  const canvas = sourceCanvas();
  const size = imageSize();
  if (!canvas || !size) throw new Error('no image loaded');
  const result = await detect(canvas, size.w, size.h, {
    detModelId: options.detModelId ?? detModelId(),
    resize: options.resize,
  });
  return {
    count: result.boxes.length,
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
    mapWidth: result.mapWidth,
    mapHeight: result.mapHeight,
    resize: result.resize,
    boxes: result.boxes.map((b) => ({
      ...quadBounds(b.quad),
      angle: (quadAngle(b.quad) * 180) / Math.PI,
      score: b.score,
    })),
  };
}

export function installHeadlessHook(): void {
  (window as unknown as { __ocr: unknown }).__ocr = {
    ready: true,
    capabilities,
    loadSample,
    loadDataUrl,
    sampleLineRect,
    sampleLines: SAMPLE_LINES,
    setModel: (id: string) => setModelId(id),
    model: () => modelId(),
    setDetModel: (id: string) => setDetModelId(id),
    detModel: () => detModelId(),
    setSelection,
    selection,
    imageSize,
    results: () => results().map((r) => ({ ...r, charScores: undefined })),
    /** ({rect?, order?}) => the full record, including per-character scores. */
    recognize: (options: Parameters<typeof runRecognition>[0] = {}) => runRecognition(options),
    // Exposed so the BGR-vs-RGB choice can be re-measured on identical pixels
    // instead of taken on faith. (Last measured: no difference, even on strongly
    // coloured text — see the note in model.ts.)
    preprocess,
    decodeCtc,
    loadCharset,
    detect: detectOnly,
    resizeForDetect,
    readPage: (options: Parameters<typeof runPageRead>[0] = {}) => runPageRead(options),
    /** Read every sample line in one call — the Phase 1 end-to-end smoke test. */
    readSample: async (order?: ChannelOrder) => {
      loadSample();
      const out: { expected: string; text: string; confidence: number }[] = [];
      for (let i = 0; i < SAMPLE_LINES.length; i++) {
        const record = await runRecognition({ rect: sampleLineRect(i), order });
        out.push({
          expected: SAMPLE_LINES[i],
          text: record.text,
          confidence: record.confidence,
        });
      }
      return out;
    },
    /** Detect and read the sample card with no coordinates supplied — Phase 2's bar. */
    readPageSample: async () => {
      loadSample();
      const result = await runPageRead();
      return {
        expected: SAMPLE_LINES,
        lines: result.lines.map((l) => ({
          text: l.text,
          confidence: l.confidence,
          score: l.score,
          box: l.box,
        })),
        text: result.text,
        detected: result.detected,
        unreadable: result.unreadable,
        detectMs: result.detectMs,
        recognizeMs: result.recognizeMs,
      };
    },
    /**
     * Run detection under both resize policies on whatever is loaded.
     *
     * The 960/'max' default is read off PaddleX's own model table rather than guessed
     * (see DEFAULT_RESIZE), but the two policies differ enough — 'max' only shrinks,
     * 'min' only grows — that the claim is worth being able to re-measure on a real
     * page instead of re-argued.
     */
    resizeAB: async (detModel?: string) => {
      const policies: ResizePolicy[] = [
        { limitType: 'max', limitSideLen: 960 },
        { limitType: 'min', limitSideLen: 736 },
      ];
      const out = [];
      for (const resize of policies) {
        const run = await detectOnly({ detModelId: detModel, resize });
        out.push({
          policy: `${resize.limitSideLen}/${resize.limitType}`,
          fedAt: `${run.mapWidth}×${run.mapHeight}`,
          boxes: run.count,
          meanScore: run.boxes.length
            ? run.boxes.reduce((s, b) => s + b.score, 0) / run.boxes.length
            : 0,
          elapsedMs: run.elapsedMs,
        });
      }
      return out;
    },
  };
}
