// In-browser Anima runtime helpers: load ONNX models that use external-data
// sidecars (`.onnx` + `.onnx.data`), cached in IndexedDB, run on WebGPU.
//
// The @bundled/yaar-ml shim's `session(url)` path fetches a single buffer through
// the domain-allowlisted `/api/ml-weights` proxy. Our weights are *local*, served
// same-origin from a read-only mount at `/api/storage/mounts/krea/…`, and split
// into `.onnx` + `.onnx.data`. So we fetch both files ourselves (same-origin,
// CSP `connect-src 'self'`) and hand the model bytes + external-data buffer to
// `session(bytes, { sessionOptions: { externalData } })`.
import { session, run, Tensor, capabilities, dispose } from '@bundled/yaar-ml';
import type { InferenceSession } from '@bundled/yaar-ml';

export { Tensor, run, capabilities, dispose };

export const BASE = '/api/storage/mounts/krea';

export interface Progress {
  file: string;
  loaded: number;
  total: number;
  ratio: number;
  cached?: boolean;
}
export type ProgressFn = (p: Progress) => void;

// ── IndexedDB cache (multi-GB weight files, keyed by URL) ────────────────────
const DB = 'anima-weights';
const STORE = 'files';
let _db: Promise<IDBDatabase | null> | undefined;
function db(): Promise<IDBDatabase | null> {
  if (_db) return _db;
  _db = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
  return _db;
}
function idb<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function cacheGet(url: string): Promise<ArrayBuffer | null> {
  const d = await db();
  if (!d) return null;
  try {
    return (await idb(d.transaction(STORE, 'readonly').objectStore(STORE).get(url))) ?? null;
  } catch {
    return null;
  }
}
async function cachePut(url: string, buf: ArrayBuffer): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    await idb(d.transaction(STORE, 'readwrite').objectStore(STORE).put(buf, url));
  } catch {
    /* quota — just skip caching */
  }
}
export async function clearWeightCache(): Promise<void> {
  const d = await db();
  if (d) await idb(d.transaction(STORE, 'readwrite').objectStore(STORE).clear());
}

// ── Same-origin streaming fetch with progress + IDB cache ────────────────────
export async function fetchFile(url: string, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const file = url.split('/').pop() || url;
  const hit = await cacheGet(url);
  if (hit) {
    onProgress?.({ file, loaded: hit.byteLength, total: hit.byteLength, ratio: 1, cached: true });
    return hit;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    await cachePut(url, buf);
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
    onProgress?.({ file, loaded, total, ratio: total ? loaded / total : 0 });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  await cachePut(url, out.buffer);
  return out.buffer;
}

export async function fetchJSON<T = any>(name: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fetchFile(`${BASE}/${name}`)));
}
export async function fetchF32(name: string): Promise<Float32Array> {
  return new Float32Array(await fetchFile(`${BASE}/${name}`));
}

// ── Model loading (external data) ────────────────────────────────────────────
// How to hand the `.onnx.data` sidecar to onnxruntime-web:
//   'bytes' — fetch into one Uint8Array (simplest; hits V8's 2 GB/ArrayBuffer
//             cap, so only usable for sidecars < 2 GB).
//   'url'   — pass the same-origin URL; ORT streams it into its wasm heap
//             (up to 4 GB) with no giant JS buffer. Required for the 3.9 GB DiT.
//   'blob'  — pass a Blob (also not bound by the 2 GB ArrayBuffer cap).
export type ExtDataMode = 'bytes' | 'url' | 'blob';

/** Load `<name>.onnx` + `<name>.onnx.data` from the mount → WebGPU session.
 *  `dataName` overrides the sidecar filename when the `.onnx`'s recorded
 *  external-data `location` differs from `<name>` (e.g. probe graphs that reuse
 *  another model's `.onnx.data`). */
export async function loadModel(
  name: string,
  onProgress?: ProgressFn,
  backend: 'webgpu' | 'wasm' | 'auto' = 'webgpu',
  mode: ExtDataMode = 'bytes',
  extraSessionOptions: Record<string, unknown> = {},
  dataName?: string,
): Promise<InferenceSession> {
  const model = await fetchFile(`${BASE}/${name}.onnx`, onProgress); // small graph proto
  const dataPath = dataName ?? `${name}.onnx.data`; // must match the `location` recorded in the .onnx
  const dataUrl = `${location.origin}${BASE}/${dataPath}`;
  let data: string | Blob | Uint8Array;
  if (mode === 'url') {
    data = dataUrl; // ORT fetches + streams into wasm memory itself
  } else if (mode === 'blob') {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error(`fetch ${dataUrl} → ${res.status}`);
    data = await res.blob(); // Blob is not bound by the 2 GB ArrayBuffer cap
  } else {
    data = new Uint8Array(await fetchFile(`${BASE}/${dataPath}`, onProgress));
  }
  return session(new Uint8Array(model), {
    backend,
    sessionOptions: { externalData: [{ path: dataPath, data }], ...extraSessionOptions },
  });
}

// ── fp16 → fp32 ──────────────────────────────────────────────────────────────
// `convert_fp16.py` passes keep_io_types=True, but the text graphs still declare
// FLOAT16 outputs. The conditioner (source_hidden_states) and the DiT
// (encoder_hidden_states) both want fp32, so we convert on the way out —
// see `asF32` for the two shapes that conversion can take.

/** Decode raw fp16 bits (Uint16) → f32: exp==0x1f & mant!=0 → NaN, ==0 → Inf. */
export function f16ToF32(bits: ArrayLike<number>): Float32Array {
  const out = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    const s = b & 0x8000 ? -1 : 1;
    const e = (b & 0x7c00) >> 10;
    const m = b & 0x03ff;
    if (e === 0) out[i] = s * Math.pow(2, -14) * (m / 1024);
    else if (e === 0x1f) out[i] = m ? NaN : s * Infinity;
    else out[i] = s * Math.pow(2, e - 15) * (1 + m / 1024);
  }
  return out;
}

/** Read an ORT output as fp32 regardless of how float16 came back.
 *
 *  A `float16` tensor's `.data` is EITHER a `Float16Array` of real floats (when
 *  the browser has the type — Chrome ≥ 135) OR a `Uint16Array` of raw half bits.
 *  Bit-decoding a Float16Array silently yields all zeros (every |v|<1 truncates
 *  to exponent 0, mantissa 0), so dispatch on the actual constructor, not on
 *  `t.type`. */
export function asF32(t: { data: unknown; type: string }): Float32Array {
  const d = t.data;
  if (d instanceof Float32Array) return d;
  const F16 = (globalThis as { Float16Array?: new () => unknown }).Float16Array;
  if (F16 && d instanceof (F16 as unknown as new () => object))
    return Float32Array.from(d as unknown as ArrayLike<number>);
  if (d instanceof Uint16Array) return f16ToF32(d);
  return Float32Array.from(d as ArrayLike<number>);
}

// ── Image helpers ────────────────────────────────────────────────────────────
/** CHW float in [-1,1] (shape [1,3,H,W]) → ImageData for a canvas. */
export function chwToImageData(img: Float32Array, H: number, W: number): ImageData {
  const out = new Uint8ClampedArray(W * H * 4);
  const plane = H * W;
  for (let i = 0; i < plane; i++) {
    out[i * 4 + 0] = (img[i] + 1) * 127.5;
    out[i * 4 + 1] = (img[plane + i] + 1) * 127.5;
    out[i * 4 + 2] = (img[2 * plane + i] + 1) * 127.5;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, W, H);
}
