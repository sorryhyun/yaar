// KERNEL PART 8/12 — the `graph` helper: function-graph specs the window renders
// interactively. Fragment of the worker source; see ../source.ts for the
// String.raw rules (no backticks, no dollar-brace, not type checked).
//
// The design constraint: a spec must survive structured clone to the window, so a
// series is either an expression STRING (compiled in the renderer, re-sampled on
// zoom) or an eagerly sampled POINT array (all a JS closure can become).
export const GRAPH = String.raw`
/* ------------------------------------------------------------------ graph -- */

function __labGraphSample(fn, xMin, xMax, n) {
  var pts = [];
  for (var i = 0; i <= n; i++) {
    var x = xMin + (xMax - xMin) * i / n;
    var y;
    try { y = fn(x); } catch (e) { y = NaN; }
    if (typeof y !== 'number' || !isFinite(y)) pts.push(null);
    else pts.push([x, y]);
  }
  return pts;
}

function __labGraphPoint(p) {
  if (p === null || p === undefined) return null;
  var x, y;
  if (Array.isArray(p)) { x = Number(p[0]); y = Number(p[1]); }
  else if (typeof p === 'object') { x = Number(p.x); y = Number(p.y); }
  else return null;
  if (!isFinite(x) || !isFinite(y)) return null;
  return [x, y];
}

function __labGraphOne(it, xMin, xMax, samples) {
  if (typeof it === 'string') {
    if (!it.trim()) throw new Error('graph: empty expression');
    return { expr: it };
  }
  if (typeof it === 'function') {
    return { points: __labGraphSample(it, xMin, xMax, samples), resample: false, label: it.name || 'f(x)' };
  }
  if (it && typeof it === 'object') {
    var o = {};
    if (typeof it.expr === 'string') o.expr = it.expr;
    else if (typeof it.fn === 'function') { o.points = __labGraphSample(it.fn, xMin, xMax, samples); o.resample = false; }
    else if (Array.isArray(it.points)) { o.points = it.points.map(__labGraphPoint); o.resample = false; }
    else throw new Error('graph: a series object needs expr, fn or points');
    if (it.color) o.color = String(it.color);
    if (it.label) o.label = String(it.label);
    if (typeof it.tMin === 'number') o.tMin = it.tMin;
    if (typeof it.tMax === 'number') o.tMax = it.tMax;
    if (o.label === undefined && o.points) o.label = 'points (' + o.points.length + ')';
    return o;
  }
  throw new Error('graph: cannot plot a value of type ' + typeof it);
}

function __labGraphSpec(input, opts) {
  opts = opts || {};
  var xMin = typeof opts.xMin === 'number' ? opts.xMin : -10;
  var xMax = typeof opts.xMax === 'number' ? opts.xMax : 10;
  if (!(xMax > xMin)) throw new Error('graph: xMax must be greater than xMin');
  var samples = Math.max(2, Math.min(20000, opts.samples || 2000));
  var items = Array.isArray(input) ? input : [input];
  if (!items.length) throw new Error('graph: nothing to plot');

  var series = items.map(function (it) { return __labGraphOne(it, xMin, xMax, samples); });

  var params = {};
  if (opts.params && typeof opts.params === 'object') {
    Object.keys(opts.params).forEach(function (k) {
      var v = Number(opts.params[k]);
      if (isFinite(v)) params[k] = v;
    });
  }

  var spec = {
    __labGraph: true,
    series: series,
    options: {
      xMin: xMin,
      xMax: xMax,
      yMin: typeof opts.yMin === 'number' ? opts.yMin : undefined,
      yMax: typeof opts.yMax === 'number' ? opts.yMax : undefined,
      params: params,
      equalAspect: opts.equalAspect === undefined ? undefined : !!opts.equalAspect,
      grid: opts.grid !== false,
      title: opts.title || '',
      height: opts.height || 360,
      colors: opts.colors || null
    }
  };
  __labS.lastGraph = spec;
  return spec;
}

function graph(input, opts) { return __labGraphSpec(input, opts); }

graph.toPNG = function (spec, opts) {
  var s = (spec && spec.__labGraph) ? spec : __labS.lastGraph;
  if (!s) throw new Error('graph.toPNG: no graph to render (make one with graph(...) first)');
  return __labBridge('graph.png', [s, opts || null]);
};

graph.save = function (spec, path, opts) {
  var s = (spec && spec.__labGraph) ? spec : __labS.lastGraph;
  if (!s) throw new Error('graph.save: no graph to render (make one with graph(...) first)');
  if (typeof spec === 'string') { path = spec; }
  return __labBridge('graph.save', [s, path || null, opts || null]);
};
`;
