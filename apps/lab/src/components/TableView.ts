import { createSignal, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showToast } from '@bundled/yaar';

const PAGE = 25;

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function TableView(props: {
  columns: string[];
  rows: unknown[][];
  totalRows?: number;
  truncated?: boolean;
}) {
  const [sortCol, setSortCol] = createSignal(-1);
  const [dir, setDir] = createSignal(1);
  const [page, setPage] = createSignal(0);

  const sorted = () => {
    const c = sortCol();
    const src = props.rows || [];
    if (c < 0) return src;
    return src.slice().sort((x, y) => cmp(x[c], y[c]) * dir());
  };
  const pageCount = () => Math.max(1, Math.ceil((props.rows || []).length / PAGE));
  const view = () => {
    const p = Math.min(page(), pageCount() - 1);
    return sorted().slice(p * PAGE, p * PAGE + PAGE);
  };
  const clickHead = (i: number) => {
    if (sortCol() === i) setDir(dir() * -1);
    else {
      setSortCol(i);
      setDir(1);
    }
    setPage(0);
  };
  const copyTSV = () => {
    const lines = [props.columns.join('\t')];
    for (const r of sorted()) lines.push(r.map(cellText).join('\t'));
    void navigator.clipboard
      .writeText(lines.join('\n'))
      .then(() => showToast('Copied ' + sorted().length + ' rows as TSV', 'success'))
      .catch(() => showToast('Clipboard blocked', 'error'));
  };

  return html`
    <div class="lab-table-wrap">
      <div class="lab-table-scroll">
        <table class="lab-table">
          <thead>
            <tr>
              <th class="lab-th-num">#</th>
              <${For} each=${() => props.columns}>
                ${(c: string, i: () => number) => html`
                  <th onClick=${() => clickHead(i())}>
                    ${c}<span class="lab-sort">${() => (sortCol() === i() ? (dir() > 0 ? ' ↑' : ' ↓') : '')}</span>
                  </th>`}
              <//>
            </tr>
          </thead>
          <tbody>
            <${For} each=${view}>
              ${(r: unknown[], i: () => number) => html`
                <tr>
                  <td class="lab-th-num">${() => page() * PAGE + i() + 1}</td>
                  <${For} each=${() => r}>${(v: unknown) => html`<td>${cellText(v)}</td>`}<//>
                </tr>`}
            <//>
          </tbody>
        </table>
      </div>
      <div class="lab-table-foot">
        <span class="lab-note">
          ${() => props.totalRows ?? (props.rows || []).length} rows × ${() => props.columns.length} cols${() =>
            props.truncated ? ' (truncated)' : ''}
        </span>
        <span class="lab-spacer"></span>
        <button class="lab-mini" onClick=${copyTSV}>Copy TSV</button>
        <${Show} when=${() => pageCount() > 1}>
          <button class="lab-mini" onClick=${() => setPage(Math.max(0, page() - 1))}>‹</button>
          <span class="lab-note">${() => Math.min(page(), pageCount() - 1) + 1} / ${pageCount}</span>
          <button class="lab-mini" onClick=${() => setPage(Math.min(pageCount() - 1, page() + 1))}>›</button>
        <//>
      </div>
    </div>`;
}
