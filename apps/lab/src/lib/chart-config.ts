import type { ChartSpec } from '../types';

const PALETTE = [
  '#539bf5',
  '#57ab5a',
  '#c69026',
  '#e5534b',
  '#986ee2',
  '#4cc9c0',
  '#f778ba',
  '#8ddb8c',
  '#daaa3f',
  '#6cb6ff',
];
const TEXT = '#adbac7';
const GRID = 'rgba(55, 62, 71, 0.9)';
export const BG = '#1c2128';

function hexAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16),
    g = parseInt(m[2], 16),
    b = parseInt(m[3], 16);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
}

/** Fill the canvas behind the chart so exported PNGs are not transparent. */
export const bgPlugin = {
  id: 'labBackground',
  beforeDraw(chart: any, _args: unknown, pluginOpts: any) {
    const color = pluginOpts && pluginOpts.color;
    if (!color) return;
    const ctx = chart.ctx as CanvasRenderingContext2D;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, chart.width, chart.height);
    ctx.restore();
  },
};

/** Turn a kernel chart spec into a Chart.js config. */
export function buildConfig(
  spec: ChartSpec,
  opts?: { background?: string; animate?: boolean },
): any {
  const o = spec.options || ({} as ChartSpec['options']);
  const colors = (o.colors && o.colors.length ? o.colors : PALETTE) as string[];
  const isPie = spec.type === 'pie' || spec.type === 'doughnut';
  const labels = spec.data.labels || [];

  const datasets = (spec.data.datasets || []).map((d, i) => {
    const base = colors[i % colors.length];
    if (isPie) {
      return {
        label: d.label,
        data: d.data,
        backgroundColor: labels.map((_, j) => colors[j % colors.length]),
        borderColor: BG,
        borderWidth: 2,
      };
    }
    if (spec.type === 'line') {
      return {
        label: d.label,
        data: d.data,
        borderColor: base,
        backgroundColor: o.fill ? hexAlpha(base, 0.25) : base,
        fill: !!o.fill,
        tension: 0.25,
        pointRadius: (d.data || []).length > 80 ? 0 : 2.5,
        borderWidth: 2,
      };
    }
    if (spec.type === 'scatter') {
      return {
        label: d.label,
        data: d.data,
        backgroundColor: base,
        borderColor: base,
        pointRadius: 3,
      };
    }
    return {
      label: d.label,
      data: d.data,
      backgroundColor: hexAlpha(base, 0.82),
      borderColor: base,
      borderWidth: 1,
      borderRadius: 3,
    };
  });

  // Build the axis objects without ever writing an explicit `undefined`: Chart.js
  // treats a present-but-undefined `type` as a real value and falls back to a
  // linear scale, which turns category labels into 0,1,2,3.
  const axisTitle = (text?: string) =>
    text ? { display: true, text, color: TEXT, font: { size: 11 } } : { display: false };

  const xAxis: any = {
    type: spec.type === 'scatter' ? 'linear' : 'category',
    stacked: !!o.stacked,
    ticks: { color: TEXT, font: { size: 10 }, maxRotation: 60, autoSkip: true },
    grid: { color: GRID, drawTicks: false },
    title: axisTitle(o.xLabel),
  };
  const yAxis: any = {
    type: 'linear',
    stacked: !!o.stacked,
    beginAtZero: o.beginAtZero !== false,
    ticks: { color: TEXT, font: { size: 10 } },
    grid: { color: GRID, drawTicks: false },
    title: axisTitle(o.yLabel),
  };
  // With indexAxis 'y' the category axis is y and the value axis is x.
  const scales: any = isPie
    ? undefined
    : o.horizontal
      ? {
          x: { ...yAxis, title: axisTitle(o.yLabel) },
          y: { ...xAxis, type: 'category', title: axisTitle(o.xLabel) },
        }
      : { x: xAxis, y: yAxis };

  return {
    type: spec.type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      indexAxis: o.horizontal ? ('y' as const) : ('x' as const),
      interaction: { intersect: false, mode: 'index' as const },
      plugins: {
        labBackground: { color: (opts && opts.background) || null },
        legend: {
          display: o.legend !== false && (datasets.length > 1 || isPie),
          labels: { color: TEXT, boxWidth: 12, font: { size: 11 } },
          position: 'bottom' as const,
        },
        title: o.title
          ? {
              display: true,
              text: o.title,
              color: '#f0f6fc',
              font: { size: 13, weight: 'normal' as const },
            }
          : { display: false },
        tooltip: {
          backgroundColor: '#22272e',
          borderColor: '#373e47',
          borderWidth: 1,
          titleColor: '#f0f6fc',
          bodyColor: TEXT,
        },
      },
      scales,
    },
    plugins: [bgPlugin],
  };
}
