import { createEffect, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showToast, errMsg } from '@bundled/yaar';
import { renderChart, chartToPNG } from '../lib/chart-render';
import { saveChart, sharedPath } from '../lib/shared-tree';
import { downloadDataUrl } from '../lib/data-url';
import type { ChartSpec } from '../types';

/** A live Chart.js canvas plus its save/export buttons. Owns the chart instance. */
export function ChartView(props: { spec: ChartSpec }) {
  let canvasEl: HTMLCanvasElement | undefined;
  let chart: { destroy: () => void } | null = null;

  createEffect(() => {
    const spec = props.spec;
    if (!canvasEl || !spec) return;
    if (chart) chart.destroy();
    chart = renderChart(canvasEl, spec);
  });
  onCleanup(() => {
    if (chart) chart.destroy();
    chart = null;
  });

  const save = async () => {
    try {
      const r = await saveChart(props.spec, sharedPath(undefined, 'chart-' + Date.now()));
      showToast('Saved ' + r.path, 'success', 4000);
    } catch (e) {
      showToast('Save failed: ' + errMsg(e), 'error');
    }
  };
  const download = async () => {
    try {
      const png = await chartToPNG(props.spec);
      downloadDataUrl(png, 'chart-' + Date.now() + '.png');
    } catch (e) {
      showToast('Export failed: ' + errMsg(e), 'error');
    }
  };

  return html`
    <div class="lab-chart-block">
      <div class="lab-chart" style=${() => 'height:' + ((props.spec.options && props.spec.options.height) || 300) + 'px'}>
        <canvas ref=${(el: HTMLCanvasElement) => (canvasEl = el)}></canvas>
      </div>
      <div class="lab-chart-actions">
        <button class="lab-mini" onClick=${save}>Save to shared/lab</button>
        <button class="lab-mini" onClick=${download}>Download PNG</button>
      </div>
    </div>`;
}
