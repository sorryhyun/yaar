// Full text→image: prompt → embeds → randn latent → ER-SDE 4-step denoise over
// the DiT → per-channel denorm → VAE decode → canvas. The prompt is tokenized and
// encoded in-browser (see text.ts); the golden prompt short-circuits to the
// precomputed prompt_embeds.f32 so the common case skips a 1.46 GB download.
//
// Resolution is baked into a DiT graph at export time (the Cosmos RoPE tables and
// padding mask constant-fold), so each aspect ratio is its own graph — but NOT its
// own weights: every ratio's graph is re-pointed at the single 3.9 GB r16 sidecar,
// so a ratio costs ~9 MB. See buckets.ts and ../krea/scripts/share_sidecar.py.
import { errMsg } from '@bundled/yaar';
import { loadModel, run, Tensor, fetchF32, fetchJSON, chwToImageData } from '../ml';
import { ErSDEScheduler, makeRng, randn } from '../scheduler';
import { promptEmbeds, promptEmbedsBatch } from '../text';
import { appStorageUri, generatedPath, saveImage as saveToAppStorage } from '../appfiles';
import {
  DEFAULT_BUCKET,
  SHARED_DIT_DATA,
  SHARED_VAE_DATA,
  bucketById,
  latentDims,
  tokens,
} from '../buckets';
import { log, onProg, phase, stats } from '../logging';
import {
  GOLDEN_PROMPT,
  bucket,
  busy,
  canvas,
  prompt,
  seed,
  setBusy,
  setHasImage,
  setLastResult,
  setProgress,
  setStatus,
} from '../state';
import type { GenerationResult } from '../protocol';
import { LatentStatsSchema, type LatentStats } from '../schema';
import type { Bucket } from '../buckets';
import { canvasBlob } from '../utils/canvas';
import { ditSessionOptions, releaseOtherDits } from './session';

export type GenerateOptions = {
  model?: string;
  seed?: number;
  ditBackend?: 'webgpu' | 'wasm';
  prompt?: string;
  /** Aspect-ratio bucket id (see buckets.ts). Defaults to the UI selection. */
  ratio?: string;
  /** Override the per-model graphOptimizationLevel choice (experiments). */
  graphOpt?: string;
};

// Write the freshly painted canvas into app storage and stamp the result with
// where it landed. A save failure is recorded on the result, never thrown — the
// image is on screen either way, and `dataUrl` stays as the fallback.
async function persistToAppStorage(
  result: Record<string, unknown>,
  ratio: string,
  seed: number,
): Promise<void> {
  const path = generatedPath(ratio, seed);
  try {
    await saveToAppStorage(path, await canvasBlob());
    result.saved = true;
    result.storagePath = path;
    result.storageUrl = appStorageUri(path);
    result.dataUrl = undefined;
  } catch (e) {
    result.saved = false;
    result.saveError = errMsg(e);
  }
  result.mimeType = 'image/png';
  result.completedAt = new Date().toISOString();
}

/** One resolved unit of work for the DiT+VAE half of the pipeline. */
type RenderJob = {
  bk: Bucket;
  model: string;
  sd: number;
  ditBackend: 'webgpu' | 'wasm';
  prompt: string;
  pe: Float32Array;
  cfg: LatentStats;
  graphOpt?: string;
  /** Progress/log prefix like "2/6" for batch items; omitted for solo generate. */
  tag?: string;
};

// The DiT+VAE half of the pipeline: given precomputed prompt embeds, load the DiT
// and VAE (memoized — reused across a batch), run the ER-SDE denoise loop, denorm,
// VAE-decode, paint the canvas, and persist. Split out of `generate` so
// `batchGenerate` can run it many times behind a SINGLE text-encode phase. Catches
// its own errors and returns an ok:false result, so one bad item never aborts a batch.
async function renderFromEmbeds(job: RenderJob): Promise<Record<string, unknown>> {
  const { bk, model, sd, ditBackend, prompt: pr, pe, cfg, graphOpt, tag } = job;
  const label = tag ? `[${tag}] ` : '';
  const result: Record<string, unknown> = {
    model,
    ratio: bk.id,
    size: [bk.W, bk.H],
    seed: sd,
    ditBackend,
    prompt: pr,
    ok: false,
  };
  try {
    const Z = cfg.z; // 16
    // Latent grid comes from the bucket, NOT cfg — cfg is per-channel denorm stats +
    // sigmas, which are resolution-independent.
    const { lh, lw } = latentDims(bk);

    const t0 = performance.now();
    await releaseOtherDits(model);
    const sessOpts = ditSessionOptions(model, graphOpt);
    phase(`${label}Loading DiT (${model})…`);
    // Non-square buckets were re-pointed at the canonical sidecar by share_sidecar.py,
    // so switching ratio costs a ~9 MB graph, not another 3.9 GB. The square bucket is
    // left to derive `<model>.onnx.data` itself: its variant selector can pick the
    // un-rescaled exports (plain fp16, the NaN repro), whose weights are NOT the r16
    // bytes — handing those the shared sidecar would silently load the wrong weights.
    const ditData = bk.id === DEFAULT_BUCKET.id ? undefined : SHARED_DIT_DATA;
    const dit = await loadModel(model, onProg, ditBackend, 'url', sessOpts, ditData);
    log(
      `${label}DiT ready (${((performance.now() - t0) / 1000).toFixed(1)}s). inputs=${dit.inputNames}`,
    );
    const tv = performance.now();
    phase(`${label}Loading VAE decoder…`);
    const vaeData = bk.id === DEFAULT_BUCKET.id ? undefined : SHARED_VAE_DATA;
    const vae = await loadModel(bk.vae, onProg, 'webgpu', 'url', {}, vaeData);
    log(`${label}VAE ready (${((performance.now() - tv) / 1000).toFixed(1)}s).`);

    const sched = new ErSDEScheduler(cfg.sigmas, sd);
    const n = Z * 1 * lh * lw;
    const steps: unknown[] = [];
    let latent = randn(new Float32Array(n), makeRng(sd ^ 0x9e3779b9)); // init noise

    for (let i = 0; i < sched.numSteps; i++) {
      const sigma = sched.timestepSigma(i);
      setProgress({
        label: `${label}Denoising step ${i + 1}/${sched.numSteps} (σ=${sigma.toFixed(3)})`,
        pct: (i / sched.numSteps) * 100,
      });
      const ts = performance.now();
      const out = await run(dit, {
        latent: new Tensor('float32', latent, [1, Z, 1, lh, lw]),
        timestep: new Tensor('float32', new Float32Array([sigma]), [1]),
        encoder_hidden_states: new Tensor('float32', pe, [1, 512, 1024]),
      });
      const noisePred = out.noise_pred.data as Float32Array;
      const st = stats(noisePred);
      steps.push({ step: i + 1, sigma, npMin: st.min, npMax: st.max, npNan: st.nan });
      if (st.nan > 0) {
        setStatus(
          `❌ ${label}step ${i + 1}: noise_pred has ${st.nan} NaN — DiT numerics broken on this EP`,
        );
        log(`❌ ${label}step ${i + 1}: noise_pred has ${st.nan} NaN — DiT numerics broken.`);
        result.nanAtStep = i + 1;
        result.steps = steps;
        setLastResult(result as GenerationResult);
        return result;
      }
      latent = sched.step(noisePred, latent);
      const ls = stats(latent);
      log(
        `  ${label}step ${i + 1}/${sched.numSteps} σ=${sigma.toFixed(3)} ` +
          `(${((performance.now() - ts) / 1000).toFixed(1)}s) latent std=${Math.sqrt(
            ls.mean * ls.mean + (ls.max - ls.min) / 6,
          ).toFixed(3)} nan=${ls.nan}`,
      );
    }

    // denorm: latents_4d[c,p] = latent[c,p]*std[c] + mean[c] (temporal dim is 1)
    const plane = lh * lw;
    const denorm = new Float32Array(Z * plane);
    for (let c = 0; c < Z; c++) {
      const m = cfg.latents_mean[c];
      const stdc = cfg.latents_std[c];
      for (let p = 0; p < plane; p++) denorm[c * plane + p] = latent[c * plane + p] * stdc + m;
    }

    const td = performance.now();
    phase(`${label}Decoding image (VAE)…`, 100);
    const dec = await run(vae, { latent: new Tensor('float32', denorm, [1, Z, lh, lw]) });
    const img = dec.image.data as Float32Array;
    const ist = stats(img);
    log(
      `${label}VAE decode ${((performance.now() - td) / 1000).toFixed(2)}s → ${dec.image.dims}. ` +
        `min=${ist.min.toFixed(2)} max=${ist.max.toFixed(2)} nan=${ist.nan}`,
    );
    const canvasEl = canvas();
    if (canvasEl) {
      // Resizing a canvas clears it, so size it before painting (the ratio may have
      // changed since the last render).
      canvasEl.width = bk.W;
      canvasEl.height = bk.H;
      canvasEl.getContext('2d')!.putImageData(chwToImageData(img, bk.H, bk.W), 0, 0);
      setHasImage(true);
    }
    const elapsed = (performance.now() - t0) / 1000;
    setStatus(`✅ ${label}generated in ${elapsed.toFixed(1)}s (seed ${sd})`);
    log(`✅ ${label}generated in ${elapsed.toFixed(1)}s`);
    result.ok = ist.nan === 0;
    result.steps = steps;
    result.image = { min: ist.min, max: ist.max, nan: ist.nan, dims: dec.image.dims };
    result.elapsed = elapsed;
    result.dataUrl = canvasEl ? canvasEl.toDataURL('image/png') : null;
    // Persist right after painting (the canvas holds this item's pixels until the next
    // render overwrites them). Every generation funnels through here, so the ✨ button,
    // `generate`, and `batchGenerate` all land in app storage alike.
    if (result.ok) await persistToAppStorage(result, bk.id, sd);
    setLastResult(result as GenerationResult);
    return result;
  } catch (e) {
    const msg = errMsg(e);
    setStatus('❌ ' + msg);
    log('❌ ' + msg);
    result.error = msg;
    setLastResult(result as GenerationResult);
    return result;
  }
}

export async function generate(opts: GenerateOptions = {}): Promise<unknown> {
  if (busy()) return { ok: false, error: 'busy' };
  setBusy(true);
  const bk = opts.ratio ? bucketById(opts.ratio) : bucket();
  const model = opts.model ?? bk.dit;
  const sd = opts.seed ?? seed();
  const ditBackend = opts.ditBackend ?? 'webgpu';
  const pr = (opts.prompt ?? prompt()).trim();
  try {
    setStatus('');
    log(`— Generate (DiT: ${model} on ${ditBackend}, seed ${sd}) —`);
    log(`ratio ${bk.id} → image ${bk.W}×${bk.H}, ${tokens(bk)} attention tokens`);
    log(`prompt: ${JSON.stringify(pr.slice(0, 80))}${pr.length > 80 ? '…' : ''}`);
    phase('Preparing…');
    const cfg = await fetchJSON('webgpu/latent_stats.json', LatentStatsSchema);
    const golden = !pr || pr === GOLDEN_PROMPT;
    if (!golden) phase('Encoding prompt (text encoder, 1.46 GB)…');
    const pe = golden
      ? await fetchF32('webgpu/prompt_embeds.f32')
      : await promptEmbeds(pr, { onProgress: onProg, log });
    if (golden) log('using precomputed golden prompt_embeds (text path skipped)');
    return await renderFromEmbeds({ bk, model, sd, ditBackend, prompt: pr, pe, cfg, graphOpt: opts.graphOpt });
  } catch (e) {
    const msg = errMsg(e);
    setStatus('❌ ' + msg);
    log('❌ ' + msg);
    const result: GenerationResult = { ok: false, error: msg, prompt: pr, seed: sd, ratio: bk.id };
    setLastResult(result);
    return result;
  } finally {
    setBusy(false);
    setProgress(null);
  }
}

export type BatchRequest = {
  prompt: string;
  seed?: number;
  ratio?: string;
};

/** Generate many images behind ONE text-encode phase. All prompts are encoded first
 *  (text encoder + conditioner loaded once — see promptEmbedsBatch), then the DiT+VAE
 *  run per item, grouped by ratio so each ratio's 3.9 GB DiT loads at most once. This
 *  is the whole point: N distinct prompts pay the 1.46 GB text load once instead of N
 *  times, and text weights never coexist with the DiT. Per-item failures are captured
 *  in that item's result; the batch continues. */
export async function batchGenerate(
  requests: BatchRequest[],
  opts: { ditBackend?: 'webgpu' | 'wasm'; graphOpt?: string } = {},
): Promise<unknown> {
  if (busy()) return { ok: false, error: 'busy' };
  if (!Array.isArray(requests) || requests.length === 0) {
    return { ok: false, error: 'batchGenerate needs a non-empty requests array' };
  }
  setBusy(true);
  const ditBackend = opts.ditBackend ?? 'webgpu';
  try {
    setStatus('');
    log(`— Batch generate (${requests.length} requests, DiT on ${ditBackend}) —`);
    const cfg = await fetchJSON('webgpu/latent_stats.json', LatentStatsSchema);

    // Resolve each request to a concrete job (seed defaults to its index, so an
    // all-defaults batch still yields distinct images rather than N identical ones).
    const jobs = requests.map((r, i) => {
      const bk = r.ratio ? bucketById(r.ratio) : bucket();
      return {
        bk,
        model: bk.dit,
        sd: (r.seed ?? i) | 0,
        prompt: (r.prompt ?? '').trim(),
      };
    });

    // ── Text phase: encode every distinct custom prompt in one load of the text
    // weights; golden prompts reuse the precomputed embeds (no text path at all). ──
    const isGolden = (p: string) => !p || p === GOLDEN_PROMPT;
    const goldenPe = jobs.some((j) => isGolden(j.prompt))
      ? await fetchF32('webgpu/prompt_embeds.f32')
      : null;
    const customPrompts = jobs.filter((j) => !isGolden(j.prompt)).map((j) => j.prompt);
    if (customPrompts.length) {
      phase(`Encoding ${customPrompts.length} prompt(s) (text encoder, 1.46 GB)…`);
    }
    const customEmbeds = customPrompts.length
      ? await promptEmbedsBatch(customPrompts, { onProgress: onProg, log })
      : [];
    const embedByPrompt = new Map<string, Float32Array>();
    customPrompts.forEach((p, i) => embedByPrompt.set(p, customEmbeds[i]));

    // ── DiT phase: run each job, but ordered by ratio so a ratio's DiT session is
    // reused across its whole group instead of being evicted and reloaded. Results
    // are returned in the caller's original request order. ──
    const results: Record<string, unknown>[] = new Array(jobs.length);
    const order = [...jobs.keys()].sort((a, b) => jobs[a].bk.id.localeCompare(jobs[b].bk.id));
    let done = 0;
    for (const i of order) {
      const j = jobs[i];
      const pe = isGolden(j.prompt) ? goldenPe! : embedByPrompt.get(j.prompt)!;
      results[i] = await renderFromEmbeds({
        bk: j.bk,
        model: j.model,
        sd: j.sd,
        ditBackend,
        prompt: j.prompt,
        pe,
        cfg,
        graphOpt: opts.graphOpt,
        tag: `${++done}/${jobs.length}`,
      });
    }

    const okCount = results.filter((r) => r?.ok).length;
    setStatus(`✅ batch: ${okCount}/${results.length} generated`);
    log(`✅ batch done: ${okCount}/${results.length} ok`);
    return { ok: okCount > 0, count: results.length, okCount, results };
  } catch (e) {
    const msg = errMsg(e);
    setStatus('❌ ' + msg);
    log('❌ ' + msg);
    return { ok: false, error: msg };
  } finally {
    setBusy(false);
    setProgress(null);
  }
}
