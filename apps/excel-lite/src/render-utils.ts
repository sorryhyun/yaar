/**
 * render-utils.ts
 * Chart and stats rendering functions.
 * Imported by toolbar (for button clicks) and chart-panel (for chart instance access).
 * Lives separately to avoid circular imports between toolbar <-> chart-panel.
 */
import { selectionChartPoints } from './chart-utils';
import {
  mutable, refs,
  cells,
  chartPanelOpen, chartTitleText,
  statsRows, statsRangeLabel, statsPanelOpen,
  setIoStatus,
  formulaEngine,
} from './state';
import { rangeRect, refsInRect } from './ref-utils';

// ── Minimal Chart class (inline canvas renderer) ──────────────────────
class Chart {
  static register(..._args: any[]) {}
  private canvas: HTMLCanvasElement;
  private cfg: any;
  constructor(canvas: HTMLCanvasElement, cfg: any) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.render();
  }
  destroy() {
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  private render() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const values = this.cfg.data.datasets[0]?.data ?? [];
    if (!values.length) return;
    const max = Math.max(...values, 1);

    if (this.cfg.type === 'pie') {
      let start = -Math.PI / 2;
      const total = values.reduce((a: number, b: number) => a + b, 0) || 1;
      values.forEach((v: number, i: number) => {
        const end = start + (v / total) * Math.PI * 2;
        const hue = (i * 57) % 360;
        ctx.fillStyle = `hsl(${hue} 75% 55%)`;
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.38, start, end);
        ctx.closePath();
        ctx.fill();
        start = end;
      });
      return;
    }

    const n = values.length;
    const padding = 24;
    const innerW = w - padding * 2;
    const innerH = h - padding * 2;

    ctx.strokeStyle = '#9aa7bd';
    ctx.beginPath();
    ctx.moveTo(padding, h - padding);
    ctx.lineTo(w - padding, h - padding);
    ctx.stroke();

    if (this.cfg.type === 'line') {
      ctx.strokeStyle = '#2a6df6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      values.forEach((v: number, i: number) => {
        const x = padding + (i / Math.max(1, n - 1)) * innerW;
        const y = h - padding - (v / max) * innerH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      return;
    }

    const barW = innerW / n;
    values.forEach((v: number, i: number) => {
      const x = padding + i * barW + 3;
      const bh = (v / max) * innerH;
      const y = h - padding - bh;
      ctx.fillStyle = 'rgba(42,109,246,0.6)';
      ctx.fillRect(x, y, Math.max(2, barW - 6), bh);
    });
  }
}

// ── d3-like stat helpers ──────────────────────────────────────────────
const d3 = {
  format: (_fmt: string) => (n: number) =>
    Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '0',
  sum: (arr: number[]) => arr.reduce((a, b) => a + b, 0),
  mean: (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined),
  median: (arr: number[]) => {
    if (!arr.length) return undefined;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },
  min: (arr: number[]) => (arr.length ? Math.min(...arr) : undefined),
  max: (arr: number[]) => (arr.length ? Math.max(...arr) : undefined),
};

// ── Chart instance ────────────────────────────────────────────────────
let selectionChart: Chart | null = null;

export function destroyChart() {
  selectionChart?.destroy();
  selectionChart = null;
}

export function renderSelectionChart() {
  const rect = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  const rects = refsInRect(rect);
  const points = selectionChartPoints(rects, cells, (ref) => formulaEngine.display(ref));

  if (!points.length) {
    setIoStatus('Selection has no numeric values for charting.', true);
    return;
  }

  const chartType = (refs.chartTypeSel?.value ?? 'bar') as 'bar' | 'line' | 'pie';
  selectionChart?.destroy();
  selectionChart = new Chart(refs.chartCanvas!, {
    type: chartType,
    data: {
      labels: points.map((p) => p.label),
      datasets: [
        {
          label: chartType.toUpperCase(),
          data: points.map((p) => p.value),
          borderColor: '#2a6df6',
          backgroundColor: chartType === 'pie'
            ? ['#2a6df6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe', '#2563eb']
            : 'rgba(42, 109, 246, 0.35)',
          borderWidth: 2,
          fill: chartType === 'line',
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: chartType === 'pie' } },
    },
  });

  const rangeLabel = mutable.selectionStart === mutable.selectionEnd
    ? mutable.selected
    : `${mutable.selectionStart}:${mutable.selectionEnd}`;
  chartTitleText(`${rangeLabel} (${points.length} pts)`);
  chartPanelOpen(true);
  setIoStatus(`Rendered ${chartType} chart from selection.`);
}

export function renderSelectionStats() {
  const rect = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  const rects = refsInRect(rect);
  const numeric = rects
    .map((ref) => Number.parseFloat(formulaEngine.display(ref)))
    .filter((value) => Number.isFinite(value));

  if (!numeric.length) {
    setIoStatus('Selection has no numeric values for stats.', true);
    return;
  }

  const fmt = d3.format(',.4~f');
  const rows = [
    { label: 'Count', value: String(numeric.length) },
    { label: 'Sum', value: fmt(d3.sum(numeric)) },
    { label: 'Mean', value: fmt(d3.mean(numeric) ?? 0) },
    { label: 'Median', value: fmt(d3.median(numeric) ?? 0) },
    { label: 'Min', value: fmt(d3.min(numeric) ?? 0) },
    { label: 'Max', value: fmt(d3.max(numeric) ?? 0) },
  ];

  statsRows(rows);
  const rangeLabel = mutable.selectionStart === mutable.selectionEnd
    ? mutable.selected
    : `${mutable.selectionStart}:${mutable.selectionEnd}`;
  statsRangeLabel(rangeLabel);
  statsPanelOpen(true);
  setIoStatus('Computed stats for selected range.');
}
