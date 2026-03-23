/**
 * render-utils.ts
 * Chart and stats rendering functions.
 */
import { Chart, registerables } from '@bundled/chart.js';
import { format as d3Format, sum, mean, median, min, max } from '@bundled/d3';
import { selectionChartPoints } from './chart-utils';
import {
  mutable, refs,
  cells,
  chartPanelOpen, setChartPanelOpen, chartTitleText, setChartTitleText,
  statsRows, setStatsRows, statsRangeLabel, setStatsRangeLabel, statsPanelOpen, setStatsPanelOpen,
  setIoStatus,
  formulaEngine,
} from './state';
import { rangeRect, refsInRect } from './ref-utils';

// Register all Chart.js components
Chart.register(...registerables);

// ── Chart instance ────────────────────────────────────────────────────
let selectionChart: Chart | null = null;

export function destroyChart() {
  selectionChart?.destroy();
  selectionChart = null;
}

// ── Internal helpers ───────────────────────────────────────────────────

/** Resolve a CSS custom property value at runtime for chart theming. */
function cssVar(name: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

/** Build the current selection range label, e.g. "A1" or "A1:C3". */
function getSelectionRangeLabel(): string {
  return mutable.selectionStart === mutable.selectionEnd
    ? mutable.selected
    : `${mutable.selectionStart}:${mutable.selectionEnd}`;
}

// ── Exported renderers ─────────────────────────────────────────────────

export function renderSelectionChart() {
  const rect   = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  const rects  = refsInRect(rect);
  const points = selectionChartPoints(rects, cells, (ref) => formulaEngine.display(ref));

  if (!points.length) {
    setIoStatus('Selection has no numeric values for charting.', true);
    return;
  }

  const chartType = (refs.chartTypeSel?.value ?? 'bar') as 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter';
  selectionChart?.destroy();

  const labels = points.map((p) => p.label);
  const values = points.map((p) => p.value);

  const colors = [
    '#2a6df6', '#60a5fa', '#93c5fd', '#3b82f6',
    '#1d4ed8', '#bfdbfe', '#dbeafe', '#2563eb',
  ];

  const isScatter = chartType === 'scatter';
  const isRound   = chartType === 'pie' || chartType === 'doughnut';

  // Theme-aware colors
  const textColor = cssVar('--yaar-text', '#e6edf3');
  const textMuted = cssVar('--yaar-text-muted', '#8b949e');
  const gridColor = cssVar('--yaar-border', '#30363d');

  selectionChart = new Chart(refs.chartCanvas!, {
    type: chartType,
    data: {
      labels,
      datasets: [
        {
          label: chartType.charAt(0).toUpperCase() + chartType.slice(1) + ' Chart',
          data: isScatter ? values.map((v, i) => ({ x: i, y: v })) : values,
          borderColor: '#2a6df6',
          backgroundColor: isRound ? colors : 'rgba(42, 109, 246, 0.35)',
          borderWidth: isRound ? 1 : 2,
          fill: chartType === 'line',
          tension: 0.3,
          pointBackgroundColor: '#2a6df6',
          pointRadius: (chartType === 'line' || isScatter) ? 4 : 0,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeInOutQuart' },
      plugins: {
        legend: {
          display: isRound,
          position: 'bottom',
          labels: { color: textColor },
        },
        tooltip: {
          enabled: true,
          callbacks: {
            label: (ctx: any) => ` ${ctx.parsed.y ?? ctx.parsed}`,
          },
        },
      },
      scales: !isRound ? {
        x: { grid: { color: gridColor }, ticks: { color: textMuted, font: { size: 11 }, maxRotation: 45 } },
        y: { grid: { color: gridColor }, ticks: { color: textMuted, font: { size: 11 } }, beginAtZero: true },
      } : undefined,
    },
  } as any);

  setChartTitleText(`${getSelectionRangeLabel()} (${points.length} pts)`);
  setChartPanelOpen(true);
  setIoStatus(`Rendered ${chartType} chart from selection.`);
}

export function renderSelectionStats() {
  const rect    = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  const rects   = refsInRect(rect);
  const numeric = rects
    .map((ref) => Number.parseFloat(formulaEngine.display(ref)))
    .filter((value) => Number.isFinite(value));

  if (!numeric.length) {
    setIoStatus('Selection has no numeric values for stats.', true);
    return;
  }

  const fmt  = d3Format(',.4~f');
  const rows = [
    { label: 'Count',  value: String(numeric.length) },
    { label: 'Sum',    value: fmt(sum(numeric)) },
    { label: 'Mean',   value: fmt(mean(numeric) ?? 0) },
    { label: 'Median', value: fmt(median(numeric) ?? 0) },
    { label: 'Min',    value: fmt(min(numeric) ?? 0) },
    { label: 'Max',    value: fmt(max(numeric) ?? 0) },
  ];

  setStatsRows(rows);
  setStatsRangeLabel(getSelectionRangeLabel());
  setStatsPanelOpen(true);
  setIoStatus('Computed stats for selected range.');
}
