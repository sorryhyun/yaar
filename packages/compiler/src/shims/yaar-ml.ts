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

/**
 * Put the REMOTE-mode token on a same-origin URL that ORT will fetch *itself*.
 *
 * This is the same shape as the /api/ml-runtime/ bug, one hop further on. In REMOTE
 * mode — which every bundled exe is (`IS_REMOTE = REMOTE === '1' || IS_BUNDLED_EXE`)
 * — `/api/storage/*` demands the remote token, and an app's own `fetch` only passes
 * because the browser sends the iframe's URL (which carries `?token=`) as `Referer`.
 * Nothing ORT fetches gets that Referer: `env.wasm.proxy` above moves session
 * creation onto a worker spawned from the *ORT script*, so an `externalData` URL is
 * fetched with `/api/ml-runtime/ort…mjs` as its Referer — no token — and 401s.
 *
 * The app never sees it coming: it resolves the URL with a `fetch` of its own (main
 * thread, Referer carries the token → 200), so the file demonstrably exists, and then
 * ORT reports it as unloadable. Installed builds only; dev has no gate to fail.
 *
 * The URL is the only channel ORT leaves open — there is no hook to add a header to
 * these requests — so the token rides in the query string, exactly as `resolveAssetUrl`
 * does for the iframe URL itself. Only same-origin URLs are touched: this token is
 * YAAR's, and must not leak to another host.
 */
function authorizeOrtUrl(u: string): string {
  let token: string | null = null;
  try {
    token = new URLSearchParams(location.search).get('token');
  } catch {
    return u;
  }
  if (!token) return u; // not REMOTE, or no token to carry — nothing to add
  try {
    const url = new URL(u, location.href);
    if (url.origin !== location.origin) return u;
    if (!url.searchParams.has('token')) url.searchParams.set('token', token);
    return url.href;
  } catch {
    return u;
  }
}

/**
 * Rewrite the `externalData` URLs ORT fetches itself so they carry the token.
 *
 * Only a string `data` is a URL — `Blob`/`Uint8Array` are bytes the app already
 * loaded on a thread whose Referer worked. The bare-string entry form
 * (`externalData: ['weights.data']`) is deliberately left alone: there the one string
 * is both the fetch URL *and* the `location` recorded in the `.onnx`, so appending a
 * query would break the match that binds the sidecar to the graph. The object form
 * ({@link ort.InferenceSession.SessionOptions.externalData}'s `{ path, data }`) keeps
 * the two separate, which is why it is the form that can be fixed.
 */
function authorizeExternalData(
  extra?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = extra?.externalData;
  if (!Array.isArray(entries)) return extra;
  return {
    ...extra,
    externalData: entries.map((e) => {
      const data = (e as { data?: unknown } | null)?.data;
      return e && typeof e === 'object' && typeof data === 'string'
        ? { ...e, data: authorizeOrtUrl(data) }
        : e;
    }),
  };
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

/** One remote weight file and the storage path it should land at. */
export interface WeightFile {
  /** Remote URL to pull from (HuggingFace `resolve/…`, a CDN, …). */
  url: string;
  /**
   * Storage-relative destination, e.g. `apps/self/weights/model.onnx`.
   * `apps/self/` resolves to the calling app's own storage directory.
   */
  dest: string;
  /** Expected size, for the progress bar before the server reports a real total. */
  bytes?: number;
}

export interface PrefetchProgress {
  /** The file currently transferring. */
  file: WeightFile;
  /** 1-based index of that file within the set. */
  index: number;
  /** Number of files in the set. */
  count: number;
  /** Bytes of the current file. */
  loaded: number;
  total: number;
  /** Bytes across the whole set (uses `bytes` hints for files not yet started). */
  overallLoaded: number;
  overallTotal: number;
}

export interface PrefetchOptions {
  onProgress?: (p: PrefetchProgress) => void;
  signal?: AbortSignal;
  /** How often to poll the server for progress. Default 500 ms. */
  pollIntervalMs?: number;
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
 * Is this a URL the browser can fetch itself, with no proxy in between?
 *
 * A weight file already pulled to disk by {@link prefetchWeights} is read back off
 * `/api/storage/…` — same-origin, already inside the CSP, and served straight from
 * disk by `Bun.file`. Sending it through `/api/ml-weights?url=…` instead would fail
 * outright: that proxy runs the SSRF guard, which rejects a relative URL and blocks
 * the loopback address an absolute one would name.
 */
function isLocalWeightUrl(url: string): boolean {
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Download model weights as an ArrayBuffer, cached in IndexedDB by URL.
 *
 * The fetch goes through YAAR's same-origin streaming proxy so it satisfies the
 * app CSP and streams (real progress, no base64 blow-up). HuggingFace `resolve`
 * URLs are revision-pinned and treated as immutable — pass `force: true` to
 * bypass the cache.
 *
 * A same-origin URL (a file already on disk via {@link prefetchWeights}) is read
 * directly and *not* mirrored into IndexedDB: it is already local, and a second
 * copy of a multi-GB weight file is pure waste.
 */
export async function fetchWeights(
  url: string,
  opts: FetchWeightsOptions = {},
): Promise<ArrayBuffer> {
  const local = isLocalWeightUrl(url);

  if (!local && !opts.force) {
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

  const target = local ? url : '/api/ml-weights?url=' + encodeURIComponent(url);
  const res = await fetch(target, { signal: opts.signal, headers: mlHeaders() });
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
    if (!local) await cachePut(url, buf, etag);
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
  if (!local) await cachePut(url, buf, etag);
  return buf;
}

// ── Prefetch to disk ─────────────────────────────────────────────────────────
//
// The IndexedDB cache above is the right default — one call, no server state — but
// it is the *browser's* cache: clearing site data drops it, quota pressure evicts it,
// and nothing there survives to another tab's first paint. An app that ships a 77 MB
// recognizer, or a multi-GB diffusion model, wants the bytes on disk instead: pulled
// once, offline afterwards, and read back same-origin off /api/storage.
//
// The browser cannot write those files — `POST /api/storage/{path}` buffers the whole
// body under MAX_UPLOAD_SIZE — so the *server* streams remote → disk over parallel
// Range requests (resuming a partial `.part`), and the app polls for progress.

/** The storage URL a prefetched file is read back from. Feed it to `session()`. */
export function weightUrl(dest: string): string {
  return '/api/storage/' + dest.split('/').map(encodeURIComponent).join('/');
}

interface JobStatus {
  state: 'idle' | 'downloading' | 'done' | 'error';
  loaded: number;
  total: number;
  error?: string;
}

/** Untrusted JSON off the wire — read only the fields we use, with sane fallbacks. */
function asJobStatus(raw: unknown): JobStatus {
  const o = (raw ?? {}) as Record<string, unknown>;
  const state = o.state;
  return {
    state:
      state === 'downloading' || state === 'done' || state === 'error' || state === 'idle'
        ? state
        : 'error',
    loaded: typeof o.loaded === 'number' ? o.loaded : 0,
    total: typeof o.total === 'number' ? o.total : 0,
    error: typeof o.error === 'string' ? o.error : undefined,
  };
}

async function downloadJson(input: string, init: RequestInit): Promise<JobStatus> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Weight download failed (${res.status}): ${detail || res.statusText}`);
  }
  return asJobStatus(await res.json());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pull weight files to this machine's storage, one at a time, and return the
 * same-origin URLs to read them back from.
 *
 * Files already on disk complete instantly, so this is safe to call on every boot —
 * it is the "make sure the model is here" step, not a one-shot installer. Each file
 * is fetched server-side over parallel Range requests and resumed from a partial
 * `.part`, so an interrupted multi-GB download picks up where it stopped.
 *
 * ```ts
 * const [modelUrl] = await prefetchWeights(
 *   [{ url: `${HF}/model.onnx`, dest: 'apps/self/weights/model.onnx', bytes: 77_000_000 }],
 *   { onProgress: (p) => setStatus(`${p.file.dest} ${(p.overallLoaded / p.overallTotal * 100) | 0}%`) },
 * );
 * const s = await session(modelUrl);   // reads off disk, no IndexedDB copy
 * ```
 */
export async function prefetchWeights(
  files: WeightFile[],
  opts: PrefetchOptions = {},
): Promise<string[]> {
  const pollMs = opts.pollIntervalMs ?? 500;
  const overallTotal = files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  let done = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const emit = (s: JobStatus) =>
      opts.onProgress?.({
        file,
        index: i + 1,
        count: files.length,
        loaded: s.loaded,
        total: s.total || (file.bytes ?? 0),
        overallLoaded: done + s.loaded,
        overallTotal,
      });

    let status = await downloadJson('/api/ml-weights/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...mlHeaders() },
      body: JSON.stringify({ url: file.url, dest: file.dest }),
      signal: opts.signal,
    });
    emit(status);

    const statusUrl = '/api/ml-weights/download?dest=' + encodeURIComponent(file.dest);
    while (status.state === 'downloading') {
      await sleep(pollMs, opts.signal);
      status = await downloadJson(statusUrl, { headers: mlHeaders(), signal: opts.signal });
      emit(status);
    }
    if (status.state === 'error') {
      throw new Error(`${file.dest}: ${status.error ?? 'download failed'}`);
    }
    done += status.loaded || file.bytes || 0;
  }

  return files.map((f) => weightUrl(f.dest));
}

// ── Inference sessions ───────────────────────────────────────────────────────

/**
 * Live sessions, keyed by url+backend+options.
 *
 * The model URL is kept as its own field rather than parsed back out of the key:
 * the key also carries a JSON blob of session options, which can contain the
 * delimiter, so a key that round-trips is not a key that can be split.
 */
interface MemoizedSession {
  url: string;
  promise: Promise<ort.InferenceSession>;
}

const _sessions = new Map<string, MemoizedSession>();

async function resolveProviders(backend: Backend): Promise<string[]> {
  if (backend === 'wasm') return ['wasm'];
  if (backend === 'webgpu') return ['webgpu'];
  const caps = await capabilities();
  return caps.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
}

function looksLikeMemoryError(err: unknown): boolean {
  // Strip URLs before matching. ORT names the failing URL in its message, and YAAR
  // serves weights from `/api/storage/…` — which matched `storage` below and reported
  // a plain 401 on the sidecar as "This model is too big for your GPU (max single
  // buffer ~2047 MB)". Every word of that was wrong, and it sent people hunting for a
  // smaller model to fix an auth failure. A URL describes *what* was being loaded, and
  // is never evidence of *why* it failed.
  const msg = String((err as Error)?.message ?? err ?? '').replace(/\bhttps?:\/\/\S+/gi, '');
  return /buffer|storage|size|memory|out of memory|oom|exceed/i.test(msg);
}

async function createSession(
  bytes: Uint8Array,
  backend: Backend,
  rawExtra?: Record<string, unknown>,
): Promise<ort.InferenceSession> {
  const providers = await resolveProviders(backend);
  // ORT fetches these URLs from its own worker, where the Referer carries no token.
  const extra = authorizeExternalData(rawExtra);
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
    if (existing) return existing.promise;
    const promise = (async () => {
      const buf = await fetchWeights(model, { onProgress: opts.onProgress, signal: opts.signal });
      return createSession(new Uint8Array(buf), backend, opts.sessionOptions);
    })();
    // Drop the memo if creation fails so a retry can start clean.
    promise.catch(() => _sessions.delete(key));
    _sessions.set(key, { url: model, promise });
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
  for (const [key, entry] of [..._sessions]) {
    if ((await entry.promise.catch(() => null)) === s) _sessions.delete(key);
  }
  await s.release?.();
}

/**
 * Release every memoized session whose model URL matches, freeing GPU memory.
 *
 * ORT does *not* free native/GPU memory when a session is garbage-collected — only
 * an explicit release does — and {@link session} memoizes by URL with no way to drop
 * an entry. Reaching for `dispose()` alone is the trap: it frees the native side and
 * leaves the dead session in the memo, so the next `session(sameUrl)` hands back a
 * released handle. This is the supported way to swap model sizes, or to drop a
 * detector before loading a bigger recognizer.
 *
 * ```ts
 * await releaseSessions((url) => url.includes('_det_'));   // free the detector
 * await releaseSessions(() => true);                       // free everything
 * ```
 *
 * Sessions created from raw bytes are never memoized — release those with
 * {@link dispose}.
 */
export async function releaseSessions(match: (url: string) => boolean): Promise<void> {
  for (const [key, entry] of [..._sessions]) {
    if (!match(entry.url)) continue;
    _sessions.delete(key);
    const s = await entry.promise.catch(() => null);
    if (s) await s.release?.();
  }
}

// ── Re-exports ───────────────────────────────────────────────────────────────

/** onnxruntime-web Tensor constructor — build model inputs with `new Tensor(...)`. */
export const Tensor = ort.Tensor;
/** onnxruntime-web env (advanced tuning: `env.wasm`, `env.webgpu`, `env.logLevel`). */
export const env = ort.env;
/** The raw onnxruntime-web namespace, for APIs not surfaced above. */
export { ort };
