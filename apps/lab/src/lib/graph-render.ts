import { drawGraph, planSeries, defaultParams, DARK_THEME, type GraphTheme } from '../graph/render';
import { viewFromBounds, viewFromSpec } from '../graph/sample';
import type { GraphSpec } from '../types';

/**
 * Render a graph spec off-screen and return a PNG data URL — the still-image half
 * of the feature, used by graph.toPNG() and graph.save() from the kernel, by the
 * Download button, and by exportChart. Mirrors chart-render.ts's contract.
 *
 * No live canvas is involved: the spec plus a size is enough. The viewport comes
 * from the spec's own bounds, unless the caller passes `bounds` and `params` — the
 * on-screen buttons do, so a user exports what they panned and dialled to, while
 * graph.save() from a cell exports the spec as written.
 */
export interface GraphRenderOpts {
  width?: number;
  height?: number;
  scale?: number;
  background?: string;
  /** User-space rectangle to draw, overriding the spec's own bounds. */
  bounds?: { xMin: number; xMax: number; yMin: number; yMax: number };
  /** Free-variable values, overriding the spec's params plus the 1 default. */
  params?: Record<string, number>;
}

export async function graphToPNG(spec: GraphSpec, opts?: GraphRenderOpts): Promise<string> {
  const width = Math.max(120, Math.round((opts && opts.width) || 720));
  const height = Math.max(
    90,
    Math.round((opts && opts.height) || (spec.options && spec.options.height) || 360),
  );
  const scale = Math.min(3, Math.max(1, (opts && opts.scale) || 2));
  const theme: GraphTheme =
    opts && opts.background ? { ...DARK_THEME, bg: opts.background } : DARK_THEME;

  const plans = planSeries(spec, theme);
  const bad = plans.find((p) => p.error);
  if (bad) throw new Error('graph: cannot parse "' + (bad.series.expr || '') + '" — ' + bad.error);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('graph: could not get a 2d canvas context');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const view =
    opts && opts.bounds
      ? viewFromBounds(opts.bounds, width, height)
      : viewFromSpec(spec, width, height);
  const params = (opts && opts.params) || defaultParams(spec, plans);
  drawGraph(ctx, width, height, spec, plans, view, params, theme);
  return canvas.toDataURL('image/png');
}
