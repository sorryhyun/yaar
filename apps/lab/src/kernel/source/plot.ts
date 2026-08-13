// KERNEL PART 7/12 — the `plot` helper: chart specs the main thread renders.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const PLOT = String.raw`
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
`;