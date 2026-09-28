// KERNEL PART 6/12 — the `store` and `http` helpers, the cell's `fetch`, and `sleep`;
// all but `sleep` are bridge-backed.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const STORE = String.raw`
/* ------------------------------------------------------------------ store -- */

function __labWritable(path, data) {
  if (typeof data === 'string') return data;
  var rows = (data && data.__isDf) ? data.rows : data;
  if (/\.csv$/i.test(path) && Array.isArray(rows)) return csv.stringify(rows);
  if (/\.(txt|md|log)$/i.test(path)) return String(rows);
  return __labStringify(rows, 2) || 'null';
}

/* Bytes in any of their shapes, as something postMessage carries intact; null if not bytes. */
function __labBytes(data) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

/* store.write's third argument. Anything unrecognised throws: a dropped option once
   wrote base64 text into a .png and reported success. */
function __labWriteEncoding(opts) {
  if (opts === undefined || opts === null) return null;
  if (typeof opts === 'string') opts = { encoding: opts };
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new Error("store.write: the third argument must be { encoding: 'utf-8' | 'base64' }");
  var keys = Object.keys(opts);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== 'encoding') throw new Error("store.write: unknown option '" + keys[i] + "' (the only option is encoding: 'utf-8' | 'base64')");
  }
  var enc = opts.encoding;
  if (enc === undefined || enc === null || enc === 'utf-8' || enc === 'utf8') return null;
  if (enc === 'base64') return 'base64';
  throw new Error("store.write: unsupported encoding '" + String(enc) + "' (use 'utf-8' or 'base64')");
}

function __labStoreWrite(path, data, opts) {
  var enc = __labWriteEncoding(opts);
  var bytes = __labBytes(data);
  if (enc === 'base64' && typeof data !== 'string') {
    throw new Error("store.write: encoding 'base64' takes a base64 string; pass bytes (Uint8Array, ArrayBuffer, Blob) with no encoding");
  }
  return __labBridge('store.write', [path, bytes || __labWritable(path, data), enc]);
}

var store = {
  read: function (path) { return __labBridge('store.read', [path]); },
  readJSON: function (path) { return __labBridge('store.read', [path]).then(function (t) { return JSON.parse(t); }); },
  readCSV: function (path, opts) { return __labBridge('store.read', [path]).then(function (t) { return csv.parse(t, opts); }); },
  write: function (path, data, opts) {
    try { return __labStoreWrite(path, data, opts); } catch (e) { return Promise.reject(e); }
  },
  writeJSON: function (path, data) { return __labBridge('store.write', [path, __labStringify((data && data.__isDf) ? data.rows : data, 2) || 'null']); },
  writeCSV: function (path, rows) { return __labBridge('store.write', [path, csv.stringify(rows)]); },
  list: function (dir) { return __labBridge('store.list', [dir || '']); },
  remove: function (path) { return __labBridge('store.remove', [path]); },
  exists: function (path) { return __labBridge('store.exists', [path]); }
};

var http = {
  raw: function (url, init) { return __labBridge('http.fetch', [url, init || null]); },
  text: function (url, init) { return __labBridge('http.fetch', [url, init || null]).then(function (r) { return r.body; }); },
  json: function (url, init) { return __labBridge('http.fetch', [url, init || null]).then(function (r) { return JSON.parse(r.body); }); }
};

/* The cell's fetch, run by the window. The worker's own fetch resolves '/api/...'
   against its blob: URL and fails, and carries neither the iframe token nor the
   allowlisted proxy; the window's has all three. Bodies postMessage cannot carry
   (FormData, URLSearchParams, streams) are serialised here with their content type. */
var __labNullBodyStatus = { 101: 1, 204: 1, 205: 1, 304: 1 };

function __labFetchArgs(input, init) {
  var req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
  init = init || {};
  var headers = [];
  var h = init.headers !== undefined ? new Headers(init.headers) : (req ? req.headers : null);
  if (h) h.forEach(function (v, k) { headers.push([k, v]); });
  var out = { method: init.method || (req ? req.method : 'GET'), headers: headers };
  var redirect = init.redirect || (req ? req.redirect : null);
  if (redirect) out.redirect = redirect;
  if (init.credentials) out.credentials = init.credentials;
  if (init.cache) out.cache = init.cache;
  var body = init.body;
  var bodyP;
  if (body === undefined || body === null) {
    bodyP = (req && req.body) ? req.arrayBuffer() : Promise.resolve(null);
  } else if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    bodyP = Promise.resolve(body);
  } else {
    var wrapped = new Response(body);
    var ct = wrapped.headers.get('content-type');
    if (ct && !headers.some(function (p) { return p[0] === 'content-type'; })) headers.push(['content-type', ct]);
    bodyP = wrapped.arrayBuffer();
  }
  return bodyP.then(function (b) {
    if (b !== null) out.body = b;
    return [req ? req.url : String(input), out];
  });
}

function __labAbortError(sig) {
  return sig.reason || new DOMException('The operation was aborted.', 'AbortError');
}

function __labFetch(input, init) {
  var sig = (init && init.signal) || ((typeof Request !== 'undefined' && input instanceof Request) ? input.signal : null);
  if (sig && sig.aborted) return Promise.reject(__labAbortError(sig));
  var p = __labFetchArgs(input, init)
    .then(function (a) { return __labBridge('fetch', a); })
    .then(function (r) {
      if (r.status < 200 || r.status > 599) return Response.error();
      return new Response(__labNullBodyStatus[r.status] ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
    });
  if (!sig) return p;
  return new Promise(function (resolve, reject) {
    sig.addEventListener('abort', function () { reject(__labAbortError(sig)); }, { once: true });
    p.then(resolve, reject);
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
`;
