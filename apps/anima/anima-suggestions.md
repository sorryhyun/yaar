# Anima — runtime-level efficiency knobs (not yet applied)

Cheap, no-re-export experiments on the onnxruntime-web side. Context: the app now
memoizes DiT/VAE sessions across generations (`ml.ts` `loadModel`), and the
`dit_512_fp16_r16` export (residual stream rescaled ×1/16, see
`../../../krea/scripts/rescale_dit_residual.py`) runs plain fp16 activations with
graph optimizations **enabled**. The knobs below stack on top of that. Each is a
one-line session/env option — measure with `__anima.generate()` (`result.elapsed`,
per-step timings in `result.steps`) before keeping any of them.

## 1. `enableGraphCapture: true` (DiT session) — likely the best $/effort

```ts
loadModel(model, onProg, 'webgpu', 'url', { ...ditSessionOptions(model), enableGraphCapture: true });
```

The WebGPU EP records the command dispatches of the first `run()` and replays the
captured bundle on subsequent runs. Our denoise loop is the ideal case: 4+ runs with
**identical shapes** on the same session (now that sessions are memoized, this also
spans generations). Cuts per-step CPU-side dispatch overhead, which is significant
for a 28-block graph at 512 tokens/dispatch granularity.

Caveats: requires every node to run on the GPU EP (a single CPU-assigned op makes
session creation throw — just catch and retry without the flag); incompatible with
dynamic shapes (we have none). Test on the `_r16` model — the cast-hack model's
`graphOptimizationLevel: 'disabled'` graph has far more dispatches and may exceed
capture limits.

## 2. ~~Confirm which WebGPU EP the 1.27 build uses~~ — DONE: migrated to the native EP

Resolved 2026-07-10, and it turned out to be load-bearing, not just a perf knob.
In `onnxruntime-web@1.27.0` the package default (`import 'onnxruntime-web'` →
`ort.bundle.min.mjs` → `ort-wasm-simd-threaded.jsep.*`) is the **old JSEP** WebGPU
EP; the **native (Dawn) EP** ships as `onnxruntime-web/webgpu` →
`ort.webgpu.bundle.min.mjs` → `ort-wasm-simd-threaded.asyncify.*`. The yaar-ml shim
now imports the latter.

The JSEP allocator **miscomputes fp16 graphs** containing single-consumer alias
views: in the DiT's AdaLN `Split → Unsqueeze → broadcast Mul/Add` pattern, block
outputs came back ~10× too large (deterministic, arrangement-dependent — adding a
second consumer to the aliased tensor fixed the affected block, bisected to the
shift chunk `unsqueeze_23`). This — compounding block-over-block into residual
overflow — was a co-culprit of the historical all-NaN-on-WebGPU results, alongside
the genuine fp16 range problem that the ×1/16 residual rescale fixes. Both fixes
are required: the rescale is physics (2.65e5 > fp16 max), the native EP dodges the
allocator bug. Repro artifacts live in `../../../krea/scripts/`
(`make_dit_probe.py`, `tap_ff_block0.py`, `fix_adaln_alias.py`) if this is ever
reported upstream.

Caveat of the flavor switch: the asyncify wasm artifact's **CPU** (wasm-EP) path
carries asyncify overhead vs the jsep artifact — irrelevant for anima (wasm is only
a fallback), worth rechecking if a yaar-ml app ever runs CPU-heavy inference.

## 3. `ort.env.webgpu.powerPreference = 'high-performance'`

Set in `packages/compiler/src/shims/yaar-ml.ts` next to the existing `ort.env.wasm`
setup. On dual-GPU machines (Intel iGPU + discrete) the default adapter can be the
low-power one; harmless elsewhere. Note the app's own `capabilities()` probe calls
`gpu.requestAdapter()` with no options — keep the two consistent or the reported
limits can describe a different adapter than the one ORT uses.

## 4. GPU-resident outputs (`preferredOutputLocation: 'gpu-buffer'`)

Keeps outputs on the GPU instead of downloading to JS. For anima this is a **minor**
win today: the per-step readback is one 256 KB `noise_pred` (the ER-SDE scheduler
runs in JS over 65k floats — negligible), so only chase this if profiling shows the
GPU→CPU sync stalling the pipeline. The bigger version of this idea — porting the
scheduler to a tiny ONNX graph so latents never leave the GPU across all 4 steps —
is only worth it if step time drops well under ~1 s and the sync becomes visible.

## 5. fp16 graph I/O

The `_r16` export keeps fp32 I/O (`keep_io_types=True`), which costs a boundary cast
per run. Exporting with fp16 I/O and feeding `Float16Array` tensors (Chrome ≥ 135;
`asF32` in `ml.ts` already handles both directions for outputs) removes the casts
and halves the 2 MB `encoder_hidden_states` upload per step. Micro-win; do it only
if a re-export happens anyway.

## 6. WebNN EP (`executionProviders: ['webnn']`) — after the numerics fix only

WebNN hands the graph to the OS ML stack (CoreML on macOS, DirectML on Windows),
which can beat WebGPU shaders on Apple Silicon. Only meaningful with the `_r16`
model: the fp16 residual overflow follows the model to any fp16 backend, and the
cast-hack graph's disabled optimizations defeat WebNN's graph compiler. Expect op
coverage gaps (partial fallback to wasm) — test, don't assume.

## 7. Profiling to decide between all of the above

```ts
const s = await loadModel(model, onProg, 'webgpu', 'url', {
  ...ditSessionOptions(model),
  enableProfiling: true,
});
// after a run: ort.env.debug = true dumps per-kernel timings to the console
```

One profiled step answers "dispatch-bound or bandwidth-bound?", which decides
whether graph capture (#1) or precision/EP work (#2/#6) is the next lever.

## Not runtime knobs, but the next real levers (for the record)

- **Weight-only quantization**: text encoder (Qwen ~0.6B, 1.19 GB fp16) → int4
  `MatMulNBits` ≈ 350–400 MB, low risk, WebGPU kernels exist in 1.27. DiT → int8
  weight-only ≈ 2 GB, validate against the golden image first.
- **Write-through disk cache in `/api/ml-weights`**: first streamed run populates
  `storage/anima/` server-side, making the explicit "Download weights" button (and
  the per-page-load 3.9 GB HF re-stream in `'url'` mode) unnecessary.
