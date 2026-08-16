// Canvas drawing for a graph spec: grid, axes, ticks, then one pass per series.
// Pure with respect to app state — the interactive view and the offscreen PNG
// exporter both call drawGraph with their own context, size and viewport.

import { buildExpr, sliderVars, type Compiled, type Scope } from './compile';
import {
  makeTransform,
  niceStep,
  sampleExplicit,
  sampleImplicit,
  sampleParam,
  type Poly,
  type View,
} from './sample';
import type { GraphSpec, GraphSeries } from '../types';

export interface GraphTheme {
  bg: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  text: string;
  palette: string[];
}

/** Matches the chart palette in lib/chart-config.ts so both outputs look related. */
export const DARK_THEME: GraphTheme = {
  bg: '#1c2128',
  gridMinor: '#22272e',
  gridMajor: '#2d333b',
  axis: '#636e7b',
  text: '#768390',
  palette: ['#539bf5', '#e5534b', '#57ab5a', '#c69026', '#986ee2', '#4cc9c0', '#f778ba', '#6cb6ff'],
};

/** One series, compiled and ready to draw (or carrying the parse error instead). */
export interface SeriesPlan {
  series: GraphSeries;
  compiled: Compiled | null;
  error: string | null;
  color: string;
  label: string;
  resample: boolean;
}

/** Short name for the curve form, shown in the legend tooltip. */
export function formLabel(c: Compiled | null): string {
  if (!c) return '';
  return c.type === 'explicitX' ? 'x=f(y)' : c.type;
}

/** Compile every string series once. Callers memoize this and reuse it while panning. */
export function planSeries(spec: GraphSpec, theme: GraphTheme = DARK_THEME): SeriesPlan[] {
  const opts = spec.options || {};
  const palette = opts.colors && opts.colors.length ? opts.colors : theme.palette;
  return (spec.series || []).map((s, i) => {
    const color = s.color || palette[i % palette.length];
    let compiled: Compiled | null = null;
    let error: string | null = null;
    if (s.expr) {
      try {
        compiled = buildExpr(s.expr);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const label =
      s.label || s.expr || (s.points ? 'points (' + s.points.length + ')' : 'series ' + (i + 1));
    return { series: s, compiled, error, color, label, resample: s.resample !== false && !!s.expr };
  });
}

/**
 * The parameter set a graph starts with: whatever the spec named, plus every free
 * variable the expressions introduced, defaulted to 1. This is what the sliders
 * bind to and what a PNG export draws with.
 */
export function defaultParams(spec: GraphSpec, plans: SeriesPlan[]): Record<string, number> {
  const out: Record<string, number> = { ...((spec.options && spec.options.params) || {}) };
  for (const v of sliderVars(plans.map((p) => p.compiled))) {
    if (typeof out[v] !== 'number' || !isFinite(out[v])) out[v] = 1;
  }
  return out;
}

/** Free-variable values for a draw, with anything missing defaulted to 1. */
export function scopeFor(params: Record<string, number>): Scope {
  const s: Scope = {};
  for (const k of Object.keys(params || {})) {
    const v = params[k];
    if (typeof v === 'number' && isFinite(v)) s[k] = v;
  }
  return s;
}

function strokePolys(ctx: CanvasRenderingContext2D, polys: Poly[]): void {
  ctx.beginPath();
  for (const p of polys) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[i], p[i + 1]);
    }
  }
  ctx.stroke();
}

/** Draw the whole graph into `ctx`, which must already be scaled to CSS pixels. */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  spec: GraphSpec,
  plans: SeriesPlan[],
  view: View,
  params: Record<string, number>,
  theme: GraphTheme = DARK_THEME,
): void {
  const opts = spec.options || {};
  const tr = makeTransform(view, W, H);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  if (W < 4 || H < 4) return;

  const stepX = niceStep(80 / view.sx);
  const stepY = niceStep(80 / view.sy);
  const x0 = tr.ux(0),
    x1 = tr.ux(W);
  const y0 = tr.uy(H),
    y1 = tr.uy(0);
  const showGrid = opts.grid !== false;
  ctx.lineWidth = 1;

  if (showGrid) {
    const subX = stepX / 5,
      subY = stepY / 5;
    ctx.strokeStyle = theme.gridMinor;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / subX) * subX; x < x1; x += subX) {
      const px = Math.round(tr.px(x)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
    }
    for (let y = Math.ceil(y0 / subY) * subY; y < y1; y += subY) {
      const py = Math.round(tr.py(y)) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
    }
    ctx.stroke();

    ctx.strokeStyle = theme.gridMajor;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / stepX) * stepX; x < x1; x += stepX) {
      const px = Math.round(tr.px(x)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
    }
    for (let y = Math.ceil(y0 / stepY) * stepY; y < y1; y += stepY) {
      const py = Math.round(tr.py(y)) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
    }
    ctx.stroke();
  }

  const ax = Math.round(tr.px(0)) + 0.5;
  const ay = Math.round(tr.py(0)) + 0.5;
  ctx.strokeStyle = theme.axis;
  ctx.beginPath();
  ctx.moveTo(ax, 0);
  ctx.lineTo(ax, H);
  ctx.moveTo(0, ay);
  ctx.lineTo(W, ay);
  ctx.stroke();

  ctx.fillStyle = theme.text;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const decX = Math.max(0, Math.min(8, -Math.floor(Math.log10(stepX))));
  const decY = Math.max(0, Math.min(8, -Math.floor(Math.log10(stepY))));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let x = Math.ceil(x0 / stepX) * stepX; x < x1; x += stepX) {
    if (Math.abs(x) < stepX / 2) continue;
    ctx.fillText(x.toFixed(decX), tr.px(x), Math.min(Math.max(ay + 4, 4), H - 16));
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = Math.ceil(y0 / stepY) * stepY; y < y1; y += stepY) {
    if (Math.abs(y) < stepY / 2) continue;
    ctx.fillText(y.toFixed(decY), Math.min(Math.max(ax - 6, 34), W - 4), tr.py(y));
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const plan of plans) {
    ctx.strokeStyle = plan.color;
    ctx.lineWidth = 2;
    const c = plan.compiled;
    if (c) {
      const s = scopeFor(params);
      const tMin = typeof plan.series.tMin === 'number' ? plan.series.tMin : 0;
      const tMax = typeof plan.series.tMax === 'number' ? plan.series.tMax : Math.PI * 2;
      if (c.type === 'explicit' || c.type === 'explicitX')
        strokePolys(ctx, sampleExplicit(c, s, tr, W, H));
      else if (c.type === 'param' || c.type === 'polar')
        strokePolys(ctx, sampleParam(c, s, tr, tMin, tMax, 2000));
      else if (c.type === 'implicit') strokePolys(ctx, sampleImplicit(c, s, tr, W, H, 5));
      continue;
    }
    const pts = plan.series.points;
    if (pts && pts.length) {
      // Eagerly sampled in the worker (a JS function input): a polyline, drawn as
      // given. Zooming magnifies it; it is not re-sampled. Nulls are breaks.
      const polys: Poly[] = [];
      let cur: Poly = [];
      for (const p of pts) {
        if (!p || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) {
          if (cur.length >= 4) polys.push(cur);
          cur = [];
          continue;
        }
        cur.push(tr.px(p[0]), tr.py(p[1]));
      }
      if (cur.length >= 4) polys.push(cur);
      strokePolys(ctx, polys);
    }
  }

  if (opts.title) {
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = theme.bg;
    const w = ctx.measureText(opts.title).width;
    ctx.fillRect(6, 6, w + 10, 18);
    ctx.fillStyle = theme.text;
    ctx.fillText(opts.title, 11, 10);
  }
}
