import { createSignal, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function preview(v: unknown): string {
  if (Array.isArray(v)) return 'Array(' + v.length + ')';
  if (v && typeof v === 'object') {
    const k = Object.keys(v as object);
    return '{ ' + k.slice(0, 4).join(', ') + (k.length > 4 ? ', …' : '') + ' }';
  }
  return String(v);
}

function scalarText(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

function entriesOf(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x] as [string, unknown]);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>);
  return [];
}

export function JsonNode(props: { name: string; value: unknown; depth: number }) {
  const [open, setOpen] = createSignal(props.depth < 1);
  const kind = () => typeOf(props.value);
  const branch = () => kind() === 'object' || kind() === 'array';
  const rows = () => (open() ? entriesOf(props.value) : []);
  return html`
    <div class="lab-jnode">
      <div class="lab-jrow" onClick=${(e: MouseEvent) => {
        if (branch()) {
          e.stopPropagation();
          setOpen(!open());
        }
      }}>
        <span class="lab-jtoggle">${() => (branch() ? (open() ? '▾' : '▸') : '')}</span>
        <${Show} when=${() => props.name !== ''}>
          <span class="lab-jkey">${() => props.name}</span><span class="lab-jsep">:</span>
        <//>
        <${Show}
          when=${branch}
          fallback=${() => html`<span class=${'lab-jval lab-j-' + kind()}>${() => scalarText(props.value)}</span>`}
        >
          <span class="lab-jprev">${() => preview(props.value)}</span>
        <//>
      </div>
      <${Show} when=${() => branch() && open()}>
        <div class="lab-jchildren">
          <${For} each=${rows}>
            ${(e: [string, unknown]) => html`<${JsonNode} name=${e[0]} value=${e[1]} depth=${props.depth + 1} />`}
          <//>
        </div>
      <//>
    </div>`;
}

export function JsonView(props: { json: string; truncated?: boolean }) {
  let parsed: unknown;
  let failed = false;
  try {
    parsed = JSON.parse(props.json);
  } catch {
    failed = true;
  }
  if (failed) return html`<pre class="lab-pre">${props.json}</pre>`;
  return html`
    <div class="lab-json">
      <${JsonNode} name="" value=${parsed} depth=${0} />
      <${Show} when=${() => props.truncated}>
        <div class="lab-note">output truncated</div>
      <//>
    </div>`;
}
