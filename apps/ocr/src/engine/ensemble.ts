// Reading each line with more than one recognizer, and choosing between what they say.
//
// No PaddleOCR recognizer covers every script. The v6 models this app defaults to carry
// 18,708 characters — Latin, Chinese, kana — and zero Hangul, so a Korean line came back
// empty however cleanly it was detected. PaddleOCR's own answer is per-language
// recognizers: korean_PP-OCRv5_mobile is 13 MB and covers Hangul plus ASCII, and nothing
// else — no CJK, no kana. So it cannot replace the v6 model, only run beside it.
//
// **Neither model can say "that is not my script."** A recognizer with no labels for
// what it is looking at does not error; it emits blanks, or a stray character at high
// confidence. That rules out asking the models and rules out routing by language guess
// before the fact. What is left is to run both over the same line and compare the two
// decodes — which is arbitrate.ts's job. This file is the plumbing around it.
import { pickBest, type Judged } from './arbitrate';
import {
  modelById,
  prepareCrops,
  preprocessData,
  runPrepared,
  type ChannelOrder,
  type LoadProgress,
  type Prepared,
  type RecResult,
} from './model';

export { pickBest, trust, type Judged } from './arbitrate';

/** A line read by whichever model read it best, with what the others said. */
export interface LineRead extends RecResult {
  inputWidth: number;
  /** The model whose decode won — not necessarily the selected primary. */
  modelId: string;
  /** What the losing models made of the same line. Empty when only one ran. */
  alternatives: Judged[];
}

export interface EnsembleOptions {
  /** Primary first. Duplicates are ignored; unknown ids resolve via `modelById`. */
  modelIds: string[];
  order?: ChannelOrder;
  /** Called before each model's pass, so a caller can say which one is running. */
  onModel?: (modelId: string, index: number, total: number) => void;
  onProgress?: (modelId: string, p: LoadProgress) => void;
}

export interface EnsembleResult {
  results: LineRead[];
  /** Wall-clock across every pass. */
  elapsedMs: number;
  /** Inference time per model id, in pass order. */
  perModel: { modelId: string; elapsedMs: number }[];
}

/**
 * Run every model over the same prepared lines and arbitrate per line.
 *
 * The passes run one after another rather than concurrently. Two sessions racing on one
 * GPU queue does not finish sooner, and interleaving them makes the two weight downloads
 * — 77 MB and 13 MB on a cold start — report progress over each other. The saving that
 * *does* matter is already taken: preprocessing happens once, above this, and both models
 * consume the same tensors.
 */
async function arbitrate(prepared: Prepared[], options: EnsembleOptions): Promise<EnsembleResult> {
  const ids = [...new Set(options.modelIds.map((id) => modelById(id).id))];
  if (prepared.length === 0) return { results: [], elapsedMs: 0, perModel: [] };

  const started = performance.now();
  const passes: { modelId: string; results: (RecResult & { inputWidth: number })[] }[] = [];
  const perModel: { modelId: string; elapsedMs: number }[] = [];

  for (const [index, modelId] of ids.entries()) {
    options.onModel?.(modelId, index, ids.length);
    const pass = await runPrepared(prepared, {
      modelId,
      onProgress: (p) => options.onProgress?.(modelId, p),
    });
    passes.push({ modelId, results: pass.results });
    perModel.push({ modelId, elapsedMs: pass.elapsedMs });
  }

  const results = prepared.map((_, line) => {
    const candidates = passes.map((pass) => ({ ...pass.results[line], modelId: pass.modelId }));
    const winner = pickBest(candidates);
    return {
      ...winner,
      alternatives: candidates
        .filter((c) => c !== winner)
        .map(({ modelId, text, confidence }) => ({ modelId, text, confidence })),
    };
  });

  return { results, elapsedMs: performance.now() - started, perModel };
}

/** Read many line crops with every model in `modelIds`. */
export function readLines(
  crops: HTMLCanvasElement[],
  options: EnsembleOptions,
): Promise<EnsembleResult> {
  return arbitrate(prepareCrops(crops, options.order ?? 'bgr'), options);
}

/** Read one region of `src` with every model in `modelIds`. */
export async function readRegion(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  options: EnsembleOptions,
): Promise<LineRead & { elapsedMs: number }> {
  const prepared = preprocessData(src, sx, sy, sw, sh, options.order ?? 'bgr');
  const { results, elapsedMs } = await arbitrate([prepared], options);
  return { ...results[0], elapsedMs };
}
