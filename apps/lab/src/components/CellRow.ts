import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { addCell, deleteCell, moveCell, updateCell } from '../state/cells';
import { runningCell } from '../state/signals';
import { runCell } from '../state/run';
import { busy } from '../kernel/worker';
import { renderMarkdown } from '../lib/markdown';
import { CellEditor } from './CellEditor';
import { editors, isEditing, startEdit } from './editor-registry';
import { OutputView } from './OutputView';
import type { Cell } from '../types';

/** One notebook row: gutter, type/move/delete bar, editor (or rendered markdown), output. */
export function CellRow(cell: () => Cell, index: number) {
  const id = () => cell().id;
  const isCode = () => cell().type === 'code';
  const running = () => runningCell() === id();
  return html`
    <div class=${() => 'lab-cell' + (running() ? ' lab-cell-running' : '')}>
      <div class="lab-cell-gutter">
        <button
          class="lab-run"
          title="Run (Shift+Enter)"
          disabled=${() => !isCode() || busy()}
          onClick=${() => void runCell(id())}
        >${() => (running() ? '●' : '▶')}</button>
        <span class="lab-cell-num">${index + 1}</span>
      </div>
      <div class="lab-cell-body">
        <div class="lab-cell-bar">
          <select
            class="lab-type"
            onChange=${(e: Event) => updateCell(id(), { type: (e.target as HTMLSelectElement).value as Cell['type'] })}
          >
            <option value="code" selected=${() => isCode()}>code</option>
            <option value="markdown" selected=${() => !isCode()}>markdown</option>
          </select>
          <span class="lab-spacer"></span>
          <button class="lab-mini" title="Move up" onClick=${() => moveCell(id(), -1)}>↑</button>
          <button class="lab-mini" title="Move down" onClick=${() => moveCell(id(), 1)}>↓</button>
          <button class="lab-mini" title="Insert cell below" onClick=${() => addCell('', 'code', index + 1)}>+</button>
          <button class="lab-mini lab-mini-danger" title="Delete cell" onClick=${() => deleteCell(id())}>✕</button>
        </div>
        <${Show}
          when=${() => isCode() || isEditing(id())}
          fallback=${() => html`
            <div
              class="lab-md lab-md-cell"
              onDblClick=${() => { startEdit(id()); queueMicrotask(() => editors.get(id())?.focus()); }}
              innerHTML=${() => renderMarkdown(cell().source || '_(empty markdown cell — double-click to edit)_')}
            ></div>`}
        >
          ${() => CellEditor(cell)}
        <//>
        ${() => html`<${OutputView} output=${() => cell().output} />`}
      </div>
    </div>`;
}
