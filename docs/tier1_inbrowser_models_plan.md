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
- **Workstream B** — the `anima-turbo-handy` app (SD-Turbo smoke test) has not
  been built yet.
- **Exe bundling** — `getMlRuntimeDir()` resolves `./ml-runtime/` next to a
  bundled exe, but `scripts/build-exe-bundle.js` does not yet copy the ORT
  artifacts there. Dev mode works today; exe-mode ML needs that copy step.
- **A2** — classifier smoke test → SD-Turbo in-browser validation run.

---

**Non-goal (Tier 2/3):** frontier models needing CUDA/MPS + the full Python stack.
Tier 1 is deliberately scoped to models small enough to download and fit in a
browser tab's memory.

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

- **Memory ceiling.** A quantized DiT + VAE + text encoder may still blow a browser
  tab's budget on lower-end GPUs. Mitigation: capability gate + graceful "too big"
  message; keep Tier 2 (native venv) as the escape hatch for big models.
- **First-load UX.** 100s of MB download on first run. Mitigation: IndexedDB cache +
  honest progress UI; consider pre-warming.
- **Numerics drift.** Quantization + JS scheduler will not bit-match MPS. Mitigation:
  validation harness in Workstream C; treat as a quality budget, not a bug.
- **WebGPU availability in the iframe.** Same-origin should be fine; verify across the
  `IframeRenderer` `allow` list and target Chrome versions before committing.
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
