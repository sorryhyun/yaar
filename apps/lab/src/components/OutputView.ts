import { Show, For, Switch, Match } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { renderMarkdown } from '../lib/markdown';
import { ChartView } from './ChartView';
import { GraphView } from './GraphView';
import { ImageView } from './ImageView';
import { JsonView } from './JsonView';
import { TableView } from './TableView';
import type { CellOutput, OutputPart } from '../types';

/** One output part routed to the view that knows how to draw its kind. */
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
      <${Match} when=${() => kind() === 'graph' && props.part.graph}>
        <${GraphView} spec=${() => props.part.graph} />
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

/** A cell's whole output block: log lines, then parts, then the error and timing. */
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
