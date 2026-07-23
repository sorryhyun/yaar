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
| `fetchWeights(url, opts?)` | Download weights as an `ArrayBuffer`, IndexedDB-cached by URL, streamed with `opts.onProgress`. `opts.force` re-downloads. A same-origin URL is read directly and not mirrored into IndexedDB. |
| `prefetchWeights(files, opts?)` | Stream weight files to **disk** server-side (resumable), returning the same-origin URLs to read them back from. See [Prefetch to disk](#prefetch-to-disk). |
| `weightUrl(dest)` | The `/api/storage/…` URL a prefetched `dest` is read back from. |
| `clearCache(url?)` | Evict one cached weight file, or the whole cache. |
| `dispose(session)` | Release a session's native resources. |
| `releaseSessions(match)` | Release **and un-memoize** every session whose model URL matches. The correct way to free GPU memory — see [Swapping models](#swapping-models). |
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

## Prefetch to disk

The IndexedDB cache is the right default: one call, no server state, nothing to
clean up. But it is the *browser's* cache — clearing site data drops it, quota
pressure evicts it, and nothing in it survives to another tab's first paint. For a
model you want to pull once and keep, `prefetchWeights` streams it to this
machine's storage instead:

```typescript
import { prefetchWeights, session } from '@bundled/yaar-ml';

const [modelUrl] = await prefetchWeights(
  [{ url: `${HF}/model.onnx`, dest: 'apps/self/weights/model.onnx', bytes: 77_000_000 }],
  { onProgress: (p) => setStatus(`${((p.overallLoaded / p.overallTotal) * 100) | 0}%`) },
);

const s = await session(modelUrl); // reads off disk, no second copy in IndexedDB
```

- The browser never touches the bytes. `POST /api/storage/{path}` buffers the whole
  body under `MAX_UPLOAD_SIZE` (50 MB), so the *server* streams remote → disk over
  parallel Range requests and the SDK polls for progress.
- **Resumable.** An interrupted transfer leaves a `.part` and picks up where it
  stopped. Files already on disk complete instantly, so calling this on every boot
  is the intended usage — it is "make sure the model is here", not an installer.
- `dest` is storage-relative and `apps/self/` resolves to your app's own directory.
  The destination is permission-checked like any other storage write, so an app can
  only prefetch into somewhere it may already write.
- Offline afterwards: the read-back URL is same-origin and served straight from
  disk, so `session()` never touches the network again.

## Swapping models

`session()` memoizes by URL, and **ORT does not free native/GPU memory when a
session is garbage-collected** — only an explicit release does. Those two facts
combine into a trap: `dispose(s)` frees the native side but the memo is keyed by
URL, so a later `session(sameUrl)` can hand back a released handle. Use
`releaseSessions` instead, which does both:

```typescript
await releaseSessions((url) => url.includes('_det_')); // drop the detector
await releaseSessions(() => true);                     // drop everything
```

This is what an app holding two models — a detector and a recognizer, a small and a
large variant — needs before loading the next one. Sessions created from raw bytes
are never memoized; release those with `dispose`.

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
- OCR (PP-OCRv6 recognizer, 77 MB) — ~30 ms/line on WebGPU, exact on 13–15px
  dark-theme UI text. See the bundled `ocr` app.

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

- **Snap dynamic dimensions to a handful of buckets.** The WebGPU execution
  provider compiles its kernels **per concrete input shape**. Any model with a
  dynamic dimension — which is most sequence and vision models — turns a one-time
  compile into a per-call one if you feed it arbitrary shapes. Pick a small fixed
  set and pad up to the nearest:

  ```typescript
  const BUCKETS = [160, 320, 480, 640, 960, 1280, 1920, 2400];
  const width = BUCKETS.find((b) => b >= needed) ?? BUCKETS.at(-1)!;
  ```

  A 40-line page recognized one line at a time at 40 distinct widths pays 40
  compiles; bucketed, it pays at most 8, once. Buckets also make **batching**
  possible — a dynamic batch dimension lets every crop in one bucket go through in
  a single `run` — which is usually the larger win of the two.

- **Assert the model's output shape against whatever table you index with it.**
  Any app pairing weights with a vocabulary, label set, or class list has one
  failure mode that produces *output* rather than an error: the wrong table. A
  character-level check is one line and catches it on the first run:

  ```typescript
  const vocabSize = session.outputMetadata /* … */ ?? logits.dims.at(-1)!;
  if (vocabSize !== charset.length + 1) {
    throw new Error(`Model expects a ${vocabSize - 1}-char dictionary, got ${charset.length}`);
  }
  ```

  This is not hypothetical: PP-OCRv6's `tiny` recognizer ships a 6,904-character
  dictionary where `medium`/`small` ship 18,708. Mispaired, it decodes to
  confident, fluent nonsense — the check caught it on the first run of the OCR app.

## Server / config knobs

- `YAAR_ML_RUNTIME_DIR` — override where the ORT `.wasm`/`.mjs` artifacts are
  served from (defaults to the installed package's `dist/`, or `./ml-runtime/`
  next to a bundled exe).
