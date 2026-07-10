# Tier 1 — In-Browser Native Models (WebGPU / ONNX) Plan

**Goal:** let a YAAR app run a model *inside the app iframe* — no Python server, no
install — using WebGPU (with a wasm fallback). This makes YAAR apps able to ship
their own model and run it anywhere the desktop runs, including remote/headless mode.

---

## Status

**Workstream A (`@bundled/yaar-ml`) — ✅ shipped.** The reusable in-browser runtime
is implemented and verified end-to-end. Milestone 1's platform half ("a YAAR app
runs a model, no Python") is done. See [`yaar_ml_runtime.md`](./yaar_ml_runtime.md).

- Runtime SDK shim `packages/compiler/src/shims/yaar-ml.ts` — wraps
  `onnxruntime-web` (v1.27): `capabilities()`, `session()` (WebGPU→wasm auto),
  `run()`, `fetchWeights()` (IndexedDB-cached + progress), `clearCache()`,
  `dispose()`, `Tensor`/`env`/`ort`. Gated behind `app.json` `"bundles": ["yaar-ml"]`
  (automatic via the existing `yaar-*` guard in `plugins.ts`).
- Bundled types for `@bundled/yaar-ml` (self-contained; typecheck passes).
- Static artifact route `GET /api/ml-runtime/{file}` serves ORT's `.wasm`/`.mjs`
  (`getMlRuntimeDir()` in server `config.ts`; immutable-cached; traversal-guarded).
- **Design correction:** deployed apps run under CSP `connect-src 'self'`, so
  weights can't be fetched cross-origin directly and `/api/fetch` caps at 10 MB
  base64. Added a same-origin **streaming** proxy `GET /api/ml-weights?url=…`
  (SSRF + domain-allowlist enforced, forwards `Content-Length`/`ETag`/`Range`,
  no double-buffering). The shim routes weight downloads through it.
- Verified live: gating (fail w/o `bundles`, 424 KB bundle w/ it), artifact route
  (200 `application/wasm` immutable; traversal→400; missing→404), weights proxy
  (400 on missing url / SSRF; real HuggingFace file streamed with headers intact),
  typecheck + lint + prettier clean.

**Not yet done (follow-ups):**
- ~~**DiT fp16 NaN on WebGPU**~~ — **RESOLVED (2026-07-08).** Root cause was NOT
  attention overflow (the plan's earlier guess): the DiT's **residual stream**
  legitimately reaches |x|~2.6e5 by mid-network, which is +Inf in fp16 (max 65504).
  The CPU EP hid it (no native fp16 kernels → up-casts to fp32); the WebGPU EP runs
  fp16 natively so the residual overflows → LayerNorm(Inf)=NaN → all-NaN output.
  Found via a per-block residual-absmax probe run in-browser. **Fix:** a surgical
  re-export that keeps fp16 WEIGHTS but fp32 ACTIVATIONS — each weight matrix is
  stored fp16 and fed through a `Cast(fp16→fp32)`, so activations never materialise
  as fp16. Download stays ~3.9 GB; load with `graphOptimizationLevel:'disabled'` so
  ORT doesn't constant-fold the casts (→ 7.8 GB fp32 in memory). Script:
  `../krea/scripts/export_onnx_dit_webgpu.py` → `dit_512_fp16_r16.onnx`. No
  op-pinning within the fp16 export works (any fp16 tensor the residual touches —
  MatMul/Add/**Reshape/Transpose/Concat** — overflows); only full fp32 activations do.
  Verified: `apps/anima` renders a coherent, on-prompt 512² image on the WebGPU EP.
- **`apps/anima` full pipeline** — Phase 0 (VAE render + DiT load/run) is proven;
  still to build: JS tokenizers (Qwen2 byte-level BPE + T5 Unigram — both embedded
  in the copied `tokenizer.json`, validated against Python golden ids), the er_sde
  scheduler ported to JS, and the text→DiT-loop→VAE orchestration + real UI.
- **`@bundled/yaar-ml` external-data support** — fold the app's URL/Blob
  external-data loader back into the SDK (see Phase-0 "feeds back into A").
- **Exe bundling** — `getMlRuntimeDir()` resolves `./ml-runtime/` next to a
  bundled exe, but `scripts/build-exe-bundle.js` does not yet copy the ORT
  artifacts there. Dev mode works today; exe-mode ML needs that copy step.

**Superseded:** the SD-Turbo smoke test (A2 / Workstream B) was skipped — the real
Anima pipeline validated the platform directly (VAE render is pixel-correct on
WebGPU). SD-Turbo is no longer on the critical path.

---

**Non-goal (Tier 2/3):** frontier models needing CUDA/MPS + the full Python stack.
Tier 1 is deliberately scoped to models small enough to download and fit in a
browser tab's memory.

---

## Progress update (Phase 0 — in-browser Anima, verified live 2026-07-08)

We skipped the SD-Turbo placeholder and drove the **real Anima ONNX pipeline**
(Workstream C is done on the krea side — `../krea`: DiT / Qwen2D VAE / Qwen3 text
encoder / conditioner all exported fp32+fp16 and verified, incl. a full-pipeline
Python e2e producing a coherent on-prompt image). Built `apps/anima/`
(`"bundles": ["yaar-ml"]`) and probed each stage on WebGPU. Findings below change
the plan's risk profile materially.

### What works (verified in a real browser tab)

- **Plumbing is sound end-to-end.** The **VAE decoder (56 MB fp16)** loads and runs
  on the WebGPU EP and renders a **pixel-correct** 512² image vs the Python golden
  (`min/max = ±1.00`, `nan=0`). This exercises the whole chain: local-weight
  serving → external-data loading → WebGPU session → `run()` → canvas render.
- **Serving local weights: use a read-only mount, not the ml-weights proxy.** The
  `/api/ml-weights` proxy is HuggingFace/allowlist-oriented and blocks localhost
  (SSRF) — it can't serve `../krea/onnx`. Instead we mounted the model dir
  (`config/mounts.json` → alias `krea`) and fetch same-origin from
  `/api/storage/mounts/krea/…`. Bun's `Bun.file` response streams multi-GB files
  with correct `206`/`Content-Range`, so the 3.9 GB DiT serves fine. Same-origin
  `/api/*` fetches pass straight through the iframe fetch-proxy (CSP `connect-src
  'self'`), so no proxy/allowlist friction.
- **Capabilities on the test machine** (Apple M-series, "APPLE METAL-3"): WebGPU ✓,
  `shader-f16` ✓, `maxBufferSize = maxStorageBufferBindingSize = 4.00 GB` — far
  above the ~128 MB the export notes feared.

### The real first ceiling is **V8's 2 GB per-ArrayBuffer cap**, not WebGPU

- Measured cutoff in-tab: `new Uint8Array(1.9 GB)` OK, `2.0 GB`+ throws
  *"Array buffer allocation failed"* — on a 32 GB machine. This is V8's
  `2³¹−1`-byte limit on a single `ArrayBuffer`/`TypedArray`, **not** GPU memory and
  **not** the GC heap. No `--js-flags` / CDP knob reliably lifts it.
- **`WebAssembly.Memory` is exempt** — it allocates up to 4 GB (3.5 / 3.9 / 4.0 GB
  all OK). onnxruntime-web's staging arena lives here, so a 3.9 GB model *can*
  physically load — the only problem is materializing it as one >2 GB **JS** buffer.
- **Fix — stream external data instead of buffering it.** The shim's `session()`
  hands ORT a single in-memory buffer and does **not** handle external-data
  sidecars. ORT-web 1.27's `ExternalDataFileType` accepts a **URL string or a
  `Blob`**, not just `Uint8Array`. Passing the sidecar as a same-origin **URL** makes
  ORT fetch + stream it straight into wasm memory, never building a >2 GB JS buffer.
  `apps/anima/src/ml.ts` `loadModel(..., mode)` implements `bytes | url | blob`;
  the same VAE image is byte-identical in `bytes` and `url` mode, proving URL-mode
  loads external data correctly.
- **Result: the 3.9 GB fp16 DiT LOADS on WebGPU (~4 s) and runs a forward (~2–3 s).**
  The "DiT won't fit a browser GPU" fear (krea notes §4 / Risk "Memory ceiling") is
  **disproven on this GPU** — no int8, no sharding, full fp16.

### Open blocker: the fp16 DiT forward returns **all-NaN on the WebGPU EP**

- Input-independent (all-NaN with both a zero latent and a proper `randn` latent);
  URL-mode loading is proven correct (VAE), so this is genuine fp16 numerics, not a
  load bug. The **same fp16 graph is coherent on native ORT-CPU** (the Python e2e),
  so it is **WebGPU-EP-specific**.
- **Hypothesis:** fp16 attention overflow — QK<sup>T</sup> scores exceed fp16 range
  (±65504) → Inf → softmax NaN. Pinning *softmax* to fp32 (already in
  `convert_fp16.py`) doesn't help if the score **MatMul** runs fp16, and a fused
  WebGPU attention kernel can bypass the pin entirely. This is exactly the risk krea
  notes §2 pre-flagged ("confirm ORT-web WebGPU has the Attention/SDPA op; else
  install naive matmul+softmax").
- **Fix candidates** (in order of confidence):
  1. **Re-export the DiT WebGPU-safe** (krea side): eager attention with the
     QK<sup>T</sup> MatMul **and** softmax pinned fp32 (extend the fp16 op-blocklist
     to those node names), or scale-before-softmax. Keeps fp16 weights (fits via
     URL mode). Most likely to work; mirrors the text-encoder eager-attention choice.
  2. **ORT-web knobs, no re-export:** `graphOptimizationLevel: 'disabled'` (stop a
     bad fp16 attention fusion) and/or disabling fused MHA. Cheap to try; testing.
  3. int8 weight-only **does not** address this (attention compute stays fp16).

### Feeds back into Workstream A (`@bundled/yaar-ml`)

The SDK should absorb what the app had to work around:
- **First-class external-data support** in `session()`: accept `{ path, data }`
  where `data` may be bytes / **URL** / **Blob**, and **auto-select URL streaming
  for sidecars >2 GB** so apps never hit the ArrayBuffer cap by accident.
- **Local-weight serving story:** document mounts (`/api/storage/mounts/…`) as the
  path for non-HF/local models; the ml-weights proxy is for remote allowlisted hosts.
- **Docs:** add the 2 GB ArrayBuffer cap and the wasm-heap 4 GB ceiling to
  `yaar_ml_runtime.md` "what fits", alongside the GPU-buffer limit.

---

## 1. Feasibility (verified against the codebase)

| Concern | Finding | Consequence |
|---|---|---|
| App origin | Apps served same-origin at `/api/apps/{id}/dist/index.html` (`features/dev/deploy.ts`, `features/browser/actions.ts:85`) — a real URL, not `srcdoc` | `fetch()`, IndexedDB, `navigator.gpu` all behave normally |
| CSP | HTML wrapper (`compiler/src/compile.ts:106`) sets **no** `Content-Security-Policy` | wasm + WebGPU are not blocked |
| Cross-origin isolation | No COOP/COEP headers | **No `SharedArrayBuffer`** → ORT *multithreaded wasm* unavailable. **WebGPU EP needs neither** → primary path unaffected; single-thread wasm is the fallback |
| Bundled SDK hook | `@bundled/*` has a gated-SDK path (`yaar-web`/`yaar-dev`) enforced via `app.json` `"bundles"` in `plugins.ts` | Add the ML runtime the same way — clean, already-permissioned |
| Runtime artifacts | ORT ships `.wasm` / WebGPU JS artifacts loaded at runtime from a URL; they **cannot** be inlined by `Bun.build` | Must serve them from a static route and point `ort.env.wasm.wasmPaths` at it |
| iframe `allow` | `IframeRenderer.tsx:308` sets `allow="accelerometer; autoplay; clipboard-write; …"` | WebGPU works in **same-origin** iframes by default; add a guard + feature-detect. Extend `allow` only if a Chrome version gates it |
| Big weights | `curl_allowed_domains.yaml` currently `allow_all_domains: true`; HF `resolve` URLs send CORS headers | Fetch weights **directly** in-iframe (not via `yaar://http`, to avoid double-buffering 100s of MB), cache in IndexedDB |

**Verdict:** the platform can host in-browser models today with two additions — a
gated ML-runtime SDK, and a static route for its wasm/webgpu artifacts. No changes
to CSP or the compiler HTML wrapper are required.

---

## 2. Two workstreams (keep them separate)

### A. Platform capability — `@bundled/yaar-ml` (reusable, ship first)

The generic runtime any future app can use. Deliverables:

1. **Runtime SDK shim** `packages/compiler/src/shims/yaar-ml.ts`, registered in
   `BUNDLED_SHIMS` + `BUNDLED_LIBRARIES` and gated behind `app.json` `"bundles": ["yaar-ml"]`
   (mirror the `yaar-web` enforcement in `plugins.ts`). It wraps **onnxruntime-web**
   and exposes a tiny, YAAR-flavored API:
   - `ml.session(modelUrl, { backend: 'webgpu' | 'wasm' | 'auto' })` → cached `InferenceSession`
   - `ml.run(session, feeds)` → outputs
   - `ml.fetchWeights(url, { onProgress })` → ArrayBuffer, **IndexedDB-cached** (keyed by URL+etag)
   - `ml.capabilities()` → `{ webgpu: bool, f16: bool, maxBufferSize, estMemoryBudget }`
   - Auto-selects WebGPU, falls back to single-thread wasm; surfaces a clear error
     if a model exceeds `maxStorageBufferBindingSize`.
2. **Bundled types** `packages/compiler/src/bundled-types/` entry so `bun run typecheck` sees `@bundled/yaar-ml`.
3. **Static artifact route** — serve ORT's `.wasm`/webgpu JS from e.g.
   `/api/ml-runtime/*` (server static handler; `config.ts` already maps mime types).
   Shim sets `ort.env.wasm.wasmPaths = '/api/ml-runtime/'`. Ship the artifacts with
   the repo / bundled exe so it works offline.
4. **Weight cache + progress** — IndexedDB store with an eviction budget; a reusable
   `DownloadProgress` helper so apps get a real progress bar on first load.
5. **Capability/limits doc** — one page on tab-memory ceilings, WebGPU buffer limits,
   quantization guidance, and "what fits" (whisper-tiny, small SD-Turbo, embedders,
   classifiers). Silent OOM must become a friendly "this model is too big for your GPU".

**Model to validate the pipeline first — NOT Anima.** Pick a model that already has a
working ONNX + in-browser story so the platform lands independently of the hard
export work. Recommended: **SD-Turbo (ONNX, int8) via onnxruntime-web WebGPU** — it's
on-theme (image gen), a known-good browser target, and proves the whole path
(download → cache → WebGPU session → image out). A trivial classifier/embedder can be
the smoke test before SD-Turbo.

### B. The `anima-turbo-handy` app (product, ships against A)

A Solid.js app (`apps/anima-turbo-handy/`) using `@bundled/yaar-ml`:

- **UI:** prompt / negative / steps / cfg / seed / resolution form; live progress bar
  driven by the scheduler step callback; result gallery.
- **First release runs SD-Turbo** (works the day Workstream A lands).
- **Storage:** history + generated images via `appStorage`.
- **Agent control:** `app.json` (`"bundles": ["yaar-ml"]`) + `SKILL.md` so the monitor
  agent can generate from natural language ("draw a snowy 1girl") through the app
  protocol; `command`/`query` verbs expose `generate` + `getResult`.
- **Model swap later:** switch the model URL from SD-Turbo to the Anima ONNX bundle
  produced by Workstream C — the app code doesn't change.

### C. Anima ONNX export spike (the hard tail — parallel, offline, Python)

This is the research-grade part; it must **not** block A or B.

1. Bake the Turbo LoRA into the base offline — you already have this
   (`../krea/anima_lora.py`, the delta-merge). Exported model = "merged Anima", no
   runtime LoRA.
2. Export transformer + **Qwen2D VAE** + text encoder to ONNX. Cosmos-style DiTs don't
   export cleanly — expect custom-op wrangling and opset pinning.
3. Quantize to int8 (weights) / f16 (compute); **validate numerics** against the MPS
   reference — flow-match/er_sde scheduler reimplemented in JS must match.
4. Fit within WebGPU buffer limits; shard weights if needed.
5. Deliverable: a `.onnx` bundle + JS scheduler the app can point at. **Accept up front
   that quality/speed will regress vs native MPS** — Tier 1's price for portability.

---

## 3. Sequencing

```
A1 runtime shim + artifact route + weight cache   ─┐
A2 smoke test (classifier) → SD-Turbo in-browser   ├─ Milestone 1: "a YAAR app runs a model, no Python"
B  anima-turbo-handy shipping on SD-Turbo          ─┘
                                                    
C  Anima ONNX export spike (parallel, offline)     ── Milestone 2: swap SD-Turbo → Anima, same app
```

Milestone 1 is a real, demoable platform capability on its own. Milestone 2 delivers
*your* model, and only it carries the porting risk.

---

## 4. Risks / open questions

- **Memory ceiling.** *Refined by Phase 0.* The first wall is **V8's 2 GB
  per-ArrayBuffer cap**, not the GPU — dodge it by streaming external data via URL
  (wasm heap holds 4 GB). The full-fp16 DiT (3.9 GB) fits an Apple Metal GPU
  (4 GB buffer limits); lower-end/mobile GPUs will still fall over, and total tab
  memory (all four models ≈ 5.4 GB fp16) is the next ceiling. Mitigation: capability
  gate + graceful "too big"; load/dispose models sequentially where possible; keep
  Tier 2 (native venv) as the escape hatch; int8 the DiT if targeting weaker GPUs.
- **First-load UX.** 100s of MB download on first run. Mitigation: IndexedDB cache +
  honest progress UI; consider pre-warming.
- **Numerics drift → now a concrete blocker, not just drift.** The fp16 DiT returns
  **all-NaN on the WebGPU EP** (fine on ORT-CPU) — see Phase 0. Beyond the quality
  budget, fp16 range/overflow on WebGPU kernels must be handled at export time
  (WebGPU-safe attention). Mitigation: re-export with fp32-pinned QK<sup>T</sup>+
  softmax; keep the Python golden as the numeric oracle for the JS pipeline.
- **WebGPU availability in the iframe.** *Confirmed fine* — WebGPU works in the
  same-origin app context (verified: `navigator.gpu` adapter present, sessions run).
  The standalone probe loads the compiled app directly at
  `/api/apps/anima/dist/index.html`, which is the fastest dev loop for ML apps.
- **Runtime bundle size.** onnxruntime-web + wasm artifacts are several MB; served
  once from `/api/ml-runtime/`, cached by the browser — acceptable, but note it in the
  exe-bundle size.
- **Which runtime?** onnxruntime-web (WebGPU EP) is the safe default. `transformers.js`
  is friendlier for HF models but adds a layer; `webgpu`-native ports (MLC) are fastest
  but per-model. Recommend ORT-web for the generic SDK, revisit per hot model.

---

## 5. What this unlocks beyond one app

The `@bundled/yaar-ml` runtime is the reusable win: any future app can embed a small
model — on-device whisper transcription, semantic search embeddings, background
removal, image classification, small SD variants — with zero install and full
portability into remote mode. "Anima Turbo Handy" is the first customer, not the point.
