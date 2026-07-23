// PP-OCRv6 text *detection*: image → per-pixel text probability map → boxes.
//
// The other half of the pipeline from model.ts. This one has no dictionary, so the
// charset-mismatch class of bug cannot recur; its analogue is the resize policy, which
// is the one number here that changes results without ever erroring.
import { session, run, Tensor, type InferenceSession } from '@bundled/yaar-ml';
import { dbBoxes, type DetBox } from './geometry';
import { ensureOnDisk, type LoadProgress } from './weights';

export interface DetModelChoice {
  id: string;
  label: string;
  url: string;
  bytes: number;
  /** Per-model `box_thresh` from each repo's inference.yml — tiny's is looser. */
  boxThresh: number;
}

/**
 * Detection is a much easier task than recognition, so the sizes are far apart in
 * bytes but much closer in quality — `tiny` finds all four lines of the sample card
 * exactly as `medium` does.
 *
 * `medium` is still the default, matching the recognizer: a page read holds both
 * sessions live at once, and 62 + 77 MB is comfortable against the 4 GB
 * `maxStorageBufferBindingSize` measured here. The smaller detectors stay selectable
 * through `setModel` for machines where it is not.
 */
export const DET_MODELS: DetModelChoice[] = [
  {
    id: 'medium',
    label: 'Medium (62 MB) — most accurate',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/main/inference.onnx',
    bytes: 62_032_837,
    boxThresh: 0.45,
  },
  {
    id: 'small',
    label: 'Small (9.9 MB)',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx',
    bytes: 9_880_512,
    boxThresh: 0.45,
  },
  {
    id: 'tiny',
    label: 'Tiny (1.8 MB) — fastest',
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/main/inference.onnx',
    bytes: 1_780_590,
    boxThresh: 0.4,
  },
];

export const DEFAULT_DET_MODEL = DET_MODELS[0].id;

export function detModelById(id: string): DetModelChoice {
  return DET_MODELS.find((m) => m.id === id) ?? DET_MODELS[0];
}

/** DB post-processing constants, identical across the three repos' inference.yml. */
const THRESH = 0.2;
const UNCLIP_RATIO = 1.4;
const MAX_CANDIDATES = 3000;

/** ImageNet normalization — the detector's, unlike the recognizer's plain ±1 scaling. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export type LimitType = 'max' | 'min';

export interface ResizePolicy {
  limitType: LimitType;
  limitSideLen: number;
}

/**
 * How big the image is made before it is fed to the detector.
 *
 * `inference.yml` says `DetResizeForTest: null`, and the class default for that is
 * `limit_side_len 736, limit_type 'min'` — but the class default is not what runs.
 * PaddleX's text-detection predictor keeps a set, `_TEXT_DET_MAX_LIMIT_MODELS`, of
 * models that override it, and all three PP-OCRv6 detectors are named in it
 * (`paddlex/inference/models/text_detection/predictor.py`,
 * `_get_text_det_resize_defaults`). So the shipped default for these weights is
 * 960/'max', and 736/'min' is what a naive reading of the yml would give you.
 *
 * The difference is not a tuning knob, it is a different policy: 'max' only ever
 * shrinks (an image already under 960 is fed at native size), 'min' only ever grows
 * (a 4000px scan is left at 4000). Both are exposed so the choice stays measurable —
 * `__ocr.resizeAB()` runs a page through each and reports box counts.
 */
export const DEFAULT_RESIZE: ResizePolicy = { limitType: 'max', limitSideLen: 960 };

/** Upstream's `max_side_limit`: past this, downscale regardless of policy. */
const MAX_SIDE_LIMIT = 4000;

export interface ResizePlan {
  width: number;
  height: number;
  /** Multiply map coordinates by these to get source pixels. */
  scaleX: number;
  scaleY: number;
}

/**
 * PaddleX's `resize_image_type0`, transliterated.
 *
 * Two details that look like rounding noise and are not: each side is rounded to the
 * *nearest* multiple of 32 (not up — the network downsamples by 32, and upstream
 * accepts losing a few pixels), and the two axes end up with slightly different
 * scale factors as a result, which is why they are returned separately.
 */
export function resizeForDetect(width: number, height: number, policy: ResizePolicy): ResizePlan {
  const { limitType, limitSideLen } = policy;
  let ratio = 1;
  if (limitType === 'max') {
    if (Math.max(height, width) > limitSideLen) {
      ratio = limitSideLen / Math.max(height, width);
    }
  } else if (Math.min(height, width) < limitSideLen) {
    ratio = limitSideLen / Math.min(height, width);
  }

  let resizeH = Math.trunc(height * ratio);
  let resizeW = Math.trunc(width * ratio);
  if (Math.max(resizeH, resizeW) > MAX_SIDE_LIMIT) {
    const shrink = MAX_SIDE_LIMIT / Math.max(resizeH, resizeW);
    resizeH = Math.trunc(resizeH * shrink);
    resizeW = Math.trunc(resizeW * shrink);
  }
  resizeH = Math.max(Math.round(resizeH / 32) * 32, 32);
  resizeW = Math.max(Math.round(resizeW / 32) * 32, 32);

  return { width: resizeW, height: resizeH, scaleX: width / resizeW, scaleY: height / resizeH };
}

/**
 * Load (and memoize) a detector session. Same route and storage as the recognizer —
 * pulled to disk by weights.ts, then `session()` memoizes by URL, so both models can
 * be resident without extra bookkeeping here.
 */
export async function loadDetector(
  modelId: string,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<InferenceSession> {
  const model = detModelById(modelId);
  const local = await ensureOnDisk(model.url, model.bytes, onProgress, signal);
  return session(local, { backend: 'auto', signal });
}

/**
 * Resize and normalize into the `[1, 3, H, W]` BGR tensor the detector expects.
 *
 * Same two traps as the recognizer's `preprocess` — BGR channel order, and a white
 * fill so a transparent PNG does not composite dark text onto black — but the
 * normalization is ImageNet per-channel here, not the recognizer's flat ±1.
 */
export function preprocessDetect(
  src: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  plan: ResizePlan,
): Float32Array {
  const scratch = document.createElement('canvas');
  scratch.width = plan.width;
  scratch.height = plan.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('could not get a 2D context to preprocess the page');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, srcWidth, srcHeight, 0, 0, plan.width, plan.height);

  const { data } = ctx.getImageData(0, 0, plan.width, plan.height);
  const plane = plan.width * plan.height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    out[i] = (data[p + 2] / 255 - MEAN[0]) / STD[0]; // B
    out[plane + i] = (data[p + 1] / 255 - MEAN[1]) / STD[1]; // G
    out[2 * plane + i] = (data[p] / 255 - MEAN[2]) / STD[2]; // R
  }
  return out;
}

export interface DetectOptions {
  detModelId?: string;
  resize?: ResizePolicy;
  /** Overrides the model's own `box_thresh`; for measuring recall, not for daily use. */
  boxThresh?: number;
  onProgress?: (p: LoadProgress) => void;
}

export interface DetectResult {
  boxes: DetBox[];
  /** True when `max_candidates` capped the components considered — the page is partial. */
  truncated: boolean;
  elapsedMs: number;
  /** Size the probability map came back at, i.e. the size the model actually saw. */
  mapWidth: number;
  mapHeight: number;
  resize: ResizePolicy;
}

/** Find every text box in `src`, in source-image pixels. */
export async function detect(
  src: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  options: DetectOptions = {},
): Promise<DetectResult> {
  const model = detModelById(options.detModelId ?? DEFAULT_DET_MODEL);
  const resize = options.resize ?? DEFAULT_RESIZE;
  const s = await loadDetector(model.id, options.onProgress);

  const plan = resizeForDetect(srcWidth, srcHeight, resize);
  const input = preprocessDetect(src, srcWidth, srcHeight, plan);

  const started = performance.now();
  const outputs = await run(s, {
    [s.inputNames[0]]: new Tensor('float32', input, [1, 3, plan.height, plan.width]),
  });
  const elapsedMs = performance.now() - started;

  const map = outputs[s.outputNames[0]];
  const dims = map.dims;
  const mapHeight = dims[dims.length - 2];
  const mapWidth = dims[dims.length - 1];
  const prob = map.data as Float32Array;

  // The exported graph ends in a sigmoid, so this is already a probability. If it ever
  // is not, every threshold below is meaningless and the page comes back empty or
  // solid — so say which it is rather than let the thresholds absorb it.
  let max = 0;
  for (let i = 0; i < prob.length; i++) if (prob[i] > max) max = prob[i];
  if (max > 1.001) {
    throw new Error(
      `the detector returned values up to ${max.toFixed(2)}, so its output is not a ` +
        'probability map — this build expects the sigmoid to be inside the graph.',
    );
  }

  const { boxes, truncated } = dbBoxes(prob, mapWidth, mapHeight, {
    thresh: THRESH,
    boxThresh: options.boxThresh ?? model.boxThresh,
    unclipRatio: UNCLIP_RATIO,
    maxCandidates: MAX_CANDIDATES,
    // The map comes back at the input size (DB upsamples internally), but reading the
    // scale off the *returned* dims rather than off the plan keeps this correct if a
    // future export changes that.
    scaleX: srcWidth / mapWidth,
    scaleY: srcHeight / mapHeight,
    destWidth: srcWidth,
    destHeight: srcHeight,
  });

  return { boxes, truncated, elapsedMs, mapWidth, mapHeight, resize };
}
