/* global document, navigator, location, URL, WebSocket, fetch, TextEncoder, TextDecoder, performance */
// The ML host page: runs `@bundled/yaar-ml` sessions for an app whose own engine is slow.
//
// This file is browser JavaScript, not server code. `relay.ts` imports it as text and
// serves it inline in `/api/ml-host/page`, which the server opens in its own headless
// Chrome, one tab per app connection. The app's shim (`packages/compiler/src/shims/
// yaar-ml.ts`, "Remote compute") sends it model bytes and tensors over the relay socket;
// it answers with session metadata and output tensors. See `relay.ts` for why this exists.
//
// The wire format is duplicated in the shim — keep the two in step:
//
//   frame   = [u8 more][fragment]           more = 1 while further fragments follow
//   message = [u32 LE headerLen][u32 LE 0][header JSON, padded to 8][buf, padded to 8]…
//
// `header.b` lists the buffer lengths. Padding keeps every buffer 8-byte aligned in the
// reassembled message, so a typed array can view it without a copy.

const cfg = JSON.parse(document.getElementById('cfg').textContent);

const FRAGMENT = 4 << 20;
const pad8 = (n) => (n + 7) & ~7;
const enc = new TextEncoder();
const dec = new TextDecoder();

function encode(header, bufs) {
  const h = enc.encode(JSON.stringify({ ...header, b: bufs.map((b) => b.byteLength) }));
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

function decode(bytes) {
  const hlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(dec.decode(bytes.subarray(8, 8 + hlen)));
  const bufs = [];
  let o = 8 + pad8(hlen);
  for (const len of header.b ?? []) {
    bufs.push(bytes.subarray(o, o + len));
    o += pad8(len);
  }
  return { header, bufs };
}

let ws;
function send(header, bufs = []) {
  const m = encode(header, bufs);
  // Fragments of one message go out back to back, with no await between them, so two
  // messages can never interleave on the socket.
  for (let o = 0; ; o += FRAGMENT) {
    const end = Math.min(o + FRAGMENT, m.byteLength);
    const f = new Uint8Array(1 + end - o);
    f[0] = end < m.byteLength ? 1 : 0;
    f.set(m.subarray(o, end), 1);
    ws.send(f);
    if (end >= m.byteLength) break;
  }
}

// ── ORT ──────────────────────────────────────────────────────────────────────

const importModule = new Function('u', 'return import(u)');

function configure(rt, artifact) {
  rt.env.wasm.wasmPaths = {
    mjs: cfg.runtime[`${artifact}.mjs`],
    wasm: cfg.runtime[`${artifact}.wasm`],
  };
  rt.env.wasm.numThreads = 1;
  // Nothing else lives on this page, so a blocking session create freezes nobody and
  // the proxy worker's extra hop (and its copies) buys nothing.
  rt.env.wasm.proxy = false;
  rt.env.logLevel = 'error';
}

let ort;
let wasmOrt;
function wasmFlavor() {
  wasmOrt ??= importModule(cfg.runtime['ort.wasm.bundle.min.mjs']).then((m) => {
    configure(m, 'ort-wasm-simd-threaded');
    return m;
  });
  return wasmOrt;
}

async function capabilities() {
  const none = {
    webgpu: false,
    f16: false,
    maxBufferSize: 0,
    maxStorageBufferBindingSize: 0,
    estMemoryBudget: 0,
  };
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) return none;
  const info = adapter.info;
  const name = info
    ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
    : '';
  const binding = Number(adapter.limits.maxStorageBufferBindingSize ?? 0);
  return {
    webgpu: true,
    f16: adapter.features.has('shader-f16'),
    maxBufferSize: Number(adapter.limits.maxBufferSize ?? 0),
    maxStorageBufferBindingSize: binding,
    estMemoryBudget: binding,
    adapter: name || undefined,
  };
}

// ── Tensors ──────────────────────────────────────────────────────────────────

const CTORS = {
  float32: Float32Array,
  float64: Float64Array,
  float16: globalThis.Float16Array ?? Uint16Array,
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

function view(type, bytes) {
  const C = CTORS[type];
  if (!C) throw new Error(`tensor type ${type} cannot cross to the ML host`);
  return new C(bytes.buffer, bytes.byteOffset, bytes.byteLength / C.BYTES_PER_ELEMENT);
}

const asBytes = (d) => new Uint8Array(d.buffer, d.byteOffset, d.byteLength);

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * Put the app's own credentials on a URL this server serves.
 *
 * Forced, not added-if-missing: this page carries no identity of its own, so a URL the
 * app named without a token — or with some other token — must still be fetched *as the
 * app*, never as whatever a token-less request on this origin would resolve to.
 */
function authorize(u) {
  const url = new URL(u, location.href);
  if (url.origin !== location.origin) return url.href;
  url.searchParams.set('__yaar_token', cfg.iframeToken);
  if (cfg.remoteToken) url.searchParams.set('token', cfg.remoteToken);
  return url.href;
}

const sessions = new Map();
const blobs = new Map();

/**
 * Bytes `[start, end)` of a same-server weight file, fetched here rather than sent from
 * the app (`weightRange()` in the shim) — the server reads them off its own disk.
 */
async function fetchRange(url, [start, end]) {
  const res = await fetch(authorize(url), { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`range ${start}-${end - 1} of ${url} → HTTP ${res.status} (expected 206)`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength !== end - start) {
    throw new Error(`range of ${url}: got ${data.byteLength} bytes, expected ${end - start}`);
  }
  return data;
}

/** One externalData entry as ORT takes it: a range fetched here, a URL ORT fetches, or bytes the app sent. */
async function externalEntry(e) {
  if (e.range) return { path: e.path, data: await fetchRange(e.url, e.range) };
  if (e.blob === undefined) return { path: e.path, data: authorize(e.url) };
  const data = blobs.get(e.blob) ?? new Uint8Array(0);
  blobs.delete(e.blob);
  return { path: e.path, data };
}

async function create(h, bufs) {
  const externalData = [];
  for (const e of h.ext ?? []) externalData.push(await externalEntry(e));
  const options = { ...(h.opts ?? {}), ...(externalData.length ? { externalData } : {}) };
  const model = bufs[0];
  const caps = await capabilitiesOnce;
  const providers =
    h.backend === 'wasm'
      ? ['wasm']
      : h.backend === 'webgpu'
        ? ['webgpu']
        : caps.webgpu
          ? ['webgpu', 'wasm']
          : ['wasm'];
  const rt = providers.includes('webgpu') ? ort : await wasmFlavor();
  let s;
  try {
    s = await rt.InferenceSession.create(model, { executionProviders: providers, ...options });
  } catch (err) {
    if (!(providers.includes('webgpu') && h.backend === 'auto')) throw err;
    const cpu = await wasmFlavor();
    s = await cpu.InferenceSession.create(model, { executionProviders: ['wasm'], ...options });
  }
  sessions.set(h.sid, s);
  return [{ inputNames: s.inputNames, outputNames: s.outputNames }, []];
}

/** Outputs a run was asked to keep (`keep`), by ref, until the app drops them. */
const kept = new Map();
let nextRef = 1;

async function run(h, bufs) {
  const s = sessions.get(h.sid);
  if (!s) throw new Error('session was released');
  const feeds = {};
  for (const f of h.feeds) {
    if (f.ref === undefined) {
      feeds[f.n] = new ort.Tensor(f.t, view(f.t, bufs[f.i]), f.d);
      continue;
    }
    const t = kept.get(f.ref);
    if (!t) throw new Error(`input ${f.n} refers to a tensor that was dropped`);
    feeds[f.n] = t;
  }
  const keep = new Set(h.keep ?? []);
  const t0 = performance.now();
  const out = await s.run(feeds, h.opts);
  const ms = performance.now() - t0;
  const outs = [];
  const data = [];
  for (const [name, t] of Object.entries(out)) {
    if (keep.has(name)) {
      const ref = nextRef++;
      kept.set(ref, t);
      outs.push({ n: name, t: t.type, d: t.dims, ref });
      continue;
    }
    if (t.type === 'string') {
      throw new Error(`output ${name} is a string tensor, which cannot cross to the app`);
    }
    const d = t.location === 'cpu' ? t.data : await t.getData(true);
    outs.push({ n: name, t: t.type, d: t.dims, i: data.length });
    data.push(asBytes(d));
  }
  return [{ outs, ms }, data];
}

async function fetchKept(h) {
  const t = kept.get(h.ref);
  if (!t) throw new Error('that tensor was dropped');
  const d = t.location === 'cpu' ? t.data : await t.getData();
  return [{}, [asBytes(d)]];
}

async function handle(h, bufs) {
  switch (h.op) {
    case 'blob': {
      // A chunk of externalData the app holds as bytes, written into one buffer sized
      // up front. Not a Blob: Chrome refused to read back a ~600 MB Blob assembled from
      // chunks in this tab ("The requested file could not be read…"), measured on the
      // first anima segment. A Uint8Array is what ORT copies from anyway.
      let data = blobs.get(h.id);
      if (!data) blobs.set(h.id, (data = new Uint8Array(h.total)));
      data.set(bufs[0], h.off);
      return [{}, []];
    }
    case 'create':
      return create(h, bufs);
    case 'run':
      return run(h, bufs);
    case 'fetch':
      return fetchKept(h);
    case 'drop':
      for (const ref of h.refs ?? []) {
        kept.get(ref)?.dispose();
        kept.delete(ref);
      }
      return [{}, []];
    case 'release': {
      const s = sessions.get(h.sid);
      sessions.delete(h.sid);
      await s?.release();
      return [{}, []];
    }
    default:
      throw new Error(`unknown op ${h.op}`);
  }
}

// Blob chunks and drops answer at once — the uploader's window keeps moving while a
// session is being created, and freeing memory never waits behind a run; everything else
// runs one at a time, in the order the app sent it.
let chain = Promise.resolve();
function onMessage(bytes) {
  const { header: h, bufs } = decode(bytes);
  const work = async () => {
    try {
      const [reply, data] = await handle(h, bufs);
      send({ rid: h.rid, ...reply }, data);
    } catch (err) {
      send({ rid: h.rid, error: String(err?.message ?? err) });
    }
  };
  if (h.op === 'blob' || h.op === 'drop') void work();
  else chain = chain.then(work);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let capabilitiesOnce;
(async () => {
  let fatal = null;
  try {
    ort = await importModule(cfg.runtime['ort.webgpu.bundle.min.mjs']);
    configure(ort, 'ort-wasm-simd-threaded.asyncify');
    capabilitiesOnce = capabilities();
    await capabilitiesOnce;
  } catch (err) {
    fatal = String(err?.message ?? err);
  }

  ws = new WebSocket(cfg.wsUrl);
  ws.binaryType = 'arraybuffer';
  let parts = [];
  let size = 0;
  ws.onmessage = (ev) => {
    const frame = new Uint8Array(ev.data);
    parts.push(frame.subarray(1));
    size += frame.byteLength - 1;
    if (frame[0] === 1) return;
    // Always copy into a fresh buffer: that is what puts the message at offset 0, where
    // the padding makes every buffer aligned.
    const whole = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      whole.set(p, o);
      o += p.byteLength;
    }
    parts = [];
    size = 0;
    onMessage(whole);
  };
  ws.onopen = async () => {
    if (fatal) send({ op: 'local', reason: `the ML host could not load onnxruntime: ${fatal}` });
    else send({ op: 'ready', caps: await capabilitiesOnce, ua: navigator.userAgent });
  };
})();
