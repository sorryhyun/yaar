// Prompt → encoder_hidden_states, entirely in the browser.
//
//   text  ──tokenize──▶  qwen ids (1,512) ──text_encoder_fp16──▶ qwen_prompt_embeds (1,512,1024)
//                        t5 ids   (1,512) ──┐
//                                           ├─text_conditioner_fp16──▶ prompt_embeds (1,512,1024)
//                        qwen mask ─────────┘
//
// This replaces the precomputed `webgpu/prompt_embeds.f32` (the golden prompt).
// Both graphs are fixed at L=512, so any prompt works as long as it's right-padded
// with the attention masks — validated in ../krea/scripts/validate_onnx_text_path.py.
//
// Cost: text_encoder_fp16 is 1.19 GB and text_conditioner_fp16 is 269 MB of
// external data. We use 'bytes' mode so both land in the IndexedDB cache (they're
// under the 2 GB ArrayBuffer cap, unlike the DiT), and we `dispose()` both
// sessions before returning so their memory is freed before the 3.9 GB DiT loads.
import { loadModel, run, Tensor, asF32, dispose, type ProgressFn } from './ml';
import { loadTokenizers, tokenizePrompt, SEQ } from './tokenizer';

const DIM = 1024;

export interface EncodeOpts {
  onProgress?: ProgressFn;
  log?: (msg: string) => void;
  backend?: 'webgpu' | 'wasm';
  /** Escape hatch: ORT's fp16 attention fusion is what produced all-NaN on the
   *  WebGPU EP for the DiT. If the text path ever returns NaN, disable it. */
  disableGraphOpt?: boolean;
}

/** Last prompt → embeds, so repeat generations skip the 1.46 GB text path. */
let _cache: { prompt: string; embeds: Float32Array } | null = null;

export async function promptEmbeds(prompt: string, opts: EncodeOpts = {}): Promise<Float32Array> {
  const log = opts.log ?? (() => {});
  const backend = opts.backend ?? 'webgpu';
  if (_cache?.prompt === prompt) {
    log(`prompt embeds: cache hit`);
    return _cache.embeds;
  }

  const toks = await loadTokenizers();
  const { qwen, t5 } = tokenizePrompt(toks, prompt);
  log(`tokenized: ${qwen.length} qwen tokens, ${t5.length} t5 tokens (padded to ${SEQ})`);
  if (qwen.length >= SEQ || t5.length >= SEQ) log(`⚠️ prompt truncated to ${SEQ} tokens`);

  const sessionOpts = opts.disableGraphOpt ? { graphOptimizationLevel: 'disabled' } : {};

  const t0 = performance.now();
  const enc = await loadModel('text_encoder_fp16', opts.onProgress, backend, 'bytes', sessionOpts);
  log(`text encoder ready (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  const encOut = await run(enc, {
    input_ids: new Tensor('int64', qwen.ids, [1, SEQ]),
    attention_mask: new Tensor('int64', qwen.mask, [1, SEQ]),
  });
  // keep_io_types didn't stick: the graph declares a float16 output.
  const hidden = asF32(encOut.qwen_prompt_embeds);
  await dispose(enc);

  const t1 = performance.now();
  const cond = await loadModel(
    'text_conditioner_fp16',
    opts.onProgress,
    backend,
    'bytes',
    sessionOpts,
  );
  log(`conditioner ready (${((performance.now() - t1) / 1000).toFixed(1)}s)`);
  const condOut = await run(cond, {
    source_hidden_states: new Tensor('float32', hidden, [1, SEQ, DIM]),
    target_input_ids: new Tensor('int64', t5.ids, [1, SEQ]),
    target_attention_mask: new Tensor('int64', t5.mask, [1, SEQ]),
    source_attention_mask: new Tensor('int64', qwen.mask, [1, SEQ]),
  });
  const embeds = asF32(condOut.prompt_embeds);
  await dispose(cond);

  let nan = 0;
  for (const v of embeds) if (Number.isNaN(v)) nan++;
  if (nan > 0) {
    throw new Error(
      `text path produced ${nan} NaN — fp16 overflow on the ${backend} EP. ` +
        `Retry with disableGraphOpt, or run the text path on wasm.`,
    );
  }
  log(
    `✅ prompt embeds ready (${((performance.now() - t0) / 1000).toFixed(1)}s), freed text weights`,
  );
  _cache = { prompt, embeds };
  return embeds;
}
