// Anima WebGPU toy — in-browser text→image on WebGPU.
//
//   ✨ Generate — prompt → embeds → randn latent → ER-SDE 4-step denoise over the
//                 3.9 GB DiT → per-channel denorm → 56 MB VAE decode → 512² canvas.
//                 Typed prompts run the in-browser text path (tokenizer.ts +
//                 text.ts); the golden prompt reuses the precomputed embeds.
//   VAE probe   — decode a Python-precomputed latent (plumbing sanity check).
//   DiT gate    — single DiT forward (memory/latency check).
//   DiT probe   — per-block residual absmax/NaN trace (diagnostic).
//
// The DiT model selector: the default `dit_512_fp16_webgpu` stores fp16 WEIGHTS
// but keeps ACTIVATIONS fp32 (each weight is Cast fp16→fp32 at inference). The
// plain fp16 DiT returns all-NaN on the WebGPU EP because the residual stream
// legitimately reaches |x|~2.6e5, which overflows fp16 (65504) → Inf → NaN. fp32
// activations fix it; fp16 weights keep the download at 3.9 GB. See
// ../krea/scripts/export_onnx_dit_webgpu.py. Requires graphOptimizationLevel
// 'disabled' so ORT doesn't constant-fold the weight casts (→ 7.8 GB in memory).
import { onMount } from '@bundled/solid-js';
import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import {
  capabilities,
  loadModel,
  run,
  Tensor,
  fetchF32,
  fetchJSON,
  chwToImageData,
  clearWeightCache,
  asF32,
  assetUrl,
  type Progress,
} from './ml';
import { ErSDEScheduler, makeRng, randn } from './scheduler';
import { promptEmbeds } from './text';
import { loadTokenizers, tokenizePrompt } from './tokenizer';
import { downloadWeights, TOTAL_BYTES, type DownloadProgress } from './download';

// The prompt that `webgpu/prompt_embeds.f32` was precomputed from. Leaving the box
// at this exact text lets us skip the 1.46 GB text path and reuse the golden embeds.
const GOLDEN_PROMPT =
  'masterpiece, best quality, score_7, safe, 1girl, silver hair, blue eyes, ' +
  'fur-trimmed white winter coat, falling snow, forest, looking at viewer, ' +
  'upper body, detailed background';

const [caps, setCaps] = createSignal('probing…');
const [prompt, setPrompt] = createSignal(GOLDEN_PROMPT);
const [dl, setDl] = createSignal<DownloadProgress | null>(null);
const [logLines, setLog] = createSignal<string[]>([]);
const [busy, setBusy] = createSignal(false);
// DiT weights variant. 'dit_512_fp16_webgpu' pins attention matmuls to fp32 to
// dodge the WebGPU-EP fp16 overflow→NaN; 'dit_512_fp16' is the original export.
const [ditModel, setDitModel] = createSignal('dit_512_fp16_webgpu');
const [seed, setSeed] = createSignal(0);
let canvasEl: HTMLCanvasElement | undefined;

function log(msg: string) {
  setLog((l) => [...l, msg]);
  // eslint-disable-next-line no-console
  console.log('[anima]', msg);
}
const mb = (n: number) => (n / 1024 / 1024).toFixed(0) + ' MB';
const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';

let _lastPct = -1;
function onProg(p: Progress) {
  if (p.cached) return log(`  ${p.file}: cached (${mb(p.loaded)})`);
  const pct = Math.floor(p.ratio * 100);
  if (pct !== _lastPct && pct % 5 === 0) {
    _lastPct = pct;
    log(`  ${p.file}: ${pct}% (${mb(p.loaded)}${p.total ? ' / ' + mb(p.total) : ''})`);
  }
}

function stats(a: Float32Array) {
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    nan = 0;
  for (const v of a) {
    if (Number.isNaN(v)) nan++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
  }
  return { min, max, mean: sum / a.length, nan };
}

// Type-aware stats over an ORT tensor. `asF32` handles float32, Float16Array and
// raw-fp16 Uint16Array alike — don't bit-decode by hand, see ml.ts.
function tensorStats(t: { data: unknown; type: string }) {
  const raw = asF32(t);
  let min = Infinity,
    max = -Infinity,
    nan = 0,
    inf = 0;
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (Number.isNaN(v)) nan++;
    else if (!Number.isFinite(v)) inf++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max, nan, inf, n };
}

async function vaeProbe() {
  if (busy()) return;
  setBusy(true);
  try {
    log('— VAE probe —');
    const t0 = performance.now();
    const latent = await fetchF32('webgpu/latents_4d.f32'); // (1,16,64,64)
    log(`latent loaded: ${latent.length} floats`);
    const s = await loadModel('vae_decoder_512_fp16', onProg, 'webgpu', 'url'); // url mode: validate external-data streaming
    log(`session ready (${((performance.now() - t0) / 1000).toFixed(1)}s). inputs=${s.inputNames}`);
    const t1 = performance.now();
    const out = await run(s, {
      latent: new Tensor('float32', latent, [1, 16, 64, 64]),
    });
    const img = out.image.data as Float32Array;
    const st = stats(img);
    log(
      `decode ${((performance.now() - t1) / 1000).toFixed(2)}s → image ${out.image.dims}. ` +
        `min=${st.min.toFixed(2)} max=${st.max.toFixed(2)} nan=${st.nan}`,
    );
    if (canvasEl) canvasEl.getContext('2d')!.putImageData(chwToImageData(img, 512, 512), 0, 0);
    log('✅ VAE probe done — compare canvas to golden_512_fp16_seed0.png');
  } catch (e) {
    log('❌ ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    setBusy(false);
  }
}

async function ditGate() {
  if (busy()) return;
  setBusy(true);
  try {
    log('— DiT gate (3.9 GB) —');
    const c = await capabilities();
    log(
      `GPU budget: maxStorageBufferBindingSize=${gb(c.maxStorageBufferBindingSize)}, ` +
        `maxBufferSize=${gb(c.maxBufferSize)}, f16=${c.f16}`,
    );
    const pe = await fetchF32('webgpu/prompt_embeds.f32'); // (1,512,1024)
    // Gaussian latent (Box–Muller): a zeros latent makes the DiT's RMSNorm divide
    // by zero → NaN, so feed a representative randn to check real numerics.
    const latent = new Float32Array(1 * 16 * 1 * 64 * 64);
    for (let i = 0; i < latent.length; i++) {
      const u = Math.random() || 1e-9;
      latent[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    }
    const t0 = performance.now();
    // 'url' mode: ORT streams the 3.9 GB sidecar into its wasm heap (no >2 GB JS buffer).
    log('loading DiT via externalData URL mode, graphOpt=disabled…');
    const s = await loadModel(ditModel(), onProg, 'webgpu', 'url', {
      graphOptimizationLevel: 'disabled', // stop a bad fp16 attention fusion that bypasses fp32-pinned softmax
    });
    log(
      `✅ DiT session created (${((performance.now() - t0) / 1000).toFixed(1)}s) — it FITS. inputs=${s.inputNames}`,
    );
    const t1 = performance.now();
    const out = await run(s, {
      latent: new Tensor('float32', latent, [1, 16, 1, 64, 64]),
      timestep: new Tensor('float32', new Float32Array([1.0]), [1]),
      encoder_hidden_states: new Tensor('float32', pe, [1, 512, 1024]),
    });
    const st = stats(out.noise_pred.data as Float32Array);
    log(
      `✅ DiT forward ${((performance.now() - t1) / 1000).toFixed(2)}s → ${out.noise_pred.dims}. ` +
        `min=${st.min.toFixed(3)} max=${st.max.toFixed(3)} mean=${st.mean.toFixed(3)} nan=${st.nan}`,
    );
  } catch (e) {
    log('❌ ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    setBusy(false);
  }
}

// Localize the WebGPU-EP NaN: run dit_512_fp16_probe (same weights, ~36 extra
// intermediate outputs) once and report which probe tensors are NaN. The earliest
// NaN in graph order pins the culprit op/region.
async function ditProbe(opts: { model?: string; dataName?: string } = {}): Promise<unknown> {
  if (busy()) return { error: 'busy' };
  setBusy(true);
  const model = opts.model ?? 'dit_512_fp16_probe2';
  const dataName = opts.dataName ?? 'dit_512_fp16.onnx.data';
  try {
    log(`— DiT probe (${model}) —`);
    const pe = await fetchF32('webgpu/prompt_embeds.f32');
    const latent = randn(new Float32Array(16 * 64 * 64), makeRng(0));
    const s = await loadModel(
      model,
      onProg,
      'webgpu',
      'url',
      {
        graphOptimizationLevel: 'disabled',
      },
      dataName,
    );
    log(`probe session ready. #outputs=${s.outputNames.length}`);
    const out = await run(s, {
      latent: new Tensor('float32', latent, [1, 16, 1, 64, 64]),
      timestep: new Tensor('float32', new Float32Array([1.0]), [1]),
      encoder_hidden_states: new Tensor('float32', pe, [1, 512, 1024]),
    });
    // outputs: probe_absmax_NN / probe_nan_NN — the fp32 residual stream entering
    // LayerNorm NN. Print in block order; flag the first block that overflows/NaNs.
    const blocks: { block: number; absmax: number; nan: number }[] = [];
    let firstBad = -1;
    for (let i = 0; i < 90; i++) {
      const nn = String(i).padStart(2, '0');
      const am = out[`probe_absmax_${nn}`]?.data as Float32Array | undefined;
      const nc = out[`probe_nan_${nn}`]?.data as Float32Array | undefined;
      if (!am || !nc) continue;
      const absmax = am[0];
      const nan = nc[0];
      const bad = nan > 0 || !Number.isFinite(absmax) || absmax > 60000;
      if (bad && firstBad < 0) firstBad = i;
      blocks.push({ block: i, absmax, nan });
      log(`  LN${nn} absmax=${absmax.toExponential(2)} nan=${nan}${bad ? '  ⬅BAD' : ''}`);
    }
    // reliable fp32 output readback if the probe graph provides it
    let noisePred: { min: number; max: number; nan: number; inf: number } | null = null;
    const npf = out['noise_pred_f32'];
    if (npf) {
      const st = tensorStats(npf);
      noisePred = { min: st.min, max: st.max, nan: st.nan, inf: st.inf };
      log(
        `  noise_pred(f32): min=${st.min.toFixed(3)} max=${st.max.toFixed(3)} nan=${st.nan} inf=${st.inf}`,
      );
    }
    log(firstBad >= 0 ? `✅ first bad block: LayerNorm ${firstBad}` : '✅ no bad block found');
    return { model, firstBad, noisePred, blocks };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('❌ ' + msg);
    return { error: msg };
  } finally {
    setBusy(false);
  }
}

// Pull the whole weight set to storage/anima/ via the server. Without this the app
// still works — assetUrl() streams from Hugging Face through /api/ml-weights — but
// every session re-fetches the 3.9 GB DiT, which the proxy sends `no-store`.
async function downloadModels(): Promise<unknown> {
  if (busy()) return { ok: false, error: 'busy' };
  setBusy(true);
  const t0 = performance.now();
  try {
    log(`— Downloading weights (${gb(TOTAL_BYTES)}) from Hugging Face —`);
    let lastFile = '';
    await downloadWeights((p) => {
      setDl(p);
      if (p.file !== lastFile) {
        lastFile = p.file;
        log(`  [${p.index}/${p.count}] ${p.file} (${mb(p.total)})`);
      }
    });
    setDl(null);
    log(
      `✅ weights on disk (${((performance.now() - t0) / 1000).toFixed(0)}s) — now loading locally`,
    );
    return { ok: true, elapsed: (performance.now() - t0) / 1000 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setDl(null);
    log('❌ ' + msg);
    return { ok: false, error: msg };
  } finally {
    setBusy(false);
  }
}

interface LatentStats {
  latents_mean: number[];
  latents_std: number[];
  sigmas: number[];
  z: number;
  size: number;
}

// Full text→image: prompt → embeds → randn latent → ER-SDE 4-step denoise over
// the DiT → per-channel denorm → VAE decode → canvas. The prompt is tokenized and
// encoded in-browser (see text.ts); the golden prompt short-circuits to the
// precomputed prompt_embeds.f32 so the common case skips a 1.46 GB download.
async function generate(
  opts: {
    model?: string;
    seed?: number;
    ditBackend?: 'webgpu' | 'wasm';
    prompt?: string;
  } = {},
): Promise<unknown> {
  if (busy()) return { ok: false, error: 'busy' };
  setBusy(true);
  const model = opts.model ?? ditModel();
  const sd = opts.seed ?? seed();
  const ditBackend = opts.ditBackend ?? 'webgpu';
  const pr = (opts.prompt ?? prompt()).trim();
  const result: Record<string, unknown> = { model, seed: sd, ditBackend, prompt: pr, ok: false };
  try {
    log(`— Generate (DiT: ${model} on ${ditBackend}, seed ${sd}) —`);
    log(`prompt: ${JSON.stringify(pr.slice(0, 80))}${pr.length > 80 ? '…' : ''}`);
    const cfg = await fetchJSON<LatentStats>('webgpu/latent_stats.json');
    const Z = cfg.z; // 16
    const L = cfg.size / 8; // 64 latent grid
    // (1,512,1024) encoder_hidden_states
    const golden = !pr || pr === GOLDEN_PROMPT;
    const pe = golden
      ? await fetchF32('webgpu/prompt_embeds.f32')
      : await promptEmbeds(pr, { onProgress: onProg, log });
    if (golden) log('using precomputed golden prompt_embeds (text path skipped)');

    const t0 = performance.now();
    log(`loading DiT (externalData URL mode, ${ditBackend}, graphOpt disabled)…`);
    const dit = await loadModel(model, onProg, ditBackend, 'url', {
      graphOptimizationLevel: 'disabled',
    });
    log(`DiT ready (${((performance.now() - t0) / 1000).toFixed(1)}s). inputs=${dit.inputNames}`);
    const tv = performance.now();
    const vae = await loadModel('vae_decoder_512_fp16', onProg, 'webgpu', 'url');
    log(`VAE ready (${((performance.now() - tv) / 1000).toFixed(1)}s).`);

    const sched = new ErSDEScheduler(cfg.sigmas, sd);
    const n = Z * 1 * L * L; // 65536
    const steps: unknown[] = [];
    let latent = randn(new Float32Array(n), makeRng(sd ^ 0x9e3779b9)); // init noise

    for (let i = 0; i < sched.numSteps; i++) {
      const sigma = sched.timestepSigma(i);
      const ts = performance.now();
      const out = await run(dit, {
        latent: new Tensor('float32', latent, [1, Z, 1, L, L]),
        timestep: new Tensor('float32', new Float32Array([sigma]), [1]),
        encoder_hidden_states: new Tensor('float32', pe, [1, 512, 1024]),
      });
      const noisePred = out.noise_pred.data as Float32Array;
      const st = stats(noisePred);
      steps.push({ step: i + 1, sigma, npMin: st.min, npMax: st.max, npNan: st.nan });
      if (st.nan > 0) {
        log(`❌ step ${i + 1}: noise_pred has ${st.nan} NaN — DiT numerics broken on this EP.`);
        result.nanAtStep = i + 1;
        result.steps = steps;
        return result;
      }
      latent = sched.step(noisePred, latent);
      const ls = stats(latent);
      log(
        `  step ${i + 1}/${sched.numSteps} σ=${sigma.toFixed(3)} ` +
          `(${((performance.now() - ts) / 1000).toFixed(1)}s) latent std=${Math.sqrt(
            ls.mean * ls.mean + (ls.max - ls.min) / 6,
          ).toFixed(3)} nan=${ls.nan}`,
      );
    }

    // denorm: latents_4d[c,p] = latent[c,p]*std[c] + mean[c] (temporal dim is 1)
    const plane = L * L;
    const denorm = new Float32Array(Z * plane);
    for (let c = 0; c < Z; c++) {
      const m = cfg.latents_mean[c];
      const stdc = cfg.latents_std[c];
      for (let p = 0; p < plane; p++) denorm[c * plane + p] = latent[c * plane + p] * stdc + m;
    }

    const td = performance.now();
    const dec = await run(vae, { latent: new Tensor('float32', denorm, [1, Z, L, L]) });
    const img = dec.image.data as Float32Array;
    const ist = stats(img);
    log(
      `VAE decode ${((performance.now() - td) / 1000).toFixed(2)}s → ${dec.image.dims}. ` +
        `min=${ist.min.toFixed(2)} max=${ist.max.toFixed(2)} nan=${ist.nan}`,
    );
    if (canvasEl) canvasEl.getContext('2d')!.putImageData(chwToImageData(img, 512, 512), 0, 0);
    const elapsed = (performance.now() - t0) / 1000;
    log(`✅ generated in ${elapsed.toFixed(1)}s`);
    result.ok = ist.nan === 0;
    result.steps = steps;
    result.image = { min: ist.min, max: ist.max, nan: ist.nan, dims: dec.image.dims };
    result.elapsed = elapsed;
    result.dataUrl = canvasEl ? canvasEl.toDataURL('image/png') : null;
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('❌ ' + msg);
    result.error = msg;
    return result;
  } finally {
    setBusy(false);
  }
}

function App() {
  onMount(async () => {
    const c = await capabilities();
    setCaps(
      c.webgpu
        ? `WebGPU ✓  f16=${c.f16}  maxBuffer=${gb(c.maxBufferSize)}  maxStorageBinding=${gb(c.maxStorageBufferBindingSize)}  [${c.adapter ?? 'adapter?'}]`
        : 'WebGPU ✗ — no adapter (wasm-only)',
    );
  });
  return html`
    <div class="y-app" style="padding: var(--yaar-sp-4); gap: var(--yaar-sp-3); overflow: auto;">
      <div>
        <h2 style="margin:0">🌸 Anima — WebGPU probe</h2>
        <div class="y-label" style="margin-top:4px">${caps}</div>
      </div>
      <textarea
        class="y-input"
        rows="3"
        placeholder="Describe the image…"
        style="width:100%; min-height:4.5em; resize:vertical; font-family:inherit; line-height:1.4;"
        oninput=${(e: Event) => setPrompt((e.target as HTMLTextAreaElement).value)}
      >
${prompt()}</textarea
      >
      <div class="y-label">
        ${() =>
          prompt().trim() === GOLDEN_PROMPT || !prompt().trim()
            ? 'golden prompt — reuses precomputed embeds (skips the text encoder)'
            : 'custom prompt — runs the text encoder + conditioner (1.46 GB)'}
      </div>
      <div class="y-flex" style="gap: var(--yaar-sp-2); flex-wrap: wrap; align-items: center;">
        <button class="y-btn y-btn-primary" disabled=${busy} onclick=${() => generate()}>
          ✨ Generate image
        </button>
        <select
          class="y-select"
          disabled=${busy}
          onchange=${(e: Event) => setDitModel((e.target as HTMLSelectElement).value)}
        >
          <option
            value="dit_512_fp16_webgpu"
            selected=${() => ditModel() === 'dit_512_fp16_webgpu'}
          >
            fp16 weights / fp32 acts ✓
          </option>
          <option value="dit_512_fp16" selected=${() => ditModel() === 'dit_512_fp16'}>
            fp16 (NaN on WebGPU)
          </option>
        </select>
        <label class="y-label" style="display:flex; gap:4px; align-items:center;"
          >seed
          <input
            class="y-input"
            type="number"
            style="width:70px"
            value=${seed}
            onchange=${(e: Event) => setSeed(Number((e.target as HTMLInputElement).value) | 0)}
          />
        </label>
      </div>
      <div class="y-flex" style="gap: var(--yaar-sp-2); flex-wrap: wrap; align-items: center;">
        <button class="y-btn y-btn-ghost" disabled=${busy} onclick=${downloadModels}>
          ⬇ Download weights (${gb(TOTAL_BYTES)})
        </button>
        <span class="y-label">
          ${() => {
            const p = dl();
            if (!p) return '';
            const pct = p.overallTotal ? (p.overallLoaded / p.overallTotal) * 100 : 0;
            return `${pct.toFixed(1)}% — ${p.file.split('/').pop()} [${p.index}/${p.count}]`;
          }}
        </span>
      </div>
      <div class="y-flex" style="gap: var(--yaar-sp-2); flex-wrap: wrap;">
        <button class="y-btn y-btn-ghost" disabled=${busy} onclick=${vaeProbe}>
          VAE probe (56 MB)
        </button>
        <button class="y-btn y-btn-ghost" disabled=${busy} onclick=${ditGate}>
          DiT gate (fwd only)
        </button>
        <button class="y-btn y-btn-ghost" disabled=${busy} onclick=${() => ditProbe()}>
          DiT probe (find NaN)
        </button>
        <button
          class="y-btn y-btn-ghost"
          disabled=${busy}
          onclick=${() => clearWeightCache().then(() => log('cache cleared'))}
        >
          clear cache
        </button>
      </div>
      <div class="y-flex" style="gap: var(--yaar-sp-3); align-items: flex-start; flex-wrap: wrap;">
        <canvas
          ref=${(el: HTMLCanvasElement) => (canvasEl = el)}
          width="512"
          height="512"
          style="width:512px; height:512px; background: var(--yaar-bg-surface); border:1px solid var(--yaar-border); border-radius:6px;"
        ></canvas>
        <pre
          style="flex:1; min-width:320px; max-height:512px; overflow:auto; margin:0; padding: var(--yaar-sp-2);
          background: var(--yaar-bg-surface); border:1px solid var(--yaar-border); border-radius:6px;
          font-size:12px; line-height:1.5; white-space:pre-wrap;"
        >
${() => logLines().join('\n')}</pre
        >
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);

// Headless driver hook: lets a CDP/automation script run the pipeline and read
// structured JSON results (steps, image stats, PNG dataURL) without clicking the UI.
(window as unknown as { __anima: unknown }).__anima = {
  ready: true,
  generate, // ({model?, seed?, prompt?}) => result
  probe: ditProbe, // () => {rows, firstBad}
  download: downloadModels, // () => {ok, elapsed}
  resolve: assetUrl, // (path) => the same-origin URL a given asset loads from
  clearCache: () => clearWeightCache(),
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
