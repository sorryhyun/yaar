import { Chart, registerables } from '@bundled/chart.js';
import { buildConfig, BG } from './chart-config';
import type { ChartSpec } from '../types';

Chart.register(...registerables);

/** Live chart inside a cell output. Caller owns destruction. */
export function renderChart(canvas: HTMLCanvasElement, spec: ChartSpec): any {
  return new Chart(canvas, buildConfig(spec));
}

/**
 * Render a chart off-screen and return a PNG data URL. Used by plot.toPNG()
 * from inside the kernel, by the "Save PNG" button, and by exportChart.
 */
export async function chartToPNG(
  spec: ChartSpec,
  opts?: { width?: number; height?: number; scale?: number; background?: string },
): Promise<string> {
  const width = Math.max(120, Math.round((opts && opts.width) || 720));
  const height = Math.max(90, Math.round((opts && opts.height) || (spec.options && spec.options.height) || 360));
  const scale = Math.min(3, Math.max(1, (opts && opts.scale) || 2));
  const holder = document.createElement('div');
  holder.style.cssText =
    'position:fixed;left:-20000px;top:0;pointer-events:none;width:' + width + 'px;height:' + height + 'px;';
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  holder.appendChild(canvas);
  document.body.appendChild(holder);
  let chart: any = null;
  try {
    chart = new Chart(canvas, buildConfig(spec, { background: (opts && opts.background) || BG }));
    chart.resize(width, height);
    chart.update('none');
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return canvas.toDataURL('image/png');
  } finally {
    if (chart) chart.destroy();
    holder.remove();
  }
}
