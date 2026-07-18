// Shared app state: the signals that main.ts used to own at module scope, plus the
// canvas element registry. Kept in one place so the UI, the pipeline and the
// protocol layer all read/write the same instances.
import { createSignal } from '@bundled/solid-js';
import type { GenerationResult } from './protocol';
import { DEFAULT_BUCKET, bucketById } from './buckets';

// The prompt that `webgpu/prompt_embeds.f32` was precomputed from. Leaving the box
// at this exact text lets us skip the 1.46 GB text path and reuse the golden embeds.
export const GOLDEN_PROMPT =
  'masterpiece, best quality, score_7, safe, 1girl, silver hair, blue eyes, ' +
  'fur-trimmed white winter coat, falling snow, forest, looking at viewer, ' +
  'upper body, detailed background';

export const [caps, setCaps] = createSignal('probing…');
export const [prompt, setPrompt] = createSignal(GOLDEN_PROMPT);
export const [busy, setBusy] = createSignal(false);
// Progress bar state: label + percent (pct null = indeterminate). `status` is the
// last outcome line (✅/❌/📋) shown under the bar. Detailed traces go to the
// devtools console only — no on-screen log dump.
export const [progress, setProgress] = createSignal<{ label: string; pct: number | null } | null>(
  null,
);
export const [status, setStatus] = createSignal('');
export const [hasImage, setHasImage] = createSignal(false);
export const [lastResult, setLastResult] = createSignal<GenerationResult | null>(null);
// The rarely-touched controls (ratio / seed / download / clear cache) live behind this
// popover so the narrow default window keeps prompt + Generate as the only chrome.
export const [showOptions, setShowOptions] = createSignal(false);
// Aspect ratio. Each bucket is its own DiT/VAE graph (resolution is baked in at
// export), but every bucket shares the one 3.9 GB weight sidecar — see buckets.ts.
export const [bucketId, setBucketId] = createSignal(DEFAULT_BUCKET.id);
export const bucket = () => bucketById(bucketId());
export const [seed, setSeed] = createSignal(0);

// The <canvas> is a plain DOM ref, not a signal: the pipeline paints into it and the
// image actions read pixels off it. `hasImage` is what the UI reacts to.
let canvasEl: HTMLCanvasElement | undefined;
export function setCanvas(el: HTMLCanvasElement | undefined): void {
  canvasEl = el;
}
export function canvas(): HTMLCanvasElement | undefined {
  return canvasEl;
}
