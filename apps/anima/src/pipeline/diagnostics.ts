// Headless-only diagnostics (no UI buttons — reachable via window.__anima):
//   vaeProbe — decode a Python-precomputed latent (plumbing sanity check).
//   ditGate  — single DiT forward (memory/latency check).
//   ditProbe — per-block residual absmax/NaN trace (diagnostic).
// Plus downloadModels, which is UI-reachable from the Options popover.
import { errMsg } from '@bundled/yaar';
import { capabilities, loadModel, run, Tensor, fetchF32, chwToImageData } from '../ml';
import { makeRng, randn } from '../scheduler';
import { downloadWeights, TOTAL_BYTES } from '../download';
import { gb, log, mb, onProg, stats, tensorStats } from '../logging';
import { busy, canvas, setBusy, setHasImage, setProgress, setStatus } from '../state';
import { DIT_512, ditSessionOptions, releaseOtherDits } from './session';

export async function vaeProbe(): Promise<void> {
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
    const canvasEl = canvas();
    if (canvasEl) {
      canvasEl.getContext('2d')!.putImageData(chwToImageData(img, 512, 512), 0, 0);
      setHasImage(true);
    }
    log('✅ VAE probe done — compare canvas to golden_512_fp16_seed0.png');
  } catch (e) {
    log('❌ ' + errMsg(e));
  } finally {
    setBusy(false);
    setProgress(null);
  }
}

export async function ditGate(): Promise<void> {
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
    await releaseOtherDits(DIT_512);
    // 'url' mode: ORT streams the 3.9 GB sidecar into its wasm heap (no >2 GB JS buffer).
    log('loading DiT via externalData URL mode…');
    const s = await loadModel(DIT_512, onProg, 'webgpu', 'url', ditSessionOptions(DIT_512));
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
    log('❌ ' + errMsg(e));
  } finally {
    setBusy(false);
    setProgress(null);
  }
}

// Localize the WebGPU-EP NaN: run dit_512_fp16_probe (same weights, ~36 extra
// intermediate outputs) once and report which probe tensors are NaN. The earliest
// NaN in graph order pins the culprit op/region.
export async function ditProbe(
  opts: { model?: string; dataName?: string } = {},
): Promise<unknown> {
  if (busy()) return { error: 'busy' };
  setBusy(true);
  const model = opts.model ?? 'dit_512_fp16_probe2';
  const dataName = opts.dataName ?? 'dit_512_fp16.onnx.data';
  try {
    log(`— DiT probe (${model}) —`);
    const pe = await fetchF32('webgpu/prompt_embeds.f32');
    const latent = randn(new Float32Array(16 * 64 * 64), makeRng(0));
    await releaseOtherDits(model);
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
    // outputs: probe_absmax_NN / probe_nan_NN — the residual stream entering
    // LayerNorm NN (older probes, 2-digit) or, for probes built by
    // make_dit_probe.py (3-digit): 000..083 = trunk Add outputs in forward order,
    // 100..183 = branch out-projection inputs (SDPA/GELU outputs — the branch
    // interior maxima). Print in order; flag the first tap that overflows/NaNs.
    const blocks: { block: number; absmax: number; nan: number }[] = [];
    let firstBad = -1;
    for (let i = 0; i < 200; i++) {
      const nn2 = String(i).padStart(2, '0');
      const nn3 = String(i).padStart(3, '0');
      const nn = out[`probe_absmax_${nn3}`] ? nn3 : nn2;
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
    const msg = errMsg(e);
    log('❌ ' + msg);
    return { error: msg };
  } finally {
    setBusy(false);
    setProgress(null);
  }
}

// Pull the whole weight set to storage/anima/ via the server. Without this the app
// still works — assetUrl() streams from Hugging Face through /api/ml-weights — but
// each fresh page load re-fetches the 3.9 GB DiT, which the proxy sends `no-store`
// (within a page, loadModel's session memo means it streams at most once).
export async function downloadModels(): Promise<unknown> {
  if (busy()) return { ok: false, error: 'busy' };
  setBusy(true);
  setStatus('');
  const t0 = performance.now();
  try {
    log(`— Downloading weights (${gb(TOTAL_BYTES)}) from Hugging Face —`);
    let lastFile = '';
    await downloadWeights((p) => {
      const pct = p.overallTotal ? (p.overallLoaded / p.overallTotal) * 100 : null;
      setProgress({
        label: `Downloading ${p.file.split('/').pop()} [${p.index}/${p.count}]`,
        pct,
      });
      if (p.file !== lastFile) {
        lastFile = p.file;
        log(`  [${p.index}/${p.count}] ${p.file} (${mb(p.total)})`);
      }
    });
    const elapsed = (performance.now() - t0) / 1000;
    setStatus(`✅ weights on disk (${elapsed.toFixed(0)}s) — models now load locally`);
    log(`✅ weights on disk (${elapsed.toFixed(0)}s) — now loading locally`);
    return { ok: true, elapsed };
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
