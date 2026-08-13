// KERNEL PART 10/12 — the runCode result: a byte budget, a row sample and a shape
// summary, so large data never crosses the protocol boundary.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const AGENT_RESULT = String.raw`
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
  if (v && v.__labGraph) {
    return {
      result: {
        title: v.options.title || null,
        xRange: [v.options.xMin, v.options.xMax],
        params: v.options.params || {},
        series: v.series.map(function (s) {
          return s.expr
            ? { expr: s.expr, resample: true }
            : { label: s.label || null, points: (s.points || []).length, resample: false };
        })
      },
      resultType: 'graph', truncated: false
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
`;