import { Chart, registerables } from '@bundled/chart.js';
import type { DailyPaperItem } from './types';
import { getPublishedAt, getSource } from './paper-utils';

Chart.register(...registerables);

let chartInstance: Chart | null = null;

export function buildActivityData(papers: DailyPaperItem[]) {
  // Group by date string (YYYY-MM-DD)
  const countsByDate: Record<string, { hf: number; arxiv: number }> = {};

  for (const item of papers) {
    const iso = getPublishedAt(item);
    if (!iso) continue;
    const date = iso.slice(0, 10); // YYYY-MM-DD
    if (!countsByDate[date]) countsByDate[date] = { hf: 0, arxiv: 0 };
    if (getSource(item) === 'huggingface') countsByDate[date].hf++;
    else countsByDate[date].arxiv++;
  }

  // Sort dates ascending
  const dates = Object.keys(countsByDate).sort();
  return {
    labels: dates,
    hfData: dates.map(d => countsByDate[d].hf),
    arxivData: dates.map(d => countsByDate[d].arxiv),
  };
}

export function renderActivityChart(canvas: HTMLCanvasElement, papers: DailyPaperItem[]) {
  chartInstance?.destroy();

  const { labels, hfData, arxivData } = buildActivityData(papers);

  if (!labels.length) return;

  const hasHf = hfData.some(v => v > 0);
  const hasArxiv = arxivData.some(v => v > 0);

  const datasets = [];
  if (hasHf) {
    datasets.push({
      label: 'Hugging Face',
      data: hfData,
      backgroundColor: 'rgba(255, 167, 38, 0.75)',
      borderColor: '#ffa726',
      borderWidth: 1,
      borderRadius: 4,
    });
  }
  if (hasArxiv) {
    datasets.push({
      label: 'arXiv',
      data: arxivData,
      backgroundColor: 'rgba(88, 166, 255, 0.75)',
      borderColor: '#58a6ff',
      borderWidth: 1,
      borderRadius: 4,
    });
  }

  chartInstance = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeInOutQuart' },
      plugins: {
        legend: {
          display: hasHf && hasArxiv,
          position: 'top',
          labels: { color: '#8b949e', font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            title: (items) => `📅 ${items[0].label}`,
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} paper${ctx.parsed.y !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8b949e', font: { size: 10 }, maxRotation: 45 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.07)' },
          ticks: { color: '#8b949e', font: { size: 11 }, stepSize: 1 },
        },
      },
    },
  });
}

export function destroyChart() {
  chartInstance?.destroy();
  chartInstance = null;
}
