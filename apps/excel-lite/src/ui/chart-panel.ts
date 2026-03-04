import html from '@bundled/solid-js/html';
import {
  chartPanelOpen, setChartPanelOpen, chartTitleText,
  statsPanelOpen, statsRows, statsRangeLabel,
  refs,
} from '../state';
import { destroyChart } from '../render-utils';

export function createChartPanel() {
  return html`
    <div class=${() => `chartPanel${chartPanelOpen() ? ' open' : ''}`}>
      <div class="chartPanelHead">
        <strong>${() => chartTitleText()}</strong>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
          destroyChart();
          setChartPanelOpen(false);
        }} title="Close chart">&#x2715;</button>
      </div>
      <canvas ref=${(el: HTMLCanvasElement) => { refs.chartCanvas = el; }} id="chartCanvas" height="180"></canvas>
    </div>
  `;
}

export function createStatsPanel() {
  return html`
    <div class=${() => `statsPanel${statsPanelOpen() ? ' open' : ''}`}>
      ${() => statsPanelOpen() ? html`
        <div class="chartPanelHead">
          <strong>Selection Stats</strong>
          <span>${() => statsRangeLabel()}</span>
        </div>
        <div class="statsGrid">
          ${() => statsRows().map(row => html`
            <div class="statCard">
              <div class="statLabel">${row.label}</div>
              <div class="statValue">${row.value}</div>
            </div>
          `)}
        </div>
      ` : ''}
    </div>
  `;
}

export function createChartTypeSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'y-select y-select-sm';
  const options: Array<{ value: string; label: string }> = [
    { value: 'bar', label: 'Bar' },
    { value: 'line', label: 'Line' },
    { value: 'pie', label: 'Pie' },
    { value: 'doughnut', label: 'Doughnut' },
    { value: 'scatter', label: 'Scatter' },
  ];
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    sel.appendChild(el);
  }
  return sel;
}
