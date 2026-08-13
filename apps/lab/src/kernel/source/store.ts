// KERNEL PART 6/12 — the `store` and `http` helpers plus `sleep`, all bridge-backed.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const STORE = String.raw`
/* ------------------------------------------------------------------ store -- */

function __labWritable(path, data) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) throw new Error('store.write: binary data is not supported; write a string');
  var rows = (data && data.__isDf) ? data.rows : data;
  if (/\.csv$/i.test(path) && Array.isArray(rows)) return csv.stringify(rows);
  if (/\.(txt|md|log)$/i.test(path)) return String(rows);
  return __labStringify(rows, 2) || 'null';
}

var store = {
  read: function (path) { return __labBridge('store.read', [path]); },
  readJSON: function (path) { return __labBridge('store.read', [path]).then(function (t) { return JSON.parse(t); }); },
  readCSV: function (path, opts) { return __labBridge('store.read', [path]).then(function (t) { return csv.parse(t, opts); }); },
  write: function (path, data) { return __labBridge('store.write', [path, __labWritable(path, data)]); },
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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
`;