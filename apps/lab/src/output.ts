import { createEffect, onCleanup, Show, For, Switch, Match } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { marked } from '@bundled/marked';
import { sanitizeHtml, showToast, errMsg } from '@bundled/yaar';
import { renderChart, chartToPNG } from './chart';
import { saveChart, saveDataUrl, mediaPath, downloadDataUrl } from './media';
import { JsonView } from './json-view';
import { TableView } from './table-view';
import type { CellOutput, ChartSpec, OutputPart } from './types';

export function renderMarkdown(src: string): string {
  try {
    return sanitizeHtml(marked.parse(src || '') as string);
  } catch (e) {
    return sanitizeHtml('<p>markdown failed: ' + errMsg(e) + '</p>');
  }
}

function ChartView(props: { spec: ChartSpec }) {
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
      const r = await saveChart(props.spec, mediaPath(undefined, 'chart-' + Date.now()));
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
        <button class="lab-mini" onClick=${save}>Save to media/lab</button>
        <button class="lab-mini" onClick=${download}>Download PNG</button>
      </div>
    </div>`;
}

function ImageView(props: { src: string }) {
  const save = async () => {
    try {
      const r = await saveDataUrl(props.src, mediaPath(undefined, 'image-' + Date.now()));
      showToast('Saved ' + r.path, 'success', 4000);
    } catch (e) {
      showToast('Save failed: ' + errMsg(e), 'error');
    }
  };
  return html`
    <div class="lab-image-block">
      <img class="lab-image" src=${() => props.src} alt="cell output" />
      <div class="lab-chart-actions"><button class="lab-mini" onClick=${save}>Save to media/lab</button></div>
    </div>`;
}

function PartView(props: { part: OutputPart }) {
  const kind = () => props.part.kind;
  return html`
    <${Switch} fallback=${() => html`<pre class="lab-pre">${() => props.part.text || ''}</pre>`}>
      <${Match} when=${() => kind() === 'table'}>
        <${TableView}
          columns=${() => props.part.columns || []}
          rows=${() => props.part.rows || []}
          totalRows=${() => props.part.totalRows}
          truncated=${() => props.part.truncated}
        />
      <//>
      <${Match} when=${() => kind() === 'json'}>
        <${JsonView} json=${() => props.part.json || 'null'} truncated=${() => props.part.truncated} />
      <//>
      <${Match} when=${() => kind() === 'chart'}>
        <${ChartView} spec=${() => props.part.spec} />
      <//>
      <${Match} when=${() => kind() === 'image'}>
        <${ImageView} src=${() => props.part.src || ''} />
      <//>
      <${Match} when=${() => kind() === 'markdown'}>
        <div class="lab-md" innerHTML=${() => renderMarkdown(props.part.text || '')}></div>
      <//>
      <${Match} when=${() => kind() === 'error'}>
        <pre class="lab-pre lab-err">${() => (props.part.name || 'Error') + ': ' + (props.part.message || '')}</pre>
      <//>
    <//>`;
}

export function OutputView(props: { output: CellOutput | undefined }) {
  const out = () => props.output;
  const logs = () => out()?.logs || [];
  const parts = () => out()?.parts || [];
  return html`
    <${Show} when=${out}>
      <div class=${() => 'lab-output' + (out()!.ok ? '' : ' lab-output-bad')}>
        <${Show} when=${() => logs().length > 0}>
          <div class="lab-logs">
            <${For} each=${logs}>
              ${(l: { level: string; text: string }) => html`<div class=${'lab-log lab-log-' + l.level}>${l.text}</div>`}
            <//>
          </div>
        <//>
        <${For} each=${parts}>${(p: OutputPart) => html`<${PartView} part=${p} />`}<//>
        <${Show} when=${() => !out()!.ok && out()!.error}>
          <pre class="lab-pre lab-err">${() =>
            out()!.error!.name + ': ' + out()!.error!.message + (out()!.error!.stack ? '\n' + out()!.error!.stack : '')}</pre>
        <//>
        <div class="lab-output-foot">${() => out()!.durationMs + ' ms'}</div>
      </div>
    <//>`;
}
