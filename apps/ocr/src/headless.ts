// Automation surface for CDP-driven checks: run the pipeline and read structured
// results without clicking anything. Kept separate from the protocol because this
// is for *verifying the numerics* (raw scores, channel order A/B, resize policy A/B)
// rather than for an agent using the app.
import { capabilities, preprocess, decodeCtc, type ChannelOrder } from './model';
import { loadCharset } from './charset';
import { detect, resizeForDetect, type ResizePolicy } from './detect';
import { readRegion, trust } from './ensemble';
import { allModels, bytesOf, cancelLoad, ensureModels, missing, pageModels } from './warm';
import { quadAngle, quadBounds } from './geometry';
import { loadDataUrl } from './image-input';
import { captureWindow, listWindows } from './window-source';
import { loadSample, sampleLineRect, SAMPLE_LINES } from './sample';
import { runRecognition } from './recognize';
import { runPageRead } from './pipeline';
import {
  assistIds,
  results,
  selection,
  setAssistIds,
  setDownloadRatio,
  setSelection,
  imageSize,
  setModelId,
  modelId,
  setDetModelId,
  detModelId,
  recognizerIds,
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
    setAssist: (ids: string[]) => setAssistIds(ids),
    assist: () => assistIds(),
    recognizers: recognizerIds,
    setDetModel: (id: string) => setDetModelId(id),
    detModel: () => detModelId(),
    /** Everything the current settings need, and what is still missing. */
    models: () => {
      const wanted = pageModels(recognizerIds(), detModelId());
      return {
        wanted: wanted.map((m) => m.key),
        missing: missing(wanted).map((m) => m.key),
        bytes: bytesOf(missing(wanted)),
      };
    },
    loadModels: (ids?: string[]) =>
      ensureModels(
        ids
          ? allModels().filter((m) => ids.includes(m.key))
          : pageModels(recognizerIds(), detModelId()),
        { onProgress: setDownloadRatio },
      ),
    cancelLoad,
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
    /** The two halves of readWindow, separately: the window list, and the capture. */
    listWindows,
    captureWindow,
    /**
     * Read every sample line in one call — the Phase 1 end-to-end smoke test.
     *
     * Downloads what it needs rather than failing the way the UI does: this is the
     * automation surface, and a check that has to be told to fetch its own inputs first
     * is a check that gets run with the wrong ones.
     */
    readSample: async (order?: ChannelOrder) => {
      loadSample();
      const out: { expected: string; text: string; confidence: number }[] = [];
      for (let i = 0; i < SAMPLE_LINES.length; i++) {
        const record = await runRecognition({ rect: sampleLineRect(i), order, download: true });
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
      const result = await runPageRead({ download: true });
      return {
        expected: SAMPLE_LINES,
        lines: result.lines.map((l) => ({
          text: l.text,
          confidence: l.confidence,
          score: l.score,
          box: l.box,
          readBy: l.readBy,
          alternatives: l.alternatives,
        })),
        text: result.text,
        detected: result.detected,
        unreadable: result.unreadable,
        assisted: result.assisted,
        modelIds: result.modelIds,
        detectMs: result.detectMs,
        recognizeMs: result.recognizeMs,
      };
    },
    /**
     * Every model's decode of one region, with the trust score that decided between them.
     *
     * The arbitration in ensemble.ts is the one piece of this app that picks between two
     * plausible answers, and its threshold (SHRINK, MARGIN) is a judgement call. This is
     * how that call gets re-measured on real lines — what each model said, what it
     * scored, and whether the winner was the right one — instead of re-argued.
     */
    candidates: async (
      rect?: { x: number; y: number; w: number; h: number },
      models?: string[],
    ) => {
      const canvas = sourceCanvas();
      const size = imageSize();
      if (!canvas || !size) throw new Error('no image loaded');
      const box = rect ?? selection() ?? { x: 0, y: 0, w: size.w, h: size.h };
      const read = await readRegion(canvas, box.x, box.y, box.w, box.h, {
        modelIds: models ?? recognizerIds(),
      });
      const all = [
        { modelId: read.modelId, text: read.text, confidence: read.confidence },
        ...read.alternatives,
      ];
      return {
        winner: read.modelId,
        elapsedMs: read.elapsedMs,
        candidates: all.map((c) => ({ ...c, trust: trust(c.text, c.confidence) })),
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
