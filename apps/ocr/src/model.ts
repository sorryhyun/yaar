// PP-OCRv6 text *recognition* in the browser: crop → 48px-tall line → CTC → text.
//
// This is the recognition half of PaddleOCR only. The model takes an already
// cropped, roughly horizontal line of text and emits per-timestep character
// probabilities; it has no notion of where text is on a page. Locating lines is
// the detection model's job (PP-OCRv6_*_det), which this app does not load yet —
// the user draws the box instead.
//
// Everything here mirrors PaddleOCR's own pre/post-processing exactly, because
// the numbers are baked into the trained weights and "close enough" decodes to
// convincing nonsense rather than to an obvious failure. The two that most often
// get silently wrong elsewhere are called out at their use sites: BGR channel
// order, and zero padding applied *after* normalization.
import { session, run, Tensor, capabilities, type InferenceSession } from '@bundled/yaar-ml';
import { CHARSET_V6, CHARSET_V6_TINY } from './charset';

export type CharsetId = 'v6' | 'v6-tiny';

/**
 * The recognizer sizes do NOT share a dictionary — `tiny` was exported against a
 * much smaller character set — so each model is pinned to its own. Decoding with
 * the wrong table produces fluent-looking nonsense rather than an error, which is
 * why `recognizeCrop` re-checks the width against the model at runtime.
 *
 * Split with `Array.from`: both contain astral characters, so `.length` and `[i]`
 * would tear surrogate pairs.
 */
const CHARSETS: Record<CharsetId, string[]> = {
  v6: Array.from(CHARSET_V6),
  'v6-tiny': Array.from(CHARSET_V6_TINY),
};

/** Label table: index 0 is the CTC blank, 1..N index the charset, N+1 is a space. */
const BLANK = 0;

/** Output width a model must have for its charset's index mapping to hold. */
export function expectedClasses(charset: CharsetId): number {
  return CHARSETS[charset].length + 2;
}

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
}

/** Same graph shape throughout; `tiny` differs in its character dictionary. */
export const MODELS: ModelChoice[] = [
  {
    id: 'medium',
    label: 'Medium (77 MB) — most accurate',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/main/inference.onnx',
    bytes: 76_554_979,
    charset: 'v6',
  },
  {
    id: 'small',
    label: 'Small (21 MB)',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx',
    bytes: 21_159_378,
    charset: 'v6',
  },
  {
    id: 'tiny',
    label: 'Tiny (4.5 MB) — fastest, Latin + Chinese only',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.onnx',
    bytes: 4_462_639,
    charset: 'v6-tiny',
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

export function modelById(id: string): ModelChoice {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export interface LoadProgress {
  ratio: number;
  loaded: number;
  total: number;
}

/**
 * Load (and memoize) a recognizer session.
 *
 * `session()` streams the weights through YAAR's same-origin `/api/ml-weights`
 * proxy and caches them in IndexedDB, so only the first call per model pays the
 * download. It memoizes by URL, so calling this repeatedly is cheap.
 */
export async function loadRecognizer(
  modelId: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<InferenceSession> {
  const model = modelById(modelId);
  const s = await session(model.url, {
    backend: 'auto', // WebGPU when the tab has it, single-thread wasm otherwise
    onProgress: (p) => onProgress?.({ ratio: p.ratio, loaded: p.loaded, total: p.total }),
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
export function preprocess(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  order: ChannelOrder = 'bgr',
): Preprocessed {
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

  return { tensor: makeTensor(out, [1, 3, REC_HEIGHT, bucket]), width, bucket };
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
  charset: CharsetId,
): RecResult {
  const chars = CHARSETS[charset];
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
  order?: ChannelOrder;
  onProgress?: (p: LoadProgress) => void;
}

/** Recognize one line of text from a crop of `src`. */
export async function recognizeCrop(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  options: RecognizeOptions = {},
): Promise<RecResult & { elapsedMs: number; inputWidth: number }> {
  const model = modelById(options.modelId ?? DEFAULT_MODEL);
  const s = await loadRecognizer(model.id, options.onProgress);
  const { tensor, bucket } = preprocess(src, sx, sy, sw, sh, options.order ?? 'bgr');

  const started = performance.now();
  const outputs = await run(s, { [s.inputNames[0]]: tensor });
  const elapsedMs = performance.now() - started;

  const logits = outputs[s.outputNames[0]];
  const dims = logits.dims;
  const classes = dims[dims.length - 1];
  // A model paired with the wrong dictionary still decodes — to confident nonsense.
  // The only cheap signal that the pairing is right is the output width, so check it.
  const expected = expectedClasses(model.charset);
  if (classes !== expected) {
    throw new Error(
      `the ${model.id} model has ${classes} output classes but its "${model.charset}" ` +
        `dictionary describes ${expected}. Regenerate src/charset.ts ` +
        `(bun run apps/ocr/scripts/gen-charset.ts).`,
    );
  }

  const decoded = decodeCtc(
    logits.data as Float32Array,
    dims[dims.length - 2],
    classes,
    model.charset,
  );
  return { ...decoded, elapsedMs, inputWidth: bucket };
}
