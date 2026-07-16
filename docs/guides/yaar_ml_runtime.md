# `@bundled/yaar-ml` — In-Browser Model Runtime

**Source:** `packages/compiler/src/shims/yaar-ml.ts`, `packages/compiler/src/bundled-types/index.d.ts`, `packages/server/src/http/routes/ml-runtime.ts`, `packages/server/src/config.ts`

Run a model *inside a YAAR app iframe* — no Python, no install — using WebGPU
(with a single-thread wasm fallback). Weights download once and cache in the
browser, so an ML app ships its model and runs anywhere the desktop runs,
including remote/headless mode.

This is **Tier 1** from [`tier1_inbrowser_models_plan.md`](./tier1_inbrowser_models_plan.md):
models small enough to download and fit in a browser tab. Frontier models that
need CUDA/MPS are out of scope (that's the native Tier 2/3 path).

The SDK is **gated** — declare it in `app.json`:

```json
{ "bundles": ["yaar-ml"] }
```

---

## Quick start

```typescript
import { capabilities, session, run, Tensor } from '@bundled/yaar-ml';

const caps = await capabilities();
if (!caps.webgpu) console.warn('No WebGPU — falling back to (slower) wasm');

// Downloads + caches weights, creates a WebGPU session (wasm fallback in `auto`).
const s = await session('https://huggingface.co/<repo>/resolve/main/model.onnx', {
  backend: 'auto',
  onProgress: (p) => console.log(`${(p.ratio * 100) | 0}%`),
});

const input = new Tensor('float32', new Float32Array(1 * 3 * 224 * 224), [1, 3, 224, 224]);
const out = await run(s, { pixel_values: input });
console.log(out);
```

## API

| Function | Purpose |
|---|---|
| `capabilities()` | `{ webgpu, f16, maxBufferSize, maxStorageBufferBindingSize, estMemoryBudget, adapter }`. Never throws; cached. |
| `session(model, opts?)` | Create (or return a memoized) `InferenceSession` from a model **URL** or raw `ArrayBuffer`/`Uint8Array`. `opts.backend`: `'webgpu' \| 'wasm' \| 'auto'` (default `auto`). `opts.onProgress` reports weight download. |
| `run(session, feeds, options?)` | Run inference. `feeds` maps input names → `Tensor`. Resolves to the output map. |
| `fetchWeights(url, opts?)` | Download weights as an `ArrayBuffer`, IndexedDB-cached by URL, streamed with `opts.onProgress`. `opts.force` re-downloads. |
| `clearCache(url?)` | Evict one cached weight file, or the whole cache. |
| `dispose(session)` | Release a session's native resources. |
| `Tensor`, `env`, `ort` | onnxruntime-web's `Tensor` constructor, `env` (advanced tuning), and the raw namespace. |

## How it works (platform plumbing)

- **Runtime artifacts.** onnxruntime-web loads its `.wasm` binaries at runtime.
  The SDK points `ort.env.wasm.wasmPaths` at `/api/ml-runtime/`, a static route
  (immutable, hard-cached). In dev it serves from the installed
  `onnxruntime-web/dist`; a standalone exe has no `node_modules`, so
  `build-exe-bundle.js` embeds the three artifacts the SDK pins
  (`ort.webgpu.bundle.min.mjs` + the asyncify `.mjs`/`.wasm` pair, ~24MB) into the
  binary and the route serves them from there. `YAAR_ML_RUNTIME_DIR` overrides both.
  If you change `ORT_URL` or the backend in the shim, update `ML_RUNTIME_ARTIFACTS`
  in the build script to match — it fails the build rather than shipping a binary
  whose ML route 404s.
- **Weights.** Deployed apps run under CSP `connect-src 'self'`, so the SDK
  fetches weights through the same-origin **streaming** proxy `/api/ml-weights?url=…`
  instead of hitting the model host cross-origin. The proxy enforces SSRF
  protection + the `curl_allowed_domains.yaml` allowlist and streams the body
  through (no base64 double-buffering of hundreds of MB). The result is cached
  in IndexedDB keyed by URL (HuggingFace `resolve` URLs are revision-pinned, so
  they're treated as immutable — pass `force: true` to refresh).
- **Single-thread.** YAAR iframes are not cross-origin isolated (no COOP/COEP),
  so `SharedArrayBuffer` — and thus multithreaded wasm — is unavailable. The SDK
  pins `numThreads = 1`. The **WebGPU** execution provider does not need threads,
  so the primary path is unaffected; single-thread wasm is only the fallback.

## Capabilities & limits — "what fits"

Tier 1 is bounded by two ceilings:

1. **GPU buffer limits.** `capabilities().maxStorageBufferBindingSize` is the
   hard per-tensor ceiling (often ~128 MB–2 GB depending on the GPU). A single
   weight/activation buffer larger than this cannot be allocated. If a model
   exceeds it, `session()` throws a friendly *"this model is too big for your
   GPU"* error rather than a silent OOM. Mitigation: pick a smaller or more
   heavily quantized model, or shard weights.
2. **Tab memory.** The whole model + activations must fit the tab's budget.
   Low-end GPUs and mobile fall over well before desktop.

**Known-good targets** (download → cache → WebGPU → output):

- Embedders / semantic search (e.g. all-MiniLM, int8) — tens of MB.
- Image classifiers (MobileNet/ResNet ONNX) — tens of MB.
- Small speech (whisper-tiny/base) — on-device transcription.
- Background removal (U²-Net / MODNet).
- Small diffusion (SD-Turbo int8) — the plan's pipeline-validation target.

Prefer **int8 weights / f16 compute**. Check `capabilities().f16` before relying
on half-precision; not every adapter exposes `shader-f16`.

## First-load UX

The first run downloads 10s–100s of MB. Always wire `onProgress` to a real
progress bar; subsequent loads are served from IndexedDB (offline-capable). The
IndexedDB cache self-evicts oldest-first past a ~4 GB budget.

## Gotchas

- **Feature-detect first.** Call `capabilities()` and degrade gracefully when
  `webgpu` is false — `backend: 'auto'` already falls back to wasm, but wasm is
  much slower, so tell the user.
- **Allowlist.** If `allow_all_domains` is off, add the model host to
  `config/curl_allowed_domains.yaml` or the weights download returns 403.
- **Bundle size.** onnxruntime-web's JS glue adds ~400 KB to a compiled app; the
  `.wasm` artifacts (13–27 MB) are served once from `/api/ml-runtime/` and cached
  by the browser.

## Server / config knobs

- `YAAR_ML_RUNTIME_DIR` — override where the ORT `.wasm`/`.mjs` artifacts are
  served from (defaults to the installed package's `dist/`, or `./ml-runtime/`
  next to a bundled exe).
