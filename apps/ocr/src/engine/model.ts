// PP-OCRv6 text *recognition* in the browser: crop → 48px-tall line → CTC → text.
//
// This is the recognition half of PaddleOCR. The model takes an already cropped,
// roughly horizontal line of text and emits per-timestep character probabilities; it
// has no notion of where text is on a page. Locating lines is detect.ts's job — or the
// user's, when they drag a box.
//
// Everything here mirrors PaddleOCR's own pre/post-processing exactly, because
// the numbers are baked into the trained weights and "close enough" decodes to
// convincing nonsense rather than to an obvious failure. The two that most often
// get silently wrong elsewhere are called out at their use sites: BGR channel
// order, and zero padding applied *after* normalization.
import { session, run, Tensor, capabilities, type InferenceSession } from '@bundled/yaar-ml';
import { loadCharset, type CharsetId } from './charset';
import { ensureOnDisk, type LoadProgress } from './weights';

export type { CharsetId };

/** Label table: index 0 is the CTC blank, 1..N index the charset, N+1 is a space. */
const BLANK = 0;

/** The recognizer is trained at a fixed 48px line height; only width varies. */
const REC_HEIGHT = 48;

/**
 * Widths a preprocessed line is padded up to.
 *
 * The graph's width is dynamic, but onnxruntime's WebGPU backend compiles kernels
 * per concrete shape — feeding a new width every time pays a recompile per call.
 * Snapping to a handful of buckets keeps that cost to a one-time warmup. The top
 * bucket also caps how wide a single line may get: past it the crop is squeezed
 * horizontally rather than truncated, which degrades gracefully.
 */
const WIDTH_BUCKETS = [160, 320, 480, 640, 960, 1280, 1920, 2400];

export interface ModelChoice {
  id: string;
  label: string;
  url: string;
  bytes: number;
  charset: CharsetId;
  /** What the dictionary actually covers, counted from it. Shown to agents. */
  scripts: string;
}

/**
 * Every recognizer takes the same input — 3×48×W, BGR, ±1 — and differs only in its
 * dictionary. That is what lets ensemble.ts preprocess a page once and feed the same
 * tensors to several of these.
 *
 * The `korean` entry is a different family (PP-OCRv5 mobile, per-language) and covers a
 * script none of the v6 sizes do. PaddleOCR publishes siblings for cyrillic, latin,
 * arabic, devanagari, greek, thai and more under the same naming; each is a data entry
 * here plus one URL in charset.ts, and would need its own end-to-end check.
 */
export const MODELS: ModelChoice[] = [
  {
    id: 'medium',
    label: 'Medium (77 MB) — most accurate',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/main/inference.onnx',
    bytes: 76_554_979,
    charset: 'v6',
    scripts: 'Latin, digits, Chinese, Japanese kana',
  },
  {
    id: 'small',
    label: 'Small (21 MB)',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx',
    bytes: 21_159_378,
    charset: 'v6',
    scripts: 'Latin, digits, Chinese, Japanese kana',
  },
  {
    id: 'tiny',
    label: 'Tiny (4.5 MB) — fastest, Latin + Chinese only',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.onnx',
    bytes: 4_462_639,
    charset: 'v6-tiny',
    scripts: 'Latin, digits, Chinese',
  },
  {
    id: 'korean',
    label: 'Korean (13 MB) — Hangul + ASCII only',
    url: 'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx',
    bytes: 13_418_787,
    charset: 'v5-korean',
    scripts: 'Hangul, Latin, digits',
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

/**
 * Recognizers run alongside the primary by default, arbitrated per line by ensemble.ts.
 *
 * On by default because the alternative is worse than slow: a Korean line detected by a
 * script-agnostic detector and handed to a dictionary with zero Hangul comes back empty,
 * with nothing in the output to say why. 13 MB and one extra pass of a mobile model buys
 * that back. `setModel({ assist: [] })`, or the toolbar toggle, turns it off.
 */
export const DEFAULT_ASSIST = ['korean'];

export function modelById(id: string): ModelChoice {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export type { LoadProgress };

/**
 * Load (and memoize) a recognizer session.
 *
 * The weights are pulled to this machine's storage first (weights.ts) and the session
 * is created from the file on disk, so a second window — or a browser that has been
 * cleaned out since — reads bytes it already has instead of fetching 77 MB again.
 * `session()` memoizes by URL, so calling this repeatedly is cheap.
 */
export async function loadRecognizer(
  modelId: string,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<InferenceSession> {
  const model = modelById(modelId);
  const local = await ensureOnDisk(model.url, model.bytes, onProgress, signal);
  const s = await session(local, {
    backend: 'auto', // WebGPU when the tab has it, single-thread wasm otherwise
    signal,
  });
  return s;
}

export { capabilities };

export interface Preprocessed {
  tensor: ReturnType<typeof makeTensor>;
  /** Width the crop actually occupies; the rest of the bucket is padding. */
  width: number;
  bucket: number;
}

function makeTensor(data: Float32Array, dims: number[]) {
  return new Tensor('float32', data, dims);
}

export type ChannelOrder = 'bgr' | 'rgb';

/**
 * Turn a crop of `src` into the NCHW float tensor the recognizer expects.
 *
 * PaddleOCR's `resize_norm_img`, transliterated:
 *   resize to height 48 keeping aspect → /255 → −0.5 → /0.5 → pad right with 0.
 *
 * Two details that are easy to get wrong and impossible to notice:
 *
 * - **Channel order is BGR.** The config decodes with `img_mode: BGR` and never
 *   swaps, so the trained weights expect OpenCV's byte order — the opposite of
 *   what a canvas hands you. Measured, this one turns out *not* to be load-bearing:
 *   on strongly coloured text (red ink on blue paper) BGR and RGB both decoded
 *   perfectly at confidence 1.0, so the model reads luminance structure rather
 *   than hue. BGR stays the default because it is what the weights were trained
 *   against; `order` stays exposed so the claim can be re-measured rather than
 *   argued about.
 * - **Padding is 0 in *normalized* space**, not black. That is mid-grey (127.5)
 *   in pixel space, which is why the tensor is allocated zeroed and only the
 *   resized region is written, instead of padding a canvas and normalizing after.
 */
export function preprocessData(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  order: ChannelOrder = 'bgr',
): { data: Float32Array; width: number; bucket: number } {
  const wanted = Math.max(1, Math.ceil((REC_HEIGHT * sw) / sh));
  const bucket = WIDTH_BUCKETS.find((b) => b >= wanted) ?? WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1];
  const width = Math.min(wanted, bucket);

  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = REC_HEIGHT;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('could not get a 2D context to preprocess the crop');
  // A transparent PNG (a cropped screenshot, typically) would otherwise composite
  // onto transparent black and hide dark text. Opaque sources overwrite this.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, REC_HEIGHT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, width, REC_HEIGHT);

  const { data } = ctx.getImageData(0, 0, width, REC_HEIGHT);
  const plane = REC_HEIGHT * bucket;
  const out = new Float32Array(3 * plane); // zeros === PaddleOCR's post-normalization pad
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const o = y * bucket + x;
      // (v/255 - 0.5) / 0.5  ==  v/127.5 - 1
      out[o] = (order === 'bgr' ? b : r) / 127.5 - 1;
      out[plane + o] = g / 127.5 - 1;
      out[2 * plane + o] = (order === 'bgr' ? r : b) / 127.5 - 1;
    }
  }

  return { data: out, width, bucket };
}

export function preprocess(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  order: ChannelOrder = 'bgr',
): Preprocessed {
  const { data, width, bucket } = preprocessData(src, sx, sy, sw, sh, order);
  return { tensor: makeTensor(data, [1, 3, REC_HEIGHT, bucket]), width, bucket };
}

export interface RecResult {
  text: string;
  /** Mean probability over the timesteps that produced a character (0 when empty). */
  confidence: number;
  /** Per-character probabilities, in output order. */
  charScores: { char: string; score: number }[];
  timesteps: number;
}

/**
 * Greedy CTC decode of a `[1, T, C]` probability tensor.
 *
 * The graph ends in a softmax, so these are probabilities already. PaddleOCR's
 * rule is: keep timestep t when its argmax differs from t−1's *and* is not the
 * blank — note the de-duplication compares against the raw previous index,
 * including blanks, which is what lets "aa" survive as two characters when a
 * blank separates them.
 */
export function decodeCtc(
  data: Float32Array,
  timesteps: number,
  classes: number,
  chars: string[],
): RecResult {
  const space = chars.length + 1;
  const charScores: { char: string; score: number }[] = [];
  let sum = 0;
  let prev = -1;

  for (let t = 0; t < timesteps; t++) {
    const base = t * classes;
    let best = 0;
    let bestP = data[base];
    for (let c = 1; c < classes; c++) {
      const p = data[base + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== BLANK && best !== prev) {
      const char = best === space ? ' ' : (chars[best - 1] ?? '');
      if (char) {
        charScores.push({ char, score: bestP });
        sum += bestP;
      }
    }
    prev = best;
  }

  return {
    text: charScores.map((c) => c.char).join(''),
    confidence: charScores.length ? sum / charScores.length : 0,
    charScores,
    timesteps,
  };
}

export interface RecognizeOptions {
  modelId?: string;
  onProgress?: (p: LoadProgress) => void;
}

/**
 * A model paired with the wrong dictionary still decodes — to confident nonsense.
 * The only cheap signal that the pairing is right is the output width, so check it.
 */
function assertPairing(model: ModelChoice, classes: number, chars: string[]): void {
  // +2: the CTC blank at index 0 and the trailing space. See charset.ts.
  const expected = chars.length + 2;
  if (classes !== expected) {
    throw new Error(
      `the ${model.id} model has ${classes} output classes but its "${model.charset}" ` +
        `dictionary describes ${expected}. The dictionary is read from the model's own ` +
        'inference.yml, so this means the URLs in charset.ts and model.ts have drifted apart.',
    );
  }
}

/**
 * Lines per `run`.
 *
 * Bounded so a dense page does not build one enormous tensor: at the 2400 bucket a
 * batch of 16 is already 22 MB of float32 going to the GPU in one go.
 */
const MAX_BATCH = 16;

/** A crop already turned into model input. Model-independent: see MODELS. */
export interface Prepared {
  data: Float32Array;
  width: number;
  bucket: number;
}

/** Preprocess whole crops — the shape `runPrepared` consumes. */
export function prepareCrops(crops: HTMLCanvasElement[], order: ChannelOrder = 'bgr'): Prepared[] {
  return crops.map((crop) => preprocessData(crop, 0, 0, crop.width, crop.height, order));
}

/**
 * Recognize many prepared lines with one model, batching them through it.
 *
 * Batching is worth doing for one reason that dominates everything else: onnxruntime's
 * WebGPU backend compiles kernels per *concrete* shape. Run a 40-line page one crop at a
 * time and it sees up to 40 distinct widths and pays 40 compilations, each far longer
 * than the inference itself. The width buckets in `preprocess` exist so that never
 * happens — crops group onto at most 8 shapes, each compiled once and then reused for
 * the rest of the session.
 *
 * Input arrives already preprocessed because every recognizer in MODELS takes the same
 * tensor; ensemble.ts prepares a page once and runs it through several models, and
 * preprocessing per model would redo a canvas draw and a `getImageData` per crop for
 * bytes that would come out identical.
 *
 * Results come back in input order regardless of how they were grouped.
 */
export async function runPrepared(
  prepared: Prepared[],
  options: RecognizeOptions = {},
): Promise<{ results: (RecResult & { inputWidth: number })[]; elapsedMs: number }> {
  const model = modelById(options.modelId ?? DEFAULT_MODEL);
  if (prepared.length === 0) return { results: [], elapsedMs: 0 };
  // The dictionary is 114 KB against the weights' 77 MB, and both are IndexedDB-cached
  // by the same helper — asking for them together costs nothing over the weights alone.
  const [s, chars] = await Promise.all([
    loadRecognizer(model.id, options.onProgress),
    loadCharset(model.charset),
  ]);

  const byBucket = new Map<number, number[]>();
  prepared.forEach((p, i) => {
    const group = byBucket.get(p.bucket);
    if (group) group.push(i);
    else byBucket.set(p.bucket, [i]);
  });

  const results = new Array<RecResult & { inputWidth: number }>(prepared.length);
  const started = performance.now();

  for (const [bucket, indices] of byBucket) {
    for (let from = 0; from < indices.length; from += MAX_BATCH) {
      const chunk = indices.slice(from, from + MAX_BATCH);
      const stride = prepared[chunk[0]].data.length;
      const batch = new Float32Array(stride * chunk.length);
      chunk.forEach((index, n) => batch.set(prepared[index].data, n * stride));

      const outputs = await run(s, {
        [s.inputNames[0]]: makeTensor(batch, [chunk.length, 3, REC_HEIGHT, bucket]),
      });
      const logits = outputs[s.outputNames[0]];
      const dims = logits.dims;
      const classes = dims[dims.length - 1];
      const timesteps = dims[dims.length - 2];
      assertPairing(model, classes, chars);

      const data = logits.data as Float32Array;
      const span = timesteps * classes;
      chunk.forEach((index, n) => {
        // A view, not a copy — the batch output is already the right layout per item.
        const slice = data.subarray(n * span, (n + 1) * span);
        results[index] = {
          ...decodeCtc(slice, timesteps, classes, chars),
          inputWidth: bucket,
        };
      });
    }
  }

  return { results, elapsedMs: performance.now() - started };
}
