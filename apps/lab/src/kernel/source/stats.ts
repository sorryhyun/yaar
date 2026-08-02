// KERNEL PART 4/11 — the `stats` helper: descriptive statistics and histograms.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const STATS = String.raw`
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
`;