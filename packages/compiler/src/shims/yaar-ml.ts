// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-ml.
 *
 * Run a model *inside the app iframe* — no Python, no install — via
 * onnxruntime-web (WebGPU execution provider with a single-thread wasm
 * fallback). Requires "yaar-ml" in app.json bundles field to import.
 *
 * Usage:
 *   import { session, run, Tensor, capabilities } from '@bundled/yaar-ml';
 *   const caps = await capabilities();               // { webgpu, f16, ... }
 *   const s = await session('https://.../model.onnx', {
 *     backend: 'auto',
 *     onProgress: (p) => console.log((p.ratio * 100) | 0, '%'),
 *   });
 *   const out = await run(s, { input: new Tensor('float32', data, [1, 3, 224, 224]) });
 *
 * Model weights are fetched through YAAR's same-origin streaming proxy
 * (`/api/ml-weights`) so they satisfy the app CSP (`connect-src 'self'`) and
 * are not double-buffered as base64. First download is cached in IndexedDB.
 * The ORT `.wasm` runtime artifacts are served from `/api/ml-runtime/`.
 */

// The `/webgpu` flavor is the NEW native (Dawn-based) WebGPU EP compiled into the
// asyncify wasm artifact. The package default ('.') is the older JSEP WebGPU EP,
// whose buffer allocator miscomputes fp16 graphs with single-consumer alias views
// (measured: adaLN Split→Unsqueeze→broadcast in the anima DiT comes back ~10× too
// large per block → residual overflow → all-NaN). The native EP does not share
// that allocator. Both flavors load their artifacts from /api/ml-runtime/.
//
// ORT is imported at RUNTIME from its own same-origin URL, not bundled into the
// app — see `ORT_URL` below. The type-only import is erased, so no copy of ORT
// ends up in the app bundle.
import type * as Ort from 'onnxruntime-web/webgpu';

/**
 * ORT must be a real script at a real URL, because `env.wasm.proxy` needs one.
 *
 * In proxy mode ORT runs the session on a worker it spawns from *its own script
 * source URL* (`import.meta.url`) — the bundle re-enters itself as
 * `ort-wasm-proxy-worker`. The compiler inlines the app into a
 * `<script type="module">` inside its HTML, so a bundled-in ORT sees
 * `import.meta.url` = the app's HTML page, and `new Worker(<that>, {type:'module'})`
 * would try to parse HTML as a module and fail. Loading ORT from
 * `/api/ml-runtime/` (the same route that already serves its `.wasm`, and which
 * serves `.mjs` as `application/javascript`) gives it a script URL it can spawn
 * itself from, and lets `wasmPaths` resolve alongside it.
 */
const ORT_URL = '/api/ml-runtime/ort.webgpu.bundle.min.mjs';

// The specifier has to be opaque to Bun's bundler: a literal `import(ORT_URL)`
// gets resolved at build time (and fails — it's a server route, not a module on
// disk). Going through `Function` keeps it a runtime import. No CSP problem: app
// iframes are served with `connect-src 'self'` only, no `script-src`.
const importModule = new Function('u', 'return import(u)') as (u: string) => Promise<typeof Ort>;

const ort = await importModule(ORT_URL);

/**
 * The app's iframe token, for the weight routes.
 *
 * `/api/ml-weights*` proxies an arbitrary URL and streams it to disk, so it is gated
 * on the app having declared `"bundles": ["yaar-ml"]` — the same declaration that let
 * this SDK be bundled in the first place. The token is what carries that declaration
 * to the server. `/api/ml-runtime/` needs none: ORT loads those artifacts itself and
 * they are inert.
 */
function mlHeaders(): Record<string, string> {
  const token = (window as unknown as { __YAAR_TOKEN__?: string }).__YAAR_TOKEN__;
  return token ? { 'X-Iframe-Token': token } : {};
}

// ── Runtime configuration (runs once on import) ──────────────────────────────

// ORT loads its `.wasm` binaries at runtime from this same-origin static route
// (served by the server from onnxruntime-web/dist). Must be set before any
// session is created.
ort.env.wasm.wasmPaths = '/api/ml-runtime/';
// YAAR iframes are not cross-origin isolated (no COOP/COEP) → SharedArrayBuffer
// is unavailable, so multithreaded wasm cannot run. Pin to a single thread; the
// WebGPU EP does not need threads anyway.
ort.env.wasm.numThreads = 1;
// Run the session on a worker instead of the calling thread.
//
// This is not a nicety, it is what keeps the desktop alive. App iframes are
// same-origin and unsandboxed, so an app shares the event loop with the whole
// YAAR UI. `InferenceSession.create` is one long *synchronous* wasm call —
// graph parse, external-data copy into the wasm heap, weight upload to the GPU —
// and awaiting it does not yield, because there is nothing to yield to. Loading
// a multi-GB model on this thread freezes the taskbar, the palette, and every
// other window for as long as it takes. On a worker, the main thread only ever
// waits on a postMessage.
//
// Two things proxy mode does not support, both of which the SDK stays clear of:
// `preferredOutputLocation` (session option) and GPU-resident input tensors.
ort.env.wasm.proxy = true;

// ── Types ────────────────────────────────────────────────────────────────────

export type Backend = 'webgpu' | 'wasm' | 'auto';

export interface MlCapabilities {
  /** WebGPU adapter available in this tab. */
  webgpu: boolean;
  /** Adapter supports the `shader-f16` feature (half-precision compute). */
  f16: boolean;
  /** `GPUSupportedLimits.maxBufferSize` in bytes (0 when no WebGPU). */
  maxBufferSize: number;
  /** `GPUSupportedLimits.maxStorageBufferBindingSize` — the practical per-tensor ceiling. */
  maxStorageBufferBindingSize: number;
  /** Rough usable budget for a single model on the GPU, in bytes. */
  estMemoryBudget: number;
  /** Human-readable adapter description, when the browser exposes it. */
  adapter?: string;
}

export interface DownloadProgress {
  /** Bytes downloaded so far. */
  loaded: number;
  /** Total bytes (0 when the server did not report a Content-Length). */
  total: number;
  /** loaded/total in [0, 1] (0 when total is unknown). */
  ratio: number;
  /** True once the payload came from the IndexedDB cache (no network). */
  cached?: boolean;
}

export interface FetchWeightsOptions {
  onProgress?: (p: DownloadProgress) => void;
  /** Re-download and overwrite the cached copy. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface SessionOptions {
  backend?: Backend;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Passed straight through to `InferenceSession.create` (graph/opt flags, etc.). */
  sessionOptions?: Record<string, unknown>;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

const NO_WEBGPU: MlCapabilities = {
  webgpu: false,
  f16: false,
  maxBufferSize: 0,
  maxStorageBufferBindingSize: 0,
  estMemoryBudget: 0,
};

let _capsPromise: Promise<MlCapabilities> | undefined;

/**
 * Detect the tab's ML capabilities. Cached after the first call.
 * Never throws — returns `webgpu: false` when WebGPU is unavailable.
 */
export function capabilities(): Promise<MlCapabilities> {
  if (_capsPromise) return _capsPromise;
  _capsPromise = (async () => {
    const gpu = (navigator as any).gpu;
    if (!gpu) return NO_WEBGPU;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return NO_WEBGPU;
      const f16 = adapter.features?.has?.('shader-f16') ?? false;
      const limits = adapter.limits ?? {};
      const maxBufferSize = Number(limits.maxBufferSize ?? 0);
      const maxStorageBufferBindingSize = Number(limits.maxStorageBufferBindingSize ?? 0);
      let adapterName: string | undefined;
      try {
        const info =
          adapter.info ??
          (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : undefined);
        if (info) {
          adapterName =
            [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') ||
            undefined;
        }
      } catch {
        /* adapter info is best-effort */
      }
      return {
        webgpu: true,
        f16,
        maxBufferSize,
        // A single storage buffer is the hard per-tensor ceiling; use it as a
        // conservative single-model budget for "will it fit" checks.
        maxStorageBufferBindingSize,
        estMemoryBudget: maxStorageBufferBindingSize,
        adapter: adapterName,
      };
    } catch {
      return NO_WEBGPU;
    }
  })();
  return _capsPromise;
}

// ── IndexedDB weight cache ───────────────────────────────────────────────────

const DB_NAME = 'yaar-ml';
const DB_VERSION = 1;
const STORE = 'weights';
/** Evict oldest entries once the cache exceeds this many bytes. */
const CACHE_BUDGET_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

interface CacheRecord {
  url: string;
  etag?: string;
  savedAt: number;
  size: number;
  data: ArrayBuffer;
}

let _dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'url' });
          store.createIndex('savedAt', 'savedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(url: string): Promise<CacheRecord | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const rec = await idbRequest<CacheRecord | undefined>(tx.objectStore(STORE).get(url));
    return rec ?? null;
  } catch {
    return null;
  }
}

async function cachePut(url: string, data: ArrayBuffer, etag?: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const record: CacheRecord = { url, etag, savedAt: Date.now(), size: data.byteLength, data };
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await idbRequest(tx.objectStore(STORE).put(record));
  } catch {
    /* best-effort; a full quota just means no cache */
  }
  // Enforce the budget lazily, after the write.
  void evictIfNeeded().catch(() => {});
}

async function evictIfNeeded(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const all = await idbRequest<CacheRecord[]>(store.getAll());
  let total = all.reduce((n, r) => n + (r.size || 0), 0);
  if (total <= CACHE_BUDGET_BYTES) return;
  // Oldest first.
  all.sort((a, b) => a.savedAt - b.savedAt);
  for (const r of all) {
    if (total <= CACHE_BUDGET_BYTES) break;
    store.delete(r.url);
    total -= r.size || 0;
  }
}

/** Remove one cached weight file, or the entire cache when no URL is given. */
export async function clearCache(url?: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(STORE, 'readwrite');
  await idbRequest(url ? tx.objectStore(STORE).delete(url) : tx.objectStore(STORE).clear());
}

// ── Weight fetching ──────────────────────────────────────────────────────────

function concatChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/**
 * Download model weights as an ArrayBuffer, cached in IndexedDB by URL.
 *
 * The fetch goes through YAAR's same-origin streaming proxy so it satisfies the
 * app CSP and streams (real progress, no base64 blow-up). HuggingFace `resolve`
 * URLs are revision-pinned and treated as immutable — pass `force: true` to
 * bypass the cache.
 */
export async function fetchWeights(
  url: string,
  opts: FetchWeightsOptions = {},
): Promise<ArrayBuffer> {
  if (!opts.force) {
    const cached = await cacheGet(url);
    if (cached) {
      opts.onProgress?.({
        loaded: cached.size,
        total: cached.size,
        ratio: 1,
        cached: true,
      });
      return cached.data;
    }
  }

  const proxied = '/api/ml-weights?url=' + encodeURIComponent(url);
  const res = await fetch(proxied, { signal: opts.signal, headers: mlHeaders() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to download weights (${res.status}): ${detail || res.statusText}`);
  }

  const total = Number(res.headers.get('content-length') || 0);
  const etag = res.headers.get('etag') || undefined;

  if (!res.body) {
    // No streamable body — fall back to a single buffered read.
    const buf = await res.arrayBuffer();
    opts.onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, ratio: 1 });
    await cachePut(url, buf, etag);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    opts.onProgress?.({ loaded, total, ratio: total ? loaded / total : 0 });
  }

  const buf = concatChunks(chunks, loaded);
  await cachePut(url, buf, etag);
  return buf;
}

// ── Inference sessions ───────────────────────────────────────────────────────

const _sessions = new Map<string, Promise<ort.InferenceSession>>();

async function resolveProviders(backend: Backend): Promise<string[]> {
  if (backend === 'wasm') return ['wasm'];
  if (backend === 'webgpu') return ['webgpu'];
  const caps = await capabilities();
  return caps.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
}

function looksLikeMemoryError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '');
  return /buffer|storage|size|memory|out of memory|oom|exceed/i.test(msg);
}

async function createSession(
  bytes: Uint8Array,
  backend: Backend,
  extra?: Record<string, unknown>,
): Promise<ort.InferenceSession> {
  const providers = await resolveProviders(backend);
  // `create` transfers the model buffer to the worker in proxy mode, which detaches
  // it here — so each attempt needs its own copy, or the wasm fallback below would
  // hand ORT an empty model. The graph proto is small (weights ride in externalData).
  const modelBytes = () => (ort.env.wasm.proxy ? bytes.slice() : bytes);
  try {
    return await ort.InferenceSession.create(modelBytes(), {
      executionProviders: providers,
      ...extra,
    });
  } catch (err) {
    if (providers.includes('webgpu')) {
      const caps = await capabilities();
      if (looksLikeMemoryError(err)) {
        const ceil = caps.maxStorageBufferBindingSize
          ? `${Math.floor(caps.maxStorageBufferBindingSize / (1024 * 1024))} MB`
          : 'unknown';
        throw new Error(
          `This model is too big for your GPU (max single buffer ≈ ${ceil}). ` +
            `Try a smaller or more heavily quantized model, or backend: 'wasm'. ` +
            `(original error: ${String((err as Error)?.message ?? err)})`,
        );
      }
      // Auto mode: fall back to the CPU wasm backend on any WebGPU failure.
      if (backend === 'auto') {
        return ort.InferenceSession.create(modelBytes(), {
          executionProviders: ['wasm'],
          ...extra,
        });
      }
    }
    throw err;
  }
}

/**
 * Create (or return a cached) InferenceSession from a model URL or raw bytes.
 *
 * When `model` is a URL, the resulting session is memoized per URL+backend, so
 * repeated calls are cheap. Weights download through {@link fetchWeights}
 * (IndexedDB-cached). WebGPU is preferred in `auto` mode and falls back to wasm.
 */
export async function session(
  model: string | ArrayBuffer | Uint8Array,
  opts: SessionOptions = {},
): Promise<ort.InferenceSession> {
  const backend = opts.backend ?? 'auto';

  if (typeof model === 'string') {
    // Include sessionOptions so a call with different options doesn't get a stale session
    const optsKey = opts.sessionOptions ? JSON.stringify(opts.sessionOptions) : '';
    const key = `${model}::${backend}::${optsKey}`;
    const existing = _sessions.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const buf = await fetchWeights(model, { onProgress: opts.onProgress, signal: opts.signal });
      return createSession(new Uint8Array(buf), backend, opts.sessionOptions);
    })();
    // Drop the memo if creation fails so a retry can start clean.
    promise.catch(() => _sessions.delete(key));
    _sessions.set(key, promise);
    return promise;
  }

  const bytes = model instanceof Uint8Array ? model : new Uint8Array(model);
  return createSession(bytes, backend, opts.sessionOptions);
}

/**
 * Feed the worker its own copy of each input.
 *
 * In proxy mode ORT posts the inputs with their buffers in the *transfer* list, so
 * `run` detaches every array the caller passed in: a second `run` over the same
 * Float32Array sees `length 0` and the Tensor constructor rejects it
 * ("size(65536) does not match data length(0)"). Callers reasonably expect what
 * non-proxy mode did — that an input survives being run — and reusing a buffer
 * across denoising steps is the normal shape of a diffusion loop. So hand ORT a
 * copy and let it transfer that.
 *
 * The copy costs one memcpy per input per run (a few MB for a diffusion step —
 * noise next to the inference itself). GPU-resident inputs are not copied: proxy
 * mode rejects them outright, and `run` throws before we get here.
 */
function copyFeeds(feeds: Record<string, ort.Tensor>): Record<string, ort.Tensor> {
  const out: Record<string, ort.Tensor> = {};
  for (const [name, t] of Object.entries(feeds)) {
    const data = t.data as { slice?: () => unknown };
    out[name] =
      t.location === 'cpu' && typeof data?.slice === 'function'
        ? new ort.Tensor(t.type, data.slice() as never, t.dims as number[])
        : t;
  }
  return out;
}

/** Run inference. `feeds` maps input names to Tensors; returns the output map. */
export function run(
  s: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>,
  options?: ort.InferenceSession.RunOptions,
): Promise<ort.InferenceSession.OnnxValueMapType> {
  return s.run(ort.env.wasm.proxy ? copyFeeds(feeds) : feeds, options);
}

/** Release a session's native resources. Also clears it from the URL memo. */
export async function dispose(s: ort.InferenceSession): Promise<void> {
  for (const [key, promise] of _sessions) {
    if ((await promise.catch(() => null)) === s) _sessions.delete(key);
  }
  await s.release?.();
}

// ── Re-exports ───────────────────────────────────────────────────────────────

/** onnxruntime-web Tensor constructor — build model inputs with `new Tensor(...)`. */
export const Tensor = ort.Tensor;
/** onnxruntime-web env (advanced tuning: `env.wasm`, `env.webgpu`, `env.logLevel`). */
export const env = ort.env;
/** The raw onnxruntime-web namespace, for APIs not surfaced above. */
export { ort };
