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

// TWO flavors of onnxruntime-web, each covering the other's hole:
//
// - The `/webgpu` flavor is the NEW native (Dawn-based) WebGPU EP compiled into the
//   asyncify wasm artifact. The package default ('.') is the older JSEP WebGPU EP,
//   whose buffer allocator miscomputes fp16 graphs with single-consumer alias views
//   (measured: adaLN Split→Unsqueeze→broadcast in the anima DiT comes back ~10× too
//   large per block → residual overflow → all-NaN). The native EP does not share
//   that allocator.
// - The `/wasm` flavor is the full CPU build, loaded lazily for sessions that
//   resolve to the wasm EP alone — the asyncify artifact's CPU side is REDUCED
//   (see ORT_WASM_URL below).
//
// All flavors load their artifacts from /api/ml-runtime/.
//
// ORT is imported at RUNTIME from its own same-origin URL, not bundled into the
// app — see `ORT_URL` below. The type-only import is erased, so no copy of ORT
// ends up in the app bundle.
import type * as Ort from 'onnxruntime-web/webgpu';

/**
 * The onnxruntime-web version this shim was compiled against, stamped in by the
 * compiler's `define` (`bundled/ort-version.ts`). Empty if the compiler could not
 * resolve ORT.
 */
declare const __YAAR_ORT_VERSION__: string;

/**
 * A `/api/ml-runtime/` URL that changes when ORT does.
 *
 * The route serves these `immutable` for a year under file names that are identical
 * across ORT releases, so without the `?v=` a browser keeps the first ORT it ever
 * fetched — measured: after the 1.27 → 1.30 bump the server served 1.30 and the app
 * still ran the cached 1.27 bundle. The route reads only the pathname, so the query is
 * pure cache key. Every runtime URL goes through here, the `.wasm` included: a new
 * bundle driving a cached old `.wasm` would be worse than a stale pair.
 *
 * Absolute, not root-relative. ORT hands `wasmPaths` to `import()` / `fetch` verbatim,
 * and when it decides its proxy worker must be preloaded (`isSameOrigin(scriptSrc)`
 * false) that worker runs from a `blob:` URL — a base a root-relative specifier cannot
 * resolve against. Measured on an Android phone without WebGPU: `Failed to resolve
 * module specifier '/api/ml-runtime/ort-wasm-simd-threaded.mjs?v=1.30.0'` while the
 * same URL answered 200 (#134). Resolving here, on the iframe's own thread, makes the
 * URL mean the same thing from every context ORT loads it in.
 */
function runtimeUrl(file: string): string {
  const v = typeof __YAAR_ORT_VERSION__ === 'string' ? __YAAR_ORT_VERSION__ : '';
  return new URL(`/api/ml-runtime/${file}${v ? `?v=${encodeURIComponent(v)}` : ''}`, location.href)
    .href;
}

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
const ORT_URL = runtimeUrl('ort.webgpu.bundle.min.mjs');

/**
 * The full-CPU flavor, for sessions that resolve to the wasm EP alone.
 *
 * The native-WebGPU (asyncify) artifact above ships a *reduced* CPU build: its
 * float64 kernels are compiled out, so a graph that computes in f64 — e.g. the
 * transcribe app's nemo128 mel preprocessor, which casts the waveform to double
 * for its STFT — fails session creation with "Could not find an implementation
 * for Cast(13)". Measured on ORT 1.27 and 1.29, so it is a build decision, not a
 * version bug. The `/wasm` flavor is the complete CPU build (13.5 MB vs the
 * default bundle's 27 MB JSEP artifact) and carries no WebGPU EP at all, so the
 * JSEP allocator bug above cannot reach it. Tensors are duck-typed across ORT
 * module instances — a session from this flavor accepts tensors built with the
 * `Tensor` exported from the flavor above (verified: `s.run` reads
 * type/data/dims, never `instanceof`).
 */
const ORT_WASM_URL = runtimeUrl('ort.wasm.bundle.min.mjs');

// The specifier has to be opaque to Bun's bundler: a literal `import(ORT_URL)`
// gets resolved at build time (and fails — it's a server route, not a module on
// disk). Going through `Function` keeps it a runtime import, which the app CSP
// permits: `script-src` names `'unsafe-eval'` for exactly this call and `'self'`
// for the `/api/ml-runtime/` URL it imports (`server/src/http/csp.ts`). Widening
// that directive to a host list without `'unsafe-eval'` would break this line.
const importModule = new Function('u', 'return import(u)') as (u: string) => Promise<typeof Ort>;

const ort = await importModule(ORT_URL);

// The wasm flavor costs a second runtime download, so it loads on first use, not
// on import — a page that only ever runs WebGPU sessions never pays for it.
let _wasmOrt: Promise<typeof Ort> | undefined;
function wasmFlavor(): Promise<typeof Ort> {
  _wasmOrt ??= importModule(ORT_WASM_URL).then((m) => {
    configureOrtEnv(m, 'ort-wasm-simd-threaded');
    return m;
  });
  return _wasmOrt;
}

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
 * Put BOTH of YAAR's credentials on a same-origin URL that ORT will fetch *itself*.
 *
 * This is the same shape as the /api/ml-runtime/ bug, one hop further on. `env.wasm.proxy`
 * above moves session creation onto a worker spawned from the *ORT script*, so every
 * `externalData` URL is fetched from a context that carries neither of the two things a
 * weight route asks for:
 *
 * - **The REMOTE token.** In REMOTE mode (`REMOTE=1`) `/api/storage/*` demands it, and an app's own
 *   `fetch` only passes because the browser sends the iframe's URL (which carries
 *   `?token=`) as `Referer`. ORT's worker fetches with `/api/ml-runtime/ort…mjs` as its
 *   Referer, so it 401s.
 * - **The iframe token.** Under app-origin isolation (`http/origin-boundary.ts`) an
 *   isolated app is a *different browser origin* from the desktop, and `resolvePrincipal`
 *   refuses any app-origin request presenting no token — 403 `App-origin request must
 *   present a valid iframe token`. The app's own `fetch` passes because the prelude puts
 *   `X-Iframe-Token` on it; ORT's worker has no such patch. This one is NOT remote-only:
 *   isolation is on by default locally, which is why `/api/storage/*` and
 *   `/api/ml-weights` both 403 on a plain `make claude-dev` box.
 *
 * The app never sees either coming: it resolves the URL with a `fetch` of its own (main
 * thread, both credentials attached → 200), so the file demonstrably exists and a probe
 * reports `ok:true`, and then ORT reports it as unloadable ~4ms later.
 *
 * The URL is the only channel ORT leaves open — there is no hook to add a header to
 * these requests — so both tokens ride in the query string, exactly as `resolveAssetUrl`
 * does for the iframe URL and `storage-sdk`'s `url()` does for `<img src>`. Only
 * same-origin URLs are touched: these tokens are YAAR's, and must not leak to another host.
 */
function authorizeOrtUrl(u: string): string {
  let remoteToken: string | null = null;
  try {
    remoteToken = new URLSearchParams(location.search).get('token');
  } catch {
    // No readable search — the iframe token below may still apply, so don't bail yet.
  }
  const iframeToken = (window as unknown as { __YAAR_TOKEN__?: string }).__YAAR_TOKEN__ || null;
  if (!remoteToken && !iframeToken) return u; // nothing to carry
  try {
    const url = new URL(u, location.href);
    if (url.origin !== location.origin) return u;
    if (remoteToken && !url.searchParams.has('token')) url.searchParams.set('token', remoteToken);
    if (iframeToken && !url.searchParams.has('__yaar_token'))
      url.searchParams.set('__yaar_token', iframeToken);
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

// ── Runtime configuration (runs once per flavor) ─────────────────────────────

function configureOrtEnv(rt: typeof Ort, artifact: string): void {
  // ORT loads its `.wasm` binaries at runtime from this same-origin static route
  // (served by the server from onnxruntime-web/dist). Must be set before any
  // session is created. The object form rather than a '/api/ml-runtime/' prefix,
  // because a prefix cannot carry the `?v=` (see `runtimeUrl`) — which is also why
  // each flavor names its own artifact pair.
  rt.env.wasm.wasmPaths = {
    mjs: runtimeUrl(`${artifact}.mjs`),
    wasm: runtimeUrl(`${artifact}.wasm`),
  };
  // YAAR iframes are not cross-origin isolated (no COOP/COEP) → SharedArrayBuffer
  // is unavailable, so multithreaded wasm cannot run. Pin to a single thread; the
  // WebGPU EP does not need threads anyway.
  rt.env.wasm.numThreads = 1;
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
  rt.env.wasm.proxy = true;
  // Warnings off; errors still print.
  //
  // The one ORT emits on nearly every session is the EP-partition notice —
  // "Some nodes were not assigned to the preferred execution providers" — which
  // fires whenever the graph does not land 100% on WebGPU. That is the normal
  // case, not a fault: ORT deliberately keeps shape-related ops on CPU because
  // round-tripping them to the GPU costs more than it saves, and the message says
  // so in its own second sentence. An app author can do nothing with it, and every
  // ML app pays it twice per model load, so it trains people to ignore the console
  // that real failures also print to.
  //
  // Nothing actionable is lost. The failures that matter — a GPU too small for the
  // model, an EP that cannot initialize — are thrown, not logged, and
  // `createSession` below translates them into messages aimed at the app author.
  // An app that wants the firehose can reopen it via the exported `env`.
  rt.env.logLevel = 'error';
}

configureOrtEnv(ort, 'ort-wasm-simd-threaded.asyncify');

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
  /**
   * True when sessions run in the server's Chrome rather than this page (see "Remote
   * compute"); the fields above then describe *that* adapter.
   */
  remote?: boolean;
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

// ── Remote compute ───────────────────────────────────────────────────────────
//
// On macOS the desktop is a WKWebView, and WebKit's WebGPU runs the same model markedly
// slower than Chrome on the same GPU (anima's DiT: 3.9 s/step against 2.2 s). So there,
// the server offers to run sessions in a headless Chrome of its own, one tab per app
// page, and this section speaks to it: `createSession` ships the model (and any
// externalData the app holds as bytes), `run` ships feeds and gets outputs back as
// ordinary CPU tensors. The app sees the same API either way. The server decides
// (`YAAR_ML_COMPUTE`, `server/src/features/ml-host/relay.ts`); a decline, an old server,
// or no Chrome all mean "compute here", exactly as before.
//
// Wire format — duplicated in `server/src/features/ml-host/host-page.client.js`, keep the
// two in step:
//
//   frame   = [u8 more][fragment]           more = 1 while further fragments follow
//   message = [u32 LE headerLen][u32 LE 0][header JSON, padded to 8][buf, padded to 8]…

const REMOTE_FRAGMENT = 4 << 20;
/** externalData bytes go up in chunks this size, at most REMOTE_WINDOW unanswered. */
const REMOTE_CHUNK = 4 << 20;
/** 3 × 4 MB stays under the 16 MB Bun buffers per socket before it drops frames. */
const REMOTE_WINDOW = 3;
/** A cold Chrome plus an onnxruntime load; past this the page computes locally. */
const REMOTE_CONNECT_TIMEOUT_MS = 90_000;

const pad8 = (n: number) => (n + 7) & ~7;

function encodeWire(header: Record<string, unknown>, bufs: Uint8Array[]): Uint8Array {
  const h = new TextEncoder().encode(
    JSON.stringify({ ...header, b: bufs.map((b) => b.byteLength) }),
  );
  let total = 8 + pad8(h.byteLength);
  for (const b of bufs) total += pad8(b.byteLength);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, h.byteLength, true);
  out.set(h, 8);
  let o = 8 + pad8(h.byteLength);
  for (const b of bufs) {
    out.set(b, o);
    o += pad8(b.byteLength);
  }
  return out;
}

function decodeWire(bytes: Uint8Array): { header: any; bufs: Uint8Array[] } {
  const hlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
  const bufs: Uint8Array[] = [];
  let o = 8 + pad8(hlen);
  for (const len of header.b ?? []) {
    bufs.push(bytes.subarray(o, o + len));
    o += pad8(len);
  }
  return { header, bufs };
}

/** What ORT itself would build for each type in this realm (`checkTypedArray`). */
function typedArrayFor(type: string): any {
  const map: Record<string, any> = {
    float32: Float32Array,
    float64: Float64Array,
    float16: (globalThis as any).Float16Array ?? Uint16Array,
    int8: Int8Array,
    uint8: Uint8Array,
    int16: Int16Array,
    uint16: Uint16Array,
    int32: Int32Array,
    uint32: Uint32Array,
    int64: BigInt64Array,
    uint64: BigUint64Array,
    bool: Uint8Array,
    int4: Uint8Array,
    uint4: Uint8Array,
  };
  const C = map[type];
  if (!C) throw new Error(`yaar-ml: a ${type} tensor cannot cross to the ML host`);
  return C;
}

/** Which engine this page runs in — the server's `auto` offloads WebKit only. */
function pageEngine(): string {
  const ua = navigator.userAgent;
  if (/(Chrome|Chromium|CriOS|Edg)\//.test(ua)) return 'chromium'; // HeadlessChrome/ too
  if (/AppleWebKit\//.test(ua)) return 'webkit';
  return 'other';
}

/** Round-trip timings, for measuring what the relay costs. `hostMs` is ORT's own run time. */
const remoteStats = {
  runs: 0,
  runMs: 0,
  hostMs: 0,
  upBytes: 0,
  downBytes: 0,
  blobBytes: 0,
  blobMs: 0,
};
(globalThis as any).__yaarMlRemoteStats = remoteStats;

class RemoteChannel {
  caps: MlCapabilities;
  dead: string | null = null;
  private ws: WebSocket;
  private pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  private nextRid = 1;
  private nextId = 1;

  constructor(ws: WebSocket, caps: MlCapabilities) {
    this.ws = ws;
    this.caps = caps;
  }

  newId(): number {
    return this.nextId++;
  }

  onMessage(msg: { header: any; bufs: Uint8Array[] }): void {
    const h = msg.header;
    if (h.op === 'gone') return this.die(h.reason ?? 'the ML host ended');
    const p = this.pending.get(h.rid);
    if (!p) return;
    this.pending.delete(h.rid);
    if (h.error) p.reject(new Error(h.error));
    else p.resolve(msg);
  }

  die(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    for (const p of this.pending.values())
      p.reject(new Error(`yaar-ml: ML host disconnected (${reason})`));
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    // The next session() reconnects — to a fresh tab, or to local compute if the server
    // now declines — and no memo may keep handing out sessions that died with this one.
    if (_remote) _remote = undefined;
    _capsPromise = undefined;
    for (const [key, entry] of [..._sessions]) {
      entry.promise.then(
        (s) => {
          if (s instanceof RemoteSession && s.channel === this) _sessions.delete(key);
        },
        () => {},
      );
    }
  }

  request(
    header: Record<string, unknown>,
    bufs: Uint8Array[] = [],
  ): Promise<{ header: any; bufs: Uint8Array[] }> {
    if (this.dead) return Promise.reject(new Error(`yaar-ml: ML host disconnected (${this.dead})`));
    const rid = this.nextRid++;
    const m = encodeWire({ ...header, rid }, bufs);
    const reply = new Promise<{ header: any; bufs: Uint8Array[] }>((resolve, reject) =>
      this.pending.set(rid, { resolve, reject }),
    );
    // Back to back, no await: fragments of two messages must never interleave.
    for (let o = 0; ; o += REMOTE_FRAGMENT) {
      const end = Math.min(o + REMOTE_FRAGMENT, m.byteLength);
      const f = new Uint8Array(1 + end - o);
      f[0] = end < m.byteLength ? 1 : 0;
      f.set(m.subarray(o, end), 1);
      this.ws.send(f);
      if (end >= m.byteLength) break;
    }
    remoteStats.upBytes += m.byteLength;
    return reply;
  }
}

let _remote: Promise<RemoteChannel | null> | undefined;

function remoteChannel(): Promise<RemoteChannel | null> {
  _remote ??= openRemoteChannel().catch(() => null);
  return _remote;
}

function openRemoteChannel(): Promise<RemoteChannel | null> {
  const token = (window as unknown as { __YAAR_TOKEN__?: string }).__YAAR_TOKEN__;
  if (!token || typeof WebSocket === 'undefined') return Promise.resolve(null);
  const url = new URL('/api/ml-host/connect', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('__yaar_token', token);
  url.searchParams.set('engine', pageEngine());
  const v = typeof __YAAR_ORT_VERSION__ === 'string' ? __YAAR_ORT_VERSION__ : '';
  if (v) url.searchParams.set('v', v);

  return new Promise((resolve) => {
    let channel: RemoteChannel | null = null;
    let settled = false;
    const settle = (c: RemoteChannel | null, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!c && why) console.info(`[yaar-ml] computing in this page: ${why}`);
      resolve(c);
    };
    const ws = new WebSocket(url.href);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      settle(null, 'the ML host did not answer in time');
      ws.close();
    }, REMOTE_CONNECT_TIMEOUT_MS);

    let parts: Uint8Array[] = [];
    let size = 0;
    ws.onmessage = (ev) => {
      const frame = new Uint8Array(ev.data as ArrayBuffer);
      parts.push(frame.subarray(1));
      size += frame.byteLength - 1;
      if (frame[0] === 1) return;
      // A fresh buffer puts the message at offset 0, where the padding aligns every tensor.
      const whole = new Uint8Array(size);
      let o = 0;
      for (const p of parts) {
        whole.set(p, o);
        o += p.byteLength;
      }
      parts = [];
      size = 0;
      remoteStats.downBytes += whole.byteLength;
      const msg = decodeWire(whole);
      if (channel) return channel.onMessage(msg);
      if (msg.header.op === 'ready') {
        channel = new RemoteChannel(ws, { ...msg.header.caps, remote: true });
        console.info(
          `[yaar-ml] computing in the server's Chrome (${msg.header.caps?.adapter ?? 'no adapter name'})`,
        );
        settle(channel);
      } else {
        settle(null, msg.header.reason ?? 'the server declined');
        ws.close();
      }
    };
    ws.onclose = () => {
      if (channel) channel.die('socket closed');
      else settle(null);
    };
    ws.onerror = () => {
      if (!channel) settle(null);
    };
  });
}

/**
 * Host refs whose handle was collected without a dispose(). Sent as one `drop` per
 * tick, so a loop that lets a thousand handles go makes one request, not a thousand.
 */
const _droppedRefs = new Map<RemoteChannel, number[]>();
const _handleGc = new FinalizationRegistry<{ channel: RemoteChannel; ref: number }>(
  ({ channel, ref }) => dropRef(channel, ref),
);

function dropRef(channel: RemoteChannel, ref: number): void {
  if (channel.dead) return;
  const pending = _droppedRefs.get(channel);
  if (pending) {
    pending.push(ref);
    return;
  }
  _droppedRefs.set(channel, [ref]);
  queueMicrotask(() => {
    const refs = _droppedRefs.get(channel) ?? [];
    _droppedRefs.delete(channel);
    if (!channel.dead) channel.request({ op: 'drop', refs }).catch(() => {});
  });
}

/**
 * An output that stayed in the ML host tab (`run(…, { keep })`).
 *
 * What it saves is the round trip: anima's DiT runs as 7 segments per step, and every
 * activation between them came back to this page only to be sent straight out again —
 * ~480 MB and ~2 s per image, measured. A kept output crosses as its id when fed to
 * the next run. It has the part of the Tensor surface that holds whether or not the
 * data is here — `type`, `dims`, `getData()`, `dispose()` — and not `data`, which is
 * why `keep` is opt-in: in this page's own ORT a kept output is an ordinary tensor,
 * and code that reads kept outputs through `getData()` works the same both ways.
 */
class RemoteTensor {
  readonly type: string;
  readonly dims: readonly number[];
  readonly location = 'remote';
  private channel: RemoteChannel;
  private ref: number | null;

  constructor(channel: RemoteChannel, ref: number, type: string, dims: readonly number[]) {
    this.channel = channel;
    this.ref = ref;
    this.type = type;
    this.dims = dims;
    _handleGc.register(this, { channel, ref }, this);
  }

  get size(): number {
    return this.dims.reduce((a, b) => a * b, 1);
  }

  get data(): never {
    throw new Error(
      'yaar-ml: this output was kept in the ML host (run(…, { keep })); read it with `await t.getData()`',
    );
  }

  /** The id to send in place of the bytes, checked against the channel it lives on. */
  refFor(channel: RemoteChannel, name: string): number {
    if (this.ref === null) throw new Error(`yaar-ml: input ${name} was disposed`);
    if (channel !== this.channel || channel.dead) {
      throw new Error(`yaar-ml: input ${name} belongs to an ML host connection that has ended`);
    }
    return this.ref;
  }

  async getData(): Promise<ArrayBufferView> {
    const { bufs } = await this.channel.request({
      op: 'fetch',
      ref: this.refFor(this.channel, 'tensor'),
    });
    const C = typedArrayFor(this.type);
    const b = bufs[0];
    return new C(b.buffer, b.byteOffset, b.byteLength / C.BYTES_PER_ELEMENT);
  }

  dispose(): void {
    if (this.ref === null) return;
    _handleGc.unregister(this);
    dropRef(this.channel, this.ref);
    this.ref = null;
  }
}

/** An InferenceSession whose graph lives in the ML host tab. */
class RemoteSession {
  readonly channel: RemoteChannel;
  readonly sid: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  private released = false;

  constructor(channel: RemoteChannel, sid: number, inputNames: string[], outputNames: string[]) {
    this.channel = channel;
    this.sid = sid;
    this.inputNames = inputNames;
    this.outputNames = outputNames;
  }

  async run(
    feeds: Record<string, ort.Tensor | RemoteTensor>,
    options?: ort.InferenceSession.RunOptions,
    keep?: readonly string[],
  ): Promise<ort.InferenceSession.OnnxValueMapType> {
    if (this.released) throw new Error('yaar-ml: session was released');
    const meta: { n: string; t?: string; d?: readonly number[]; i?: number; ref?: number }[] = [];
    const bufs: Uint8Array[] = [];
    for (const [name, t] of Object.entries(feeds)) {
      if (t instanceof RemoteTensor) {
        meta.push({ n: name, ref: t.refFor(this.channel, name) });
        continue;
      }
      if (t.location !== 'cpu') throw new Error(`yaar-ml: input ${name} is not a CPU tensor`);
      if (t.type === 'string')
        throw new Error(
          `yaar-ml: input ${name} is a string tensor, which cannot cross to the ML host`,
        );
      const d = t.data as ArrayBufferView;
      meta.push({ n: name, t: t.type, d: t.dims, i: bufs.length });
      bufs.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    }
    const t0 = performance.now();
    const { header, bufs: out } = await this.channel.request(
      {
        op: 'run',
        sid: this.sid,
        feeds: meta,
        ...(options ? { opts: options } : {}),
        ...(keep?.length ? { keep } : {}),
      },
      bufs,
    );
    remoteStats.runs++;
    remoteStats.runMs += performance.now() - t0;
    remoteStats.hostMs += header.ms ?? 0;
    const result: Record<string, ort.Tensor | RemoteTensor> = {};
    for (const o of header.outs as {
      n: string;
      t: string;
      d: number[];
      i?: number;
      ref?: number;
    }[]) {
      if (o.ref !== undefined) {
        result[o.n] = new RemoteTensor(this.channel, o.ref, o.t, o.d);
        continue;
      }
      const C = typedArrayFor(o.t);
      const b = out[o.i!];
      result[o.n] = new ort.Tensor(
        o.t as never,
        new C(b.buffer, b.byteOffset, b.byteLength / C.BYTES_PER_ELEMENT),
        o.d,
      );
    }
    return result as ort.InferenceSession.OnnxValueMapType;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (!this.channel.dead)
      await this.channel.request({ op: 'release', sid: this.sid }).catch(() => {});
  }
}

/** A URL the host tab can fetch: this server's own URLs become paths (the tab adds the app's token). */
function remoteUrl(u: string): string {
  const url = new URL(u, location.href);
  return url.origin === location.origin ? url.pathname + url.search : url.href;
}

async function uploadBlob(
  channel: RemoteChannel,
  data: Blob | ArrayBuffer | ArrayBufferView,
): Promise<number> {
  const id = channel.newId();
  const blob =
    data instanceof Blob
      ? data
      : new Blob([
          ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data,
        ]);
  const t0 = performance.now();
  const inflight: Promise<unknown>[] = [];
  for (let o = 0; o < blob.size; o += REMOTE_CHUNK) {
    const chunk = new Uint8Array(await blob.slice(o, o + REMOTE_CHUNK).arrayBuffer());
    inflight.push(channel.request({ op: 'blob', id, off: o, total: blob.size }, [chunk]));
    if (inflight.length >= REMOTE_WINDOW) await inflight.shift();
  }
  await Promise.all(inflight);
  // A zero-byte blob sent no chunk; the host treats an unknown id as empty.
  remoteStats.blobBytes += blob.size;
  remoteStats.blobMs += performance.now() - t0;
  return id;
}

async function createRemoteSession(
  channel: RemoteChannel,
  bytes: Uint8Array,
  backend: Backend,
  extra?: Record<string, unknown>,
): Promise<RemoteSession> {
  const { externalData, executionProviders: _ignored, ...opts } = extra ?? {};
  const ext: { path: string; url?: string; range?: [number, number]; blob?: number }[] = [];
  if (Array.isArray(externalData)) {
    for (const e of externalData) {
      // The bare-string form is both the fetch URL and the `location` the graph names,
      // resolved against *this* page; spelled out as `{ path, data }` so it survives
      // being fetched from another one.
      if (typeof e === 'string') ext.push({ path: e, url: remoteUrl(e) });
      else if (typeof e.data === 'string') ext.push({ path: e.path, url: remoteUrl(e.data) });
      else if (isWeightRange(e.data)) {
        ext.push({ path: e.path, url: remoteUrl(e.data.url), range: [e.data.start, e.data.end] });
      } else ext.push({ path: e.path, blob: await uploadBlob(channel, e.data) });
    }
  }
  const sid = channel.newId();
  const { header } = await channel.request({ op: 'create', sid, backend, opts, ext }, [bytes]);
  return new RemoteSession(channel, sid, header.inputNames, header.outputNames);
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
    const remote = await remoteChannel();
    if (remote) return remote.caps;
    return localCapabilities();
  })();
  return _capsPromise;
}

async function localCapabilities(): Promise<MlCapabilities> {
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
          [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || undefined;
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

  // The weights proxy streams, and a streamed body goes out without Content-Length — the
  // declared length rides in X-Content-Length instead. A local file has the real header.
  const total = Number(
    res.headers.get('x-content-length') || res.headers.get('content-length') || 0,
  );
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

/** Bytes `[start, end)` of a weight file, as an `externalData` entry's `data`. */
export interface WeightRange {
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

const WEIGHT_RANGE = Symbol.for('yaar-ml.weightRange');

/**
 * Name a slice of a weight file for `externalData` instead of fetching it yourself:
 * `{ path: 'seg0.data', data: weightRange(sidecarUrl, lo, hi) }`.
 *
 * Bytes the app fetched are bytes the app has to hand over, and when the session runs
 * in the server's Chrome (see "Remote compute") that means pushing them back up the
 * wire — measured, 15.8 s of anima's 20.5 s DiT load was that upload of a 3.9 GB
 * sidecar the server already had on disk. A range is a name, not bytes: in this page
 * the SDK fetches it just as the app would have, and in the ML host the host fetches it
 * from the server itself.
 */
export function weightRange(url: string, start: number, end: number): WeightRange {
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && 0 <= start && start <= end)) {
    throw new Error(`yaar-ml: weightRange(${start}, ${end}) is not a byte range`);
  }
  return Object.freeze({ url, start, end, [WEIGHT_RANGE]: true }) as WeightRange;
}

function isWeightRange(x: unknown): x is WeightRange {
  return !!x && typeof x === 'object' && (x as Record<symbol, unknown>)[WEIGHT_RANGE] === true;
}

/** Fetch a range in this page, for a session that runs here. A Blob, as anima's own fetch
 *  was: it is not bound by the 2 GB ArrayBuffer cap. */
async function fetchWeightRange(r: WeightRange): Promise<Blob> {
  const res = await fetch(r.url, { headers: { Range: `bytes=${r.start}-${r.end - 1}` } });
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `yaar-ml: range ${r.start}-${r.end - 1} of ${r.url} → HTTP ${res.status} (expected 206)`,
    );
  }
  const blob = await res.blob();
  if (blob.size !== r.end - r.start) {
    throw new Error(
      `yaar-ml: range of ${r.url}: got ${blob.size} bytes, expected ${r.end - r.start}`,
    );
  }
  return blob;
}

/** Turn every weightRange in `externalData` into bytes, for a session that runs here. */
async function resolveWeightRanges(
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const entries = extra?.externalData;
  if (!Array.isArray(entries) || !entries.some((e) => isWeightRange(e?.data))) return extra;
  const resolved = [];
  for (const e of entries) {
    resolved.push(isWeightRange(e?.data) ? { ...e, data: await fetchWeightRange(e.data) } : e);
  }
  return { ...extra, externalData: resolved };
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

function tooBigError(caps: MlCapabilities, err: unknown): Error {
  const ceil = caps.maxStorageBufferBindingSize
    ? `${Math.floor(caps.maxStorageBufferBindingSize / (1024 * 1024))} MB`
    : 'unknown';
  return new Error(
    `This model is too big for your GPU (max single buffer ≈ ${ceil}). ` +
      `Try a smaller or more heavily quantized model, or backend: 'wasm'. ` +
      `(original error: ${String((err as Error)?.message ?? err)})`,
  );
}

async function createSession(
  bytes: Uint8Array,
  backend: Backend,
  rawExtra?: Record<string, unknown>,
): Promise<ort.InferenceSession> {
  const remote = await remoteChannel();
  if (remote) {
    try {
      return (await createRemoteSession(
        remote,
        bytes,
        backend,
        rawExtra,
      )) as unknown as ort.InferenceSession;
    } catch (err) {
      throw backend !== 'wasm' && looksLikeMemoryError(err) ? tooBigError(remote.caps, err) : err;
    }
  }
  const providers = await resolveProviders(backend);
  // wasm-only sessions run on the full-CPU flavor — the native-WebGPU artifact's
  // CPU build has fp64 compiled out (see ORT_WASM_URL).
  const rt = providers.includes('webgpu') ? ort : await wasmFlavor();
  // ORT fetches these URLs from its own worker, where the Referer carries no token.
  const extra = authorizeExternalData(await resolveWeightRanges(rawExtra));
  // `create` transfers the model buffer to the worker in proxy mode, which detaches
  // it here — so each attempt needs its own copy, or the wasm fallback below would
  // hand ORT an empty model. The graph proto is small (weights ride in externalData).
  const modelBytes = () => (rt.env.wasm.proxy ? bytes.slice() : bytes);
  try {
    return await rt.InferenceSession.create(modelBytes(), {
      executionProviders: providers,
      ...extra,
    });
  } catch (err) {
    if (providers.includes('webgpu')) {
      if (looksLikeMemoryError(err)) throw tooBigError(await capabilities(), err);
      // Auto mode: fall back to the CPU wasm backend on any WebGPU failure —
      // on the full-CPU flavor, so the fallback actually has every kernel.
      if (backend === 'auto') {
        const cpu = await wasmFlavor();
        return cpu.InferenceSession.create(modelBytes(), {
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

/**
 * Run inference. `feeds` maps input names to Tensors; returns the output map.
 *
 * `options.keep` names outputs that are only going to be fed to a later run. When the
 * session runs in the server's Chrome they stay there and come back as handles, which
 * cross as an id when fed — no round trip for an activation passed between segments.
 * Read a kept output with `await t.getData()` (never `t.data`, which a handle does not
 * have) and free it with `t.dispose()`; both work on an ordinary tensor too, so code
 * written that way runs the same wherever the session does.
 */
export function run(
  s: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>,
  options?: ort.InferenceSession.RunOptions & { keep?: readonly string[] },
): Promise<ort.InferenceSession.OnnxValueMapType> {
  const { keep, ...ortOptions } = options ?? {};
  const opts = options ? ortOptions : undefined;
  // A remote session serializes its feeds, which already leaves the caller's intact.
  // `keep` only means something there: in this page every output is already here.
  if (s instanceof RemoteSession) return s.run(feeds, opts, keep);
  return s.run(ort.env.wasm.proxy ? copyFeeds(feeds) : feeds, opts);
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
/**
 * onnxruntime-web env (advanced tuning: `env.wasm`, `env.webgpu`, `env.logLevel`).
 * This is the native-WebGPU flavor's env; the full-CPU flavor that wasm-only
 * sessions run on keeps the SDK defaults regardless of edits here.
 */
export const env = ort.env;
/** The raw onnxruntime-web namespace, for APIs not surfaced above. */
export { ort };
