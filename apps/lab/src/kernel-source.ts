// The compute kernel. This string is turned into a Blob and run as a classic Web Worker.
//
// IMPORTANT: this is a String.raw template literal, so the body must contain
// NO backticks and NO dollar-brace sequences. Backslashes survive verbatim
// (that is why String.raw is used), so regexes can be written normally.
// Everything here is plain ES2020 JS, NOT type checked. See AGENTS.md.

export const KERNEL_SRC = String.raw`
var __labLIM = { maxRows: 5000, maxCellChars: 400, maxJsonBytes: 250000, maxStringChars: 200000, maxLogs: 500, maxLogChars: 4000 };
var __labS = { logs: [], parts: [], lastChart: null, pending: Object.create(null), nextCallId: 1 };
var __labAF = Object.getPrototypeOf(async function () {}).constructor;

/* ---------------------------------------------------------------- bridge -- */

function __labBridge(method, args) {
  var id = __labS.nextCallId++;
  return new Promise(function (resolve, reject) {
    __labS.pending[id] = { resolve: resolve, reject: reject };
    self.postMessage({ type: 'bridge', callId: id, method: method, args: args });
  });
}

/* ------------------------------------------------------------ formatting -- */

function __labStringify(v, indent) {
  var seen = new WeakSet();
  try {
    return JSON.stringify(v, function (k, val) {
      if (typeof val === 'bigint') return String(val) + 'n';
      if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
      if (typeof val === 'symbol') return String(val);
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
        if (val.__isDf) return val.rows;
        if (val.__isGroup) return val.toArray();
        if (val instanceof Map) return { __type: 'Map', entries: Array.from(val.entries()).slice(0, 500) };
        if (val instanceof Set) return { __type: 'Set', values: Array.from(val.values()).slice(0, 500) };
        if (val instanceof Date) return val.toISOString();
        if (ArrayBuffer.isView(val)) return Array.prototype.slice.call(val, 0, 500);
      }
      return val;
    }, indent);
  } catch (e) {
    return '"[unserializable: ' + String(e && e.message) + ']"';
  }
}

function __labFmt(a) {
  if (typeof a === 'string') return a;
  if (a === undefined) return 'undefined';
  if (a === null) return 'null';
  if (a instanceof Error) return (a.stack || (a.name + ': ' + a.message));
  if (typeof a === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
  if (a && a.__isDf) return 'df(' + a.rows.length + ' rows) ' + __labClip(__labStringify(a.rows.slice(0, 5)) || '', 800);
  if (typeof a === 'object') return __labClip(__labStringify(a) || String(a), 2000);
  return String(a);
}

function __labClip(s, max) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + '…(' + s.length + ' chars)' : s;
}

['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (level) {
  console[level] = function () {
    if (__labS.logs.length >= __labLIM.maxLogs) return;
    var text = Array.prototype.map.call(arguments, __labFmt).join(' ');
    if (text.length > __labLIM.maxLogChars) text = text.slice(0, __labLIM.maxLogChars) + '…';
    __labS.logs.push({ level: (level === 'debug' || level === 'trace') ? 'log' : level, text: text });
  };
});

/* -------------------------------------------------------------------- csv -- */

function __labCast(v) {
  if (typeof v !== 'string') return v;
  var t = v.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === 'NULL' || t === 'NA') return null;
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(t)) return Number(t);
  return v;
}

var csv = {
  parse: function (text, opts) {
    opts = opts || {};
    var header = opts.header !== false;
    var delim = opts.delimiter || ',';
    var cast = opts.cast !== false;
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var out = [], row = [], field = '', inQ = false, atStart = true;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else { inQ = false; atStart = false; }
        } else field += c;
        continue;
      }
      if (c === '"' && atStart) { inQ = true; atStart = false; continue; }
      if (c === delim) { row.push(field); field = ''; atStart = true; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); out.push(row); row = []; field = ''; atStart = true; continue;
      }
      field += c; atStart = false;
    }
    if (field !== '' || row.length > 0) { row.push(field); out.push(row); }
    while (out.length && out[out.length - 1].length === 1 && out[out.length - 1][0] === '') out.pop();
    if (!header) return cast ? out.map(function (r) { return r.map(__labCast); }) : out;
    if (!out.length) return [];
    var cols = out[0].map(function (h, ix) { return String(h).trim() || ('col' + ix); });
    var res = [];
    for (var r2 = 1; r2 < out.length; r2++) {
      var o = {};
      for (var ci = 0; ci < cols.length; ci++) {
        var raw = out[r2][ci];
        o[cols[ci]] = raw === undefined ? null : (cast ? __labCast(raw) : raw);
      }
      res.push(o);
    }
    return res;
  },

  stringify: function (rows, opts) {
    opts = opts || {};
    var delim = opts.delimiter || ',';
    var eol = opts.eol || '\n';
    if (rows && rows.__isDf) rows = rows.rows;
    if (!Array.isArray(rows) || rows.length === 0) return '';
    function q(v) {
      if (v === null || v === undefined) return '';
      var s = (typeof v === 'object') ? (__labStringify(v) || '') : String(v);
      if (s.indexOf('"') >= 0 || s.indexOf(delim) >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
        return '"' + s.split('"').join('""') + '"';
      }
      return s;
    }
    var lines = [];
    if (Array.isArray(rows[0])) {
      rows.forEach(function (r) { lines.push(r.map(q).join(delim)); });
    } else {
      var cols = opts.columns || __labColumns(rows);
      if (opts.header !== false) lines.push(cols.map(q).join(delim));
      rows.forEach(function (r) { lines.push(cols.map(function (c) { return q(r ? r[c] : ''); }).join(delim)); });
    }
    return lines.join(eol) + eol;
  }
};

/* ------------------------------------------------------------------ stats -- */

function __labNums(a) {
  var o = [];
  for (var i = 0; i < a.length; i++) {
    var v = a[i];
    if (typeof v === 'number') { if (isFinite(v)) o.push(v); }
    else if (typeof v === 'boolean') o.push(v ? 1 : 0);
    else if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) o.push(Number(v));
  }
  return o;
}
function __labRound(x) {
  if (typeof x !== 'number' || !isFinite(x)) return x;
  return Math.round(x * 1e6) / 1e6;
}

var stats = {
  sum: function (a) { var n = __labNums(a), s = 0; for (var i = 0; i < n.length; i++) s += n[i]; return s; },
  count: function (a) { return __labNums(a).length; },
  mean: function (a) { var n = __labNums(a); return n.length ? stats.sum(n) / n.length : null; },
  min: function (a) { var n = __labNums(a); return n.length ? Math.min.apply(null, n) : null; },
  max: function (a) { var n = __labNums(a); return n.length ? Math.max.apply(null, n) : null; },
  median: function (a) { return stats.quantile(a, 0.5); },
  quantile: function (a, q) {
    var n = __labNums(a).sort(function (x, y) { return x - y; });
    if (!n.length) return null;
    if (q <= 0) return n[0];
    if (q >= 1) return n[n.length - 1];
    var pos = (n.length - 1) * q, base = Math.floor(pos), rest = pos - base;
    return n[base + 1] !== undefined ? n[base] + rest * (n[base + 1] - n[base]) : n[base];
  },
  variance: function (a, population) {
    var n = __labNums(a);
    if (n.length < 2) return n.length ? 0 : null;
    var m = stats.mean(n), s = 0;
    for (var i = 0; i < n.length; i++) s += (n[i] - m) * (n[i] - m);
    return s / (population ? n.length : n.length - 1);
  },
  stdev: function (a, population) { var v = stats.variance(a, population); return v === null ? null : Math.sqrt(v); },
  corr: function (a, b) {
    var x = __labNums(a), y = __labNums(b), n = Math.min(x.length, y.length);
    if (n < 2) return null;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (i = 0; i < n; i++) { var a1 = x[i] - mx, b1 = y[i] - my; num += a1 * b1; dx += a1 * a1; dy += b1 * b1; }
    return (dx === 0 || dy === 0) ? null : num / Math.sqrt(dx * dy);
  },
  histogram: function (a, bins) {
    var n = __labNums(a);
    bins = bins || 10;
    if (!n.length) return [];
    var lo = Math.min.apply(null, n), hi = Math.max.apply(null, n);
    if (lo === hi) return [{ bin: String(lo), x0: lo, x1: hi, count: n.length }];
    var w = (hi - lo) / bins, out = [], i;
    for (i = 0; i < bins; i++) out.push({ bin: __labRound(lo + i * w) + '–' + __labRound(lo + (i + 1) * w), x0: lo + i * w, x1: lo + (i + 1) * w, count: 0 });
    for (i = 0; i < n.length; i++) {
      var ix = Math.floor((n[i] - lo) / w);
      if (ix >= bins) ix = bins - 1;
      if (ix < 0) ix = 0;
      out[ix].count++;
    }
    return out;
  }
};

/* --------------------------------------------------------------- df / rows -- */

function __labToRows(x) {
  if (!x) return [];
  if (x.__isDf) return x.rows;
  if (x.__isGroup) return x.toArray();
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') return [x];
  return [];
}

function __labColumns(rows) {
  var out = [], seen = Object.create(null);
  var lim = Math.min(rows.length, 500);
  for (var i = 0; i < lim; i++) {
    var r = rows[i];
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      var ks = Object.keys(r);
      for (var j = 0; j < ks.length; j++) if (!seen[ks[j]]) { seen[ks[j]] = 1; out.push(ks[j]); }
    }
  }
  return out;
}

function __labIsTabular(rows) {
  var lim = Math.min(rows.length, 20), ok = 0;
  for (var i = 0; i < lim; i++) {
    var r = rows[i];
    if (r && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date)) ok++;
  }
  return lim > 0 && ok >= Math.ceil(lim / 2);
}

function __labKeyOf(r, key) {
  if (typeof key === 'function') return key(r);
  if (Array.isArray(key)) return key.map(function (k) { return r ? r[k] : undefined; }).join(' | ');
  return r ? r[key] : undefined;
}

function __labApplyOp(op, vals, rows) {
  var nv = __labNums(vals);
  if (op === 'sum') return __labRound(stats.sum(nv));
  if (op === 'mean' || op === 'avg') return __labRound(stats.mean(nv));
  if (op === 'min') return stats.min(nv);
  if (op === 'max') return stats.max(nv);
  if (op === 'median') return __labRound(stats.median(nv));
  if (op === 'stdev' || op === 'std') return __labRound(stats.stdev(nv));
  if (op === 'count') return rows.length;
  if (op === 'countDistinct' || op === 'nunique') {
    var s = Object.create(null), n = 0;
    vals.forEach(function (v) { var k = String(v); if (!s[k]) { s[k] = 1; n++; } });
    return n;
  }
  if (op === 'first') return vals.length ? vals[0] : null;
  if (op === 'last') return vals.length ? vals[vals.length - 1] : null;
  if (op === 'list') return vals;
  if (op === 'join') return vals.join(', ');
  throw new Error('Unknown agg op: ' + String(op) + ' (use sum/mean/min/max/median/stdev/count/countDistinct/first/last/list/join or a function)');
}

function __labAgg(rows, spec, keyName, keyVal) {
  var o = {};
  if (keyName !== null && keyName !== undefined) o[keyName] = keyVal;
  Object.keys(spec).forEach(function (col) {
    var op = spec[col];
    if (typeof op === 'function') { o[col] = op(rows); return; }
    if (op && typeof op === 'object' && op.col) {
      var vs = rows.map(function (r) { return r ? r[op.col] : undefined; });
      o[col] = typeof op.fn === 'function' ? op.fn(vs, rows) : __labApplyOp(op.fn || op.op, vs, rows);
      return;
    }
    var vals = rows.map(function (r) { return r ? r[col] : undefined; });
    o[col] = __labApplyOp(op, vals, rows);
  });
  return o;
}

function __labGroup(rows, key) {
  var order = [], map = Object.create(null);
  rows.forEach(function (r) {
    var kv = __labKeyOf(r, key), kk = String(kv);
    if (!map[kk]) { map[kk] = { key: kv, rows: [] }; order.push(kk); }
    map[kk].rows.push(r);
  });
  var groups = order.map(function (k) { return map[k]; });
  var keyName = typeof key === 'function' ? 'key' : (Array.isArray(key) ? key.join('_') : String(key));
  var g = {
    __isGroup: true,
    groups: groups,
    size: groups.length,
    keys: groups.map(function (x) { return x.key; }),
    count: function (name) {
      var nm = name || 'count';
      return df(groups.map(function (x) { var o = {}; o[keyName] = x.key; o[nm] = x.rows.length; return o; }));
    },
    agg: function (spec) { return df(groups.map(function (x) { return __labAgg(x.rows, spec, keyName, x.key); })); },
    map: function (fn) { return df(groups.map(function (x, i) { return fn(x.rows, x.key, i); })); },
    filter: function (fn) { return __labGroupFrom(groups.filter(function (x) { return fn(x.rows, x.key); }), keyName); },
    toArray: function () { return groups.map(function (x) { return { key: x.key, count: x.rows.length, rows: x.rows }; }); },
    get: function (k) { var e = map[String(k)]; return df(e ? e.rows : []); }
  };
  return g;
}

function __labGroupFrom(groups, keyName) {
  var rows = [];
  groups.forEach(function (g) { rows = rows.concat(g.rows); });
  return __labGroup(rows, keyName);
}

function df(input) {
  var rows = __labToRows(input).slice();
  var api = {};
  api.__isDf = true;
  api.rows = rows;
  api.length = rows.length;
  api.count = function () { return rows.length; };
  api.toArray = function () { return rows.slice(); };
  api.at = function (i) { return rows[i < 0 ? rows.length + i : i]; };
  api.filter = function (fn) { return df(rows.filter(fn)); };
  api.map = function (fn) { return df(rows.map(fn)); };
  api.forEach = function (fn) { rows.forEach(fn); return api; };
  api.slice = function (a, b) { return df(rows.slice(a, b)); };
  api.head = function (n) { return df(rows.slice(0, n === undefined ? 10 : n)); };
  api.tail = function (n) { return df(rows.slice(Math.max(0, rows.length - (n === undefined ? 10 : n)))); };
  api.limit = api.head;
  api.concat = function (other) { return df(rows.concat(__labToRows(other))); };
  api.reduce = function (fn, init) { return rows.reduce(fn, init); };
  api.columns = function () { return __labColumns(rows); };
  api.column = function (k) { return rows.map(function (r) { return r ? r[k] : undefined; }); };
  api.values = api.column;
  api.sortBy = function (key, dir) {
    var sign = (dir === 'desc' || dir === -1) ? -1 : 1;
    var get = typeof key === 'function' ? key : function (r) { return r ? r[key] : undefined; };
    var copy = rows.slice();
    copy.sort(function (a, b) {
      var x = get(a), y = get(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      var sx = String(x), sy = String(y);
      return sx < sy ? -sign : (sx > sy ? sign : 0);
    });
    return df(copy);
  };
  api.pick = function (cols) {
    cols = Array.isArray(cols) ? cols : Array.prototype.slice.call(arguments);
    return df(rows.map(function (r) { var o = {}; cols.forEach(function (c) { o[c] = r ? r[c] : undefined; }); return o; }));
  };
  api.drop = function (cols) {
    cols = Array.isArray(cols) ? cols : Array.prototype.slice.call(arguments);
    return df(rows.map(function (r) {
      var o = {};
      Object.keys(r || {}).forEach(function (k) { if (cols.indexOf(k) < 0) o[k] = r[k]; });
      return o;
    }));
  };
  api.rename = function (mapObj) {
    return df(rows.map(function (r) {
      var o = {};
      Object.keys(r || {}).forEach(function (k) { o[mapObj[k] || k] = r[k]; });
      return o;
    }));
  };
  api.assign = function (spec) {
    return df(rows.map(function (r, i) {
      var o = Object.assign({}, r);
      Object.keys(spec).forEach(function (k) { o[k] = typeof spec[k] === 'function' ? spec[k](r, i) : spec[k]; });
      return o;
    }));
  };
  api.distinct = function (key) {
    var seen = Object.create(null), out = [];
    rows.forEach(function (r) {
      var k = key === undefined ? __labStringify(r) : String(__labKeyOf(r, key));
      if (!seen[k]) { seen[k] = 1; out.push(r); }
    });
    return df(out);
  };
  api.groupBy = function (key) { return __labGroup(rows, key); };
  api.agg = function (spec) { return df([__labAgg(rows, spec, null, null)]); };
  api.join = function (other, leftKey, rightKey, opts) {
    opts = opts || {};
    var how = opts.how || 'inner';
    var rr = __labToRows(other);
    var rk = rightKey || leftKey;
    var idx = Object.create(null);
    rr.forEach(function (r) { var k = String(r ? r[rk] : undefined); (idx[k] || (idx[k] = [])).push(r); });
    var out = [];
    rows.forEach(function (l) {
      var m = idx[String(l ? l[leftKey] : undefined)];
      if (m && m.length) m.forEach(function (r) { out.push(Object.assign({}, r, l)); });
      else if (how === 'left') out.push(Object.assign({}, l));
    });
    return df(out);
  };
  api.describe = function () {
    var cols = __labColumns(rows);
    return df(cols.map(function (c) {
      var vals = rows.map(function (r) { return r ? r[c] : undefined; });
      var nonNull = vals.filter(function (v) { return v !== null && v !== undefined && v !== ''; });
      var nv = __labNums(nonNull);
      var o = { column: c, count: nonNull.length, missing: rows.length - nonNull.length };
      if (nv.length && nv.length >= Math.ceil(nonNull.length * 0.6)) {
        o.type = 'number';
        o.mean = __labRound(stats.mean(nv));
        o.std = __labRound(stats.stdev(nv));
        o.min = stats.min(nv);
        o.p25 = __labRound(stats.quantile(nv, 0.25));
        o.median = __labRound(stats.median(nv));
        o.p75 = __labRound(stats.quantile(nv, 0.75));
        o.max = stats.max(nv);
      } else {
        o.type = 'string';
        var freq = Object.create(null), top = null, topN = 0, uniq = 0;
        nonNull.forEach(function (v) {
          var k = String(v);
          if (!freq[k]) { freq[k] = 0; uniq++; }
          freq[k]++;
          if (freq[k] > topN) { topN = freq[k]; top = k; }
        });
        o.unique = uniq; o.top = top; o.topCount = topN;
      }
      return o;
    }));
  };
  api.toCSV = function (o) { return csv.stringify(rows, o); };
  api.toJSON = function () { return rows; };
  return api;
}

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

/* ------------------------------------------------------------------- plot -- */

function __labNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}
function __labIsNumericCol(rows, c) {
  var n = 0, tot = 0;
  for (var i = 0; i < Math.min(rows.length, 50); i++) {
    var v = rows[i] ? rows[i][c] : undefined;
    if (v === null || v === undefined || v === '') continue;
    tot++;
    if (__labNum(v) !== null) n++;
  }
  return tot > 0 && n >= Math.ceil(tot * 0.8);
}
function __labLabel(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return __labClip(__labStringify(v) || '', 40);
  return String(v);
}

function __labChart(type, data, opts) {
  opts = opts || {};
  if (data && data.__isDf) data = data.rows;
  if (data && data.__isGroup) data = data.toArray();
  var spec = { __labChart: true, type: type, data: { labels: [], datasets: [] }, options: {} };
  var arr = Array.isArray(data) ? data : [];

  if (data && !Array.isArray(data) && typeof data === 'object' && data.datasets) {
    spec.data = { labels: data.labels || [], datasets: data.datasets };
  } else if (type === 'scatter') {
    var pts;
    if (arr.length && Array.isArray(arr[0])) {
      pts = arr.map(function (p) { return { x: __labNum(p[0]), y: __labNum(p[1]) }; });
    } else if (arr.length && typeof arr[0] === 'object') {
      var sx = opts.x || 'x', sy = opts.y || 'y';
      pts = arr.map(function (r) { return { x: __labNum(r[sx]), y: __labNum(r[sy]) }; });
      spec.options.xLabel = opts.xLabel || sx;
      spec.options.yLabel = opts.yLabel || sy;
    } else {
      pts = arr.map(function (v, i) { return { x: i, y: __labNum(v) }; });
    }
    spec.data.datasets = [{ label: opts.label || 'points', data: pts }];
  } else if (arr.length && (typeof arr[0] === 'number' || typeof arr[0] === 'boolean')) {
    spec.data.labels = (opts.labels || arr.map(function (_, i) { return String(i); })).map(__labLabel);
    spec.data.datasets = [{ label: opts.label || 'value', data: arr.map(__labNum) }];
  } else if (arr.length && Array.isArray(arr[0])) {
    spec.data.labels = arr.map(function (p) { return __labLabel(p[0]); });
    spec.data.datasets = [{ label: opts.label || 'value', data: arr.map(function (p) { return __labNum(p[1]); }) }];
  } else if (arr.length) {
    var cols = __labColumns(arr);
    var xKey = opts.x || opts.label;
    if (!xKey) {
      for (var i = 0; i < cols.length; i++) { if (!__labIsNumericCol(arr, cols[i])) { xKey = cols[i]; break; } }
      if (!xKey) xKey = cols[0];
    }
    var yKeys = opts.y ? (Array.isArray(opts.y) ? opts.y : [opts.y]) : cols.filter(function (c) { return c !== xKey && __labIsNumericCol(arr, c); });
    if (!yKeys.length) yKeys = cols.filter(function (c) { return c !== xKey; }).slice(0, 1);
    spec.data.labels = arr.map(function (r) { return __labLabel(r ? r[xKey] : ''); });
    spec.data.datasets = yKeys.map(function (k) {
      return { label: String(k), data: arr.map(function (r) { return __labNum(r ? r[k] : null); }) };
    });
    spec.options.xLabel = opts.xLabel || String(xKey);
    spec.options.yLabel = opts.yLabel || (yKeys.length === 1 ? String(yKeys[0]) : '');
  }

  spec.options.title = opts.title || '';
  if (opts.xLabel) spec.options.xLabel = opts.xLabel;
  if (opts.yLabel) spec.options.yLabel = opts.yLabel;
  spec.options.stacked = !!opts.stacked;
  spec.options.horizontal = !!opts.horizontal;
  spec.options.fill = !!opts.fill;
  spec.options.legend = opts.legend !== false;
  spec.options.height = opts.height || 300;
  spec.options.colors = opts.colors || null;
  spec.options.beginAtZero = opts.beginAtZero !== false;
  __labS.lastChart = spec;
  return spec;
}

var plot = {
  line: function (d, o) { return __labChart('line', d, o); },
  area: function (d, o) { return __labChart('line', d, Object.assign({ fill: true }, o || {})); },
  bar: function (d, o) { return __labChart('bar', d, o); },
  barh: function (d, o) { return __labChart('bar', d, Object.assign({ horizontal: true }, o || {})); },
  scatter: function (d, o) { return __labChart('scatter', d, o); },
  pie: function (d, o) { return __labChart('pie', d, o); },
  doughnut: function (d, o) { return __labChart('doughnut', d, o); },
  hist: function (d, o) {
    o = o || {};
    var h = stats.histogram(Array.isArray(d) ? d : __labToRows(d), o.bins || 10);
    return __labChart('bar', h, Object.assign({ x: 'bin', y: 'count' }, o));
  },
  toPNG: function (spec, opts) {
    var s = (spec && spec.__labChart) ? spec : __labS.lastChart;
    if (!s) throw new Error('plot.toPNG: no chart to render (make one with plot.bar/line/... first)');
    return __labBridge('chart.png', [s, opts || null]);
  },
  save: function (spec, path, opts) {
    var s = (spec && spec.__labChart) ? spec : __labS.lastChart;
    if (!s) throw new Error('plot.save: no chart to render (make one with plot.bar/line/... first)');
    if (typeof spec === 'string') { path = spec; }
    return __labBridge('chart.save', [s, path || null, opts || null]);
  }
};

/* ----------------------------------------------------------------- encode -- */

function __labCell(v) {
  if (v === null || v === undefined) return null;
  var t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') {
    if (t === 'string' && v.length > __labLIM.maxCellChars) return v.slice(0, __labLIM.maxCellChars) + '…';
    return v;
  }
  if (v instanceof Date) return v.toISOString();
  return __labClip(__labStringify(v) || String(v), __labLIM.maxCellChars);
}

function __labEncode(v) {
  if (v === undefined) return null;
  if (v && v.__labChart) return { kind: 'chart', spec: v };
  if (typeof v === 'string') {
    if (/^data:image\//.test(v)) return { kind: 'image', src: v };
    var tr = v.length > __labLIM.maxStringChars;
    return { kind: 'text', text: tr ? v.slice(0, __labLIM.maxStringChars) + '…' : v, truncated: tr };
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return { kind: 'text', text: String(v) };
  }
  if (v instanceof Error) return { kind: 'error', name: v.name, message: v.message, stack: String(v.stack || '') };
  if (typeof v === 'function') return { kind: 'text', text: '[Function ' + (v.name || 'anonymous') + ']' };
  if (v instanceof Date) return { kind: 'text', text: v.toISOString() };

  var rows = null;
  if (v.__isDf) rows = v.rows;
  else if (v.__isGroup) rows = v.count().rows;
  else if (Array.isArray(v)) rows = v;

  if (rows && rows.length > 0 && __labIsTabular(rows)) {
    var cols = __labColumns(rows);
    var shown = rows.slice(0, __labLIM.maxRows);
    return {
      kind: 'table',
      columns: cols,
      rows: shown.map(function (r) { return cols.map(function (c) { return __labCell(r ? r[c] : undefined); }); }),
      totalRows: rows.length,
      truncated: rows.length > shown.length
    };
  }
  if (rows && rows.length === 0) return { kind: 'table', columns: [], rows: [], totalRows: 0, truncated: false };

  var s = __labStringify(rows || v, 2) || String(v);
  var big = s.length > __labLIM.maxJsonBytes;
  return { kind: 'json', json: big ? s.slice(0, __labLIM.maxJsonBytes) : s, truncated: big };
}

function show(x) {
  var p = __labEncode(x);
  __labS.parts.push(p || { kind: 'text', text: 'undefined' });
  return undefined;
}
function md(text) { __labS.parts.push({ kind: 'markdown', text: String(text) }); return undefined; }

/* ----------------------------------------------------- agent-facing result -- */

function __labShape(v) {
  if (Array.isArray(v)) return { type: 'array', length: v.length };
  if (v && typeof v === 'object') return { type: 'object', keys: Object.keys(v).slice(0, 60), keyCount: Object.keys(v).length };
  return { type: typeof v };
}

function __labFit(v, budget) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'string' && v.length > budget) return v.slice(0, Math.max(24, budget)) + '…';
    if (typeof v === 'bigint') return String(v);
    return v;
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) {
    var out = [], used = 2, sub = Math.max(64, Math.floor(budget / 4));
    for (var i = 0; i < v.length; i++) {
      var e = __labFit(v[i], sub);
      var s = __labStringify(e) || 'null';
      if (used + s.length > budget && out.length > 0) { out.push('… ' + (v.length - i) + ' more of ' + v.length); break; }
      out.push(e); used += s.length + 1;
    }
    return out;
  }
  var o = {}, used2 = 2, keys = Object.keys(v), sub2 = Math.max(64, Math.floor(budget / 4));
  for (var k = 0; k < keys.length; k++) {
    var e2 = __labFit(v[keys[k]], sub2);
    var s2 = __labStringify(e2) || 'null';
    if (used2 + s2.length + keys[k].length > budget && k > 0) {
      o['__truncated'] = (keys.length - k) + ' more keys of ' + keys.length;
      break;
    }
    o[keys[k]] = e2; used2 += s2.length + keys[k].length + 4;
  }
  return o;
}

function __labAgentResult(v, limit) {
  limit = limit || 8192;
  if (v === undefined) return { result: null, resultType: 'none', truncated: false };
  if (v && v.__labChart) {
    return {
      result: {
        chartType: v.type,
        title: v.options.title || null,
        series: v.data.datasets.map(function (d) { return { label: d.label, points: (d.data || []).length }; }),
        labels: (v.data.labels || []).slice(0, 20)
      },
      resultType: 'chart', truncated: false
    };
  }
  if (v instanceof Error) return { result: { name: v.name, message: v.message }, resultType: 'error', truncated: false };
  if (typeof v === 'function') return { result: '[Function ' + (v.name || 'anonymous') + ']', resultType: 'function', truncated: false };
  if (typeof v === 'string') {
    if (/^data:image\//.test(v)) return { result: v.slice(0, 64) + '…', resultType: 'image', truncated: true, shape: { bytes: v.length } };
    var tr = v.length > limit;
    return { result: tr ? v.slice(0, limit) + '…' : v, resultType: 'string', truncated: tr, shape: tr ? { length: v.length } : undefined };
  }
  if (v === null) return { result: null, resultType: 'null', truncated: false };
  if (typeof v === 'number' || typeof v === 'boolean') return { result: v, resultType: typeof v, truncated: false };
  if (typeof v === 'bigint') return { result: String(v), resultType: 'bigint', truncated: false };

  var rows = v.__isDf ? v.rows : (v.__isGroup ? v.count().rows : v);
  if (Array.isArray(rows) && rows.length > 0 && __labIsTabular(rows)) {
    var cols = __labColumns(rows);
    var sample = [], used = 0;
    for (var i = 0; i < rows.length; i++) {
      var s = __labStringify(__labFit(rows[i], Math.max(200, Math.floor(limit / 4)))) || 'null';
      if (used + s.length > limit && sample.length > 0) break;
      sample.push(JSON.parse(s)); used += s.length + 1;
    }
    return {
      result: { rowCount: rows.length, columns: cols, rows: sample },
      resultType: 'table',
      truncated: sample.length < rows.length,
      shape: { rows: rows.length, columns: cols.length, sampled: sample.length }
    };
  }

  var full = __labStringify(rows) || 'null';
  if (full.length <= limit) {
    return { result: JSON.parse(full), resultType: Array.isArray(rows) ? 'array' : 'object', truncated: false };
  }
  var fitted = __labFit(rows, limit);
  return {
    result: JSON.parse(__labStringify(fitted) || 'null'),
    resultType: Array.isArray(rows) ? 'array' : 'object',
    truncated: true,
    shape: __labShape(rows)
  };
}

/* -------------------------------------------------------- source transform -- */

var __labKW = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];

function __labScan(src) {
  var n = src.length;
  var depth = new Array(n), code = new Array(n);
  var d = 0, i = 0;

  function fill(a, b, dd, isCode) { for (var k = a; k < b; k++) { depth[k] = dd; code[k] = isCode; } }

  function skipQuoted(start) {
    var q = src.charAt(start), j = start + 1;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') return j;
      j++;
      if (ch === q) break;
    }
    return j;
  }
  function skipTemplate(start) {
    var j = start + 1;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === String.fromCharCode(96)) return j + 1;
      if (ch === '$' && src.charAt(j + 1) === '{') {
        var k = j + 2, bd = 1;
        while (k < n && bd > 0) {
          var c2 = src.charAt(k);
          if (c2 === '\\') { k += 2; continue; }
          if (c2 === String.fromCharCode(96)) { k = skipTemplate(k); continue; }
          if (c2 === '"' || c2 === "'") { k = skipQuoted(k); continue; }
          if (c2 === '{') bd++;
          else if (c2 === '}') bd--;
          k++;
        }
        j = k; continue;
      }
      j++;
    }
    return n;
  }
  function regexAllowed(at) {
    var j = at - 1;
    while (j >= 0 && /\s/.test(src.charAt(j))) j--;
    if (j < 0) return true;
    var ch = src.charAt(j);
    if (ch === ')' || ch === ']') return false;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      var e = j + 1;
      while (j >= 0 && /[A-Za-z0-9_$]/.test(src.charAt(j))) j--;
      var word = src.slice(j + 1, e);
      return __labKW.indexOf(word) >= 0;
    }
    return true;
  }
  function skipRegex(start) {
    var j = start + 1, inClass = false;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') return j;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { j++; break; }
      j++;
    }
    while (j < n && /[a-z]/i.test(src.charAt(j))) j++;
    return j;
  }

  while (i < n) {
    var c = src.charAt(i), c2 = src.charAt(i + 1), j;
    if (c === '/' && c2 === '/') { j = src.indexOf('\n', i); if (j < 0) j = n; fill(i, j, d, 0); i = j; continue; }
    if (c === '/' && c2 === '*') { j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; fill(i, j, d, 0); i = j; continue; }
    if (c === String.fromCharCode(96)) { j = skipTemplate(i); fill(i, j, d, 0); i = j; continue; }
    if (c === '"' || c === "'") { j = skipQuoted(i); fill(i, j, d, 0); i = j; continue; }
    if (c === '/' && regexAllowed(i)) { j = skipRegex(i); fill(i, j, d, 0); i = j; continue; }
    if (c === '{' || c === '(' || c === '[') { depth[i] = d; code[i] = 1; d++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { d--; if (d < 0) d = 0; depth[i] = d; code[i] = 1; i++; continue; }
    depth[i] = d; code[i] = 1; i++;
  }
  return { depth: depth, code: code };
}

function __labCompiles(body) {
  try { new __labAF(body); return true; } catch (e) { return false; }
}

function __labStmtStart(src, sc, at) {
  var j = at - 1;
  var sawNewline = false;
  while (j >= 0) {
    var ch = src.charAt(j);
    if (!sc.code[j]) {
      if (ch === '\n') sawNewline = true;
      j--; continue;
    }
    if (/\s/.test(ch)) { if (ch === '\n') sawNewline = true; j--; continue; }
    break;
  }
  if (j < 0) return true;
  var p = src.charAt(j);
  if (p === ';' || p === '}' || p === '{') return true;
  return sawNewline;
}

function __labHoist(src) {
  var sc = __labScan(src);
  var edits = [];
  var names = [];
  var re = /(^|[^A-Za-z0-9_$.])(const|let|var|function|class|async)(?![A-Za-z0-9_$])/g;
  var m;
  var declStarts = [];
  while ((m = re.exec(src)) !== null) {
    var at = m.index + m[1].length;
    if (!sc.code[at] || sc.depth[at] !== 0) continue;
    if (!__labStmtStart(src, sc, at)) continue;
    declStarts.push(at);
  }
  function nextDeclAfter(pos) {
    for (var i = 0; i < declStarts.length; i++) if (declStarts[i] > pos) return declStarts[i];
    return src.length;
  }

  for (var di = 0; di < declStarts.length; di++) {
    var at = declStarts[di];
    var rest = src.slice(at);
    var kwm = /^(const|let|var|function|class|async)/.exec(rest);
    if (!kwm) continue;
    var kw = kwm[1];
    var after = at + kw.length;

    if (kw === 'async') {
      var am = /^\s*function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(src.slice(after));
      if (am) names.push(am[1]);
      continue;
    }
    if (kw === 'function' || kw === 'class') {
      var fm = /^\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(src.slice(after));
      if (fm) names.push(fm[1]);
      continue;
    }

    var bm = /^(\s*)([A-Za-z_$\[{])/.exec(src.slice(after));
    if (!bm) continue;

    var limit = Math.min(nextDeclAfter(at), src.length);
    var end = limit, sawEq = false;
    for (var p = after; p < limit; p++) {
      if (!sc.code[p] || sc.depth[p] !== 0) continue;
      var ch = src.charAt(p);
      if (ch === ';') { end = p; break; }
      if (ch === '=' && src.charAt(p + 1) !== '=' && src.charAt(p + 1) !== '>' &&
          '=!<>+-*/%&|^'.indexOf(src.charAt(p - 1)) < 0) { sawEq = true; }
      if (ch === '\n' && sawEq) { end = p; break; }
    }

    if (bm[2] === '[' || bm[2] === '{') {
      edits.push({ pos: at, len: kw.length, text: ';(' });
      edits.push({ pos: end, len: 0, text: ')' });
    } else if (sawEq) {
      edits.push({ pos: at, len: kw.length, text: '' });
    } else {
      edits.push({ pos: at, len: kw.length, text: 'globalThis.' });
    }
  }

  edits.sort(function (a, b) { return b.pos - a.pos || b.len - a.len; });
  var out = src;
  for (var ei = 0; ei < edits.length; ei++) {
    var e = edits[ei];
    out = out.slice(0, e.pos) + e.text + out.slice(e.pos + e.len);
  }

  var assigns = names.length
    ? '\n' + names.map(function (nm) { return 'try { globalThis[' + JSON.stringify(nm) + '] = ' + nm + '; } catch (__e) {}'; }).join('\n') + '\n'
    : '';

  if (!__labCompiles(out + assigns)) return { body: src, assigns: '' };
  return { body: out, assigns: assigns };
}

function __labSplitTail(src) {
  var sc = __labScan(src);
  var cands = [0];
  for (var i = 0; i < src.length; i++) {
    if (!sc.code[i] || sc.depth[i] !== 0) continue;
    var ch = src.charAt(i);
    if (ch === ';' || ch === '\n' || ch === '}') cands.push(i + 1);
  }
  var start = Math.max(0, cands.length - 120);
  for (var k = cands.length - 1; k >= start; k--) {
    var p = cands[k];
    var head = src.slice(0, p);
    var tail = src.slice(p).replace(/\s+$/, '').replace(/;+$/, '');
    if (!tail.trim()) continue;
    // A trailing function/class DECLARATION must not become the tail expression.
    // It compiles fine as one -- but as a named function *expression* the name binds
    // only inside itself, so __labHoist's "globalThis.f = f" (emitted ahead of the
    // return) throws ReferenceError into its own catch and the binding is silently
    // lost. A cell holding just a helper definition is the common case, so this
    // costs a REPL value nobody wanted and buys declarations that persist.
    if (/^\s*(async\s+function\b|function\b|class\b)/.test(tail)) continue;
    if (!__labCompiles('return (' + tail + '\n);')) continue;
    if (p > 0 && !__labCompiles(head)) continue;
    return { head: head, tail: tail };
  }
  return { head: src, tail: null };
}

function __labTransform(code) {
  var h = __labHoist(code);
  var sp = __labSplitTail(h.body);
  var body = sp.head + h.assigns;
  if (sp.tail !== null) body += '\nreturn (' + sp.tail + '\n);';
  if (!__labCompiles(body)) {
    body = h.body + h.assigns;
    if (!__labCompiles(body)) body = code;
  }
  return body;
}

/* ---------------------------------------------------------------- run loop -- */

function __labErrorInfo(e) {
  if (e instanceof Error) {
    // Strip the "eval at ... (blob:...)" wrapper V8 adds around Function-constructor
    // code, and shift line numbers back by the two lines the AsyncFunction header
    // occupies so positions roughly match the cell source.
    var stack = String(e.stack || '')
      .replace(/\(eval at [^,]*, /g, '(')
      .replace(/<anonymous>:([0-9]+):([0-9]+)/g, function (m, l, c) {
        return 'cell:' + Math.max(1, Number(l) - 2) + ':' + c;
      });
    var lines = stack.split('\n').filter(function (l) {
      return l.indexOf('__lab') < 0 && l.indexOf('blob:') < 0;
    });
    return { name: e.name || 'Error', message: e.message || String(e), stack: lines.slice(0, 12).join('\n') };
  }
  return { name: 'Error', message: __labFmt(e), stack: '' };
}

async function __labRun(msg) {
  __labS.logs = [];
  __labS.parts = [];
  var t0 = Date.now();
  var out = { type: 'result', runId: msg.runId, ok: true, logs: [], parts: [], durationMs: 0 };
  var value;
  try {
    var body = __labTransform(String(msg.code == null ? '' : msg.code));
    var fn = new __labAF(body);
    value = await fn();
    if (value && typeof value.then === 'function') value = await value;
  } catch (e) {
    out.ok = false;
    out.error = __labErrorInfo(e);
  }

  if (out.ok && msg.saveResultTo) {
    try {
      var payload = (value && value.__isDf) ? value.rows : value;
      await store.write(msg.saveResultTo, payload === undefined ? null : payload);
      out.savedTo = msg.saveResultTo;
    } catch (e2) {
      out.saveError = __labFmt(e2);
    }
  }

  try {
    if (out.ok) {
      var enc = __labEncode(value);
      if (enc) __labS.parts.push(enc);
    }
  } catch (e3) {
    __labS.parts.push({ kind: 'text', text: 'output encode failed: ' + __labFmt(e3) });
  }

  out.logs = __labS.logs;
  out.parts = msg.agent ? [] : __labS.parts;
  out.hasChart = __labS.parts.some(function (p) { return p && p.kind === 'chart'; });
  out.durationMs = Date.now() - t0;

  if (msg.agent) {
    try {
      var ar = out.ok ? __labAgentResult(value, msg.resultLimit) : { result: null, resultType: 'none', truncated: false };
      out.agent = ar;
    } catch (e4) {
      out.agent = { result: null, resultType: 'none', truncated: false, note: 'summary failed: ' + __labFmt(e4) };
    }
  }

  self.postMessage(out);
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg) return;
  if (msg.type === 'bridgeResult') {
    var p = __labS.pending[msg.callId];
    if (!p) return;
    delete __labS.pending[msg.callId];
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error || 'bridge call failed'));
    return;
  }
  if (msg.type === 'run') { __labRun(msg); return; }
};

self.onerror = function (e) {
  try { console.error('worker error: ' + (e && e.message ? e.message : String(e))); } catch (x) {}
};

self.df = df; self.csv = csv; self.stats = stats; self.plot = plot;
self.store = store; self.http = http; self.show = show; self.md = md; self.sleep = sleep;

self.postMessage({ type: 'ready' });
`;
