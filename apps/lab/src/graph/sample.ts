// Samplers: a compiled expression plus a viewport -> polylines in screen space.
//
// Sampling happens against the *current* viewport, which is the whole point of
// shipping expressions as strings: zooming in re-runs these functions at the new
// scale instead of stretching a frozen point series.

import type { Compiled, Scope } from './compile';
import type { GraphSpec } from '../types';

/** Centre in user units plus pixels-per-unit on each axis. */
export interface View {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
}

/** A polyline, flat: [x0, y0, x1, y1, ...] in CSS pixels. */
export type Poly = number[];

export interface Transform {
  px: (x: number) => number;
  py: (y: number) => number;
  ux: (p: number) => number;
  uy: (p: number) => number;
}

export function makeTransform(view: View, W: number, H: number): Transform {
  return {
    px: (x) => (x - view.cx) * view.sx + W / 2,
    py: (y) => H / 2 - (y - view.cy) * view.sy,
    ux: (p) => (p - W / 2) / view.sx + view.cx,
    uy: (p) => view.cy - (p - H / 2) / view.sy,
  };
}

/** Round a raw spacing up to the nearest 1/2/5 x 10^n. */
export function niceStep(t: number): number {
  if (!(t > 0) || !isFinite(t)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(t)));
  const f = t / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

const DEFAULT_X = 10;

/** The starting viewport for a spec, given the pixel size it will be drawn at. */
export function viewFromSpec(spec: GraphSpec, W: number, H: number): View {
  const o = spec.options || {};
  const xMin = typeof o.xMin === 'number' ? o.xMin : -DEFAULT_X;
  const xMax = typeof o.xMax === 'number' ? o.xMax : DEFAULT_X;
  const spanX = xMax - xMin > 0 ? xMax - xMin : 2 * DEFAULT_X;
  const sx = W / spanX;
  const cx = (xMin + xMax) / 2;

  const hasY = typeof o.yMin === 'number' && typeof o.yMax === 'number' && o.yMax > o.yMin;
  // Equal aspect is the default when the caller did not pin the y range; when they
  // did, honour it unless they asked for equal aspect explicitly.
  const equal = o.equalAspect === true || (o.equalAspect !== false && !hasY);
  if (hasY && !equal) {
    return { cx, cy: (o.yMin! + o.yMax!) / 2, sx, sy: H / (o.yMax! - o.yMin!) };
  }
  return { cx, cy: hasY ? (o.yMin! + o.yMax!) / 2 : 0, sx, sy: sx };
}

/** A viewport straight from user-space bounds — how a panned view is exported. */
export function viewFromBounds(
  b: { xMin: number; xMax: number; yMin: number; yMax: number },
  W: number,
  H: number,
): View {
  const spanX = b.xMax - b.xMin > 0 ? b.xMax - b.xMin : 2 * DEFAULT_X;
  const spanY = b.yMax - b.yMin > 0 ? b.yMax - b.yMin : 2 * DEFAULT_X;
  return { cx: (b.xMin + b.xMax) / 2, cy: (b.yMin + b.yMax) / 2, sx: W / spanX, sy: H / spanY };
}

/** y = f(x) sampled once per pixel column (or x = f(y), once per row). */
export function sampleExplicit(
  c: Compiled & { type: 'explicit' | 'explicitX' },
  scope: Scope,
  tr: Transform,
  W: number,
  H: number,
): Poly[] {
  const horiz = c.type === 'explicit';
  const N = Math.max(2, Math.ceil(horiz ? W : H));
  const out: Poly[] = [];
  let cur: Poly = [];
  let prev: number | null = null;
  const s: Scope = scope;
  for (let i = 0; i <= N; i++) {
    let px: number, py: number;
    if (horiz) {
      s.x = tr.ux(i);
      const y = c.f(s);
      if (!isFinite(y)) {
        if (cur.length >= 4) out.push(cur);
        cur = [];
        prev = null;
        continue;
      }
      px = i;
      py = tr.py(y);
    } else {
      s.y = tr.uy(i);
      const x = c.f(s);
      if (!isFinite(x)) {
        if (cur.length >= 4) out.push(cur);
        cur = [];
        prev = null;
        continue;
      }
      py = i;
      px = tr.px(x);
    }
    // An asymptote shows up as a jump far larger than the canvas: break the
    // polyline there instead of drawing a vertical line through the pole.
    const now = horiz ? py : px;
    if (prev !== null && Math.abs(now - prev) > H * 1.5) {
      if (cur.length >= 4) out.push(cur);
      cur = [];
    }
    cur.push(px, py);
    prev = now;
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

/** (fx(t), fy(t)) and r = f(theta) share one sampler over a t range. */
export function sampleParam(
  c: Compiled & { type: 'param' | 'polar' },
  scope: Scope,
  tr: Transform,
  tMin: number,
  tMax: number,
  steps: number,
): Poly[] {
  const N = Math.max(2, Math.min(20000, Math.round(steps)));
  const out: Poly[] = [];
  let cur: Poly = [];
  const s: Scope = scope;
  for (let i = 0; i <= N; i++) {
    const t = tMin + ((tMax - tMin) * i) / N;
    s.t = t;
    s.theta = t;
    let X: number, Y: number;
    if (c.type === 'param') {
      X = c.fx(s);
      Y = c.fy(s);
    } else {
      const r = c.f(s);
      X = r * Math.cos(t);
      Y = r * Math.sin(t);
    }
    if (!isFinite(X) || !isFinite(Y)) {
      if (cur.length >= 4) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(tr.px(X), tr.py(Y));
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

// Marching squares: which cell edges the contour crosses, per corner sign mask.
// Corners are a=TL, b=TR, c=BR, d=BL; edges T,R,B,L. Saddles (5, 10) emit both.
const CASES: Record<number, string[]> = {
  1: ['L', 'T'],
  2: ['T', 'R'],
  3: ['L', 'R'],
  4: ['R', 'B'],
  5: ['L', 'T', 'R', 'B'],
  6: ['T', 'B'],
  7: ['L', 'B'],
  8: ['L', 'B'],
  9: ['T', 'B'],
  10: ['L', 'T', 'R', 'B'],
  11: ['R', 'B'],
  12: ['L', 'R'],
  13: ['T', 'R'],
  14: ['L', 'T'],
};

/** f(x, y) = 0 over the visible rectangle, as one 2-point polyline per crossing. */
export function sampleImplicit(
  c: Compiled & { type: 'implicit' },
  scope: Scope,
  tr: Transform,
  W: number,
  H: number,
  grid: number,
): Poly[] {
  const g = Math.max(2, grid);
  const nx = Math.ceil(W / g);
  const ny = Math.ceil(H / g);
  if (nx < 1 || ny < 1 || (nx + 1) * (ny + 1) > 4e6) return [];
  const v = new Float64Array((nx + 1) * (ny + 1));
  const s: Scope = scope;
  for (let j = 0; j <= ny; j++) {
    s.y = tr.uy(j * g);
    for (let i = 0; i <= nx; i++) {
      s.x = tr.ux(i * g);
      v[j * (nx + 1) + i] = c.f(s);
    }
  }
  const out: Poly[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = v[j * (nx + 1) + i];
      const b = v[j * (nx + 1) + i + 1];
      const cc = v[(j + 1) * (nx + 1) + i + 1];
      const d = v[(j + 1) * (nx + 1) + i];
      if (!isFinite(a) || !isFinite(b) || !isFinite(cc) || !isFinite(d)) continue;
      // A cell straddling a pole flips sign without a root in it.
      if (Math.max(Math.abs(a), Math.abs(b), Math.abs(cc), Math.abs(d)) > 1e8) continue;
      const idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (cc > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      const seq = CASES[idx];
      if (!seq) continue;
      const X = i * g,
        Y = j * g;
      const ip = (u: number, w: number) => u / (u - w);
      const at = (edge: string): [number, number] => {
        if (edge === 'T') return [X + g * ip(a, b), Y];
        if (edge === 'R') return [X + g, Y + g * ip(b, cc)];
        if (edge === 'B') return [X + g * ip(d, cc), Y + g];
        return [X, Y + g * ip(a, d)];
      };
      for (let k = 0; k < seq.length; k += 2) {
        const P = at(seq[k]);
        const Q = at(seq[k + 1]);
        out.push([P[0], P[1], Q[0], Q[1]]);
      }
    }
  }
  return out;
}
