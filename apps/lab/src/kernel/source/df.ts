// KERNEL PART 5/12 — the `df` mini dataframe: rows, columns, groupBy, agg.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const DF = String.raw`
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
`;