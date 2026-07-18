// Headless driver hook: lets a CDP/automation script run the pipeline and read
// structured JSON results (steps, image stats, PNG dataURL) without clicking the UI.
// The shape of `window.__anima` is part of the app's contract — keep keys stable.
import {
  capabilities,
  loadModel,
  releaseModels,
  run,
  Tensor,
  fetchF32,
  clearWeightCache,
  asF32,
  assetUrl,
} from './ml';
import { promptEmbeds } from './text';
import { loadTokenizers, tokenizePrompt } from './tokenizer';
import { BUCKETS } from './buckets';
import { log, onProg, stats } from './logging';
import { generate } from './pipeline/generate';
import { ditGate, ditProbe, downloadModels, vaeProbe } from './pipeline/diagnostics';

export function installHeadlessHook(): void {
  (window as unknown as { __anima: unknown }).__anima = {
    ready: true,
    generate, // ({model?, seed?, prompt?, ratio?}) => result
    ratios: BUCKETS, // the exportable aspect ratios; pass one's id as `ratio`
    probe: ditProbe, // () => {rows, firstBad}
    vaeProbe, // decode a precomputed latent (plumbing sanity check; no UI button)
    ditGate, // single DiT forward (memory/latency check; no UI button)
    download: downloadModels, // () => {ok, elapsed}
    resolve: assetUrl, // (path) => the same-origin URL a given asset loads from
    clearCache: () => clearWeightCache(),
    release: (prefix = '') => releaseModels((n) => n.startsWith(prefix)), // free live sessions
    // Micro-benchmark/repro hook: run `<name>.onnx` (input x [M,K] f32, output y)
    // with the deterministic `<name>_x.f32`, report absmax + head for comparison
    // against a CPU-EP reference. Used to isolate WebGPU-EP kernel bugs.
    mm: async (name: string, o: { backend?: 'webgpu' | 'wasm'; m?: number; k?: number } = {}) => {
      const M = o.m ?? 4096;
      const K = o.k ?? 2048;
      const x = await fetchF32(`${name}_x.f32`);
      const s = await loadModel(name, onProg, o.backend ?? 'webgpu', 'url');
      const out = await run(s, { x: new Tensor('float32', x.slice(0, M * K), [M, K]) });
      const y = asF32(out.y as { data: unknown; type: string });
      let mx = 0;
      let nan = 0;
      for (const v of y) {
        if (Number.isNaN(v)) nan++;
        else if (Math.abs(v) > mx) mx = Math.abs(v);
      }
      return { absmax: mx, nan, head: [...y.slice(0, 6)].map((v) => Number(v.toFixed(4))) };
    },
    caps: () => capabilities(),
    // Text path only (1.46 GB): prompt → encoder_hidden_states, no DiT.
    embeds: async (
      text: string,
      o: { backend?: 'webgpu' | 'wasm'; disableGraphOpt?: boolean } = {},
    ) => {
      const t0 = performance.now();
      const e = await promptEmbeds(text, { onProgress: onProg, log, ...o });
      const st = stats(e);
      return { len: e.length, elapsed: (performance.now() - t0) / 1000, ...st };
    },
    // Tokenizers only — no model weights, so this is cheap to call from a test.
    tokenize: async (text: string) => {
      const t = tokenizePrompt(await loadTokenizers(), text);
      return {
        qwen: { ids: [...t.qwen.ids].map(Number), length: t.qwen.length },
        t5: { ids: [...t.t5.ids].map(Number), length: t.t5.length },
      };
    },
  };
}
