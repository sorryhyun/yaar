import { createEffect } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { setCellSource } from '../state/cells';
import { current } from '../state/signals';
import { runCell } from '../state/run';
import { autosize, editors, stopEdit } from './editor-registry';
import type { Cell } from '../types';

async function runAndAdvance(id: string): Promise<void> {
  const nb = current();
  await runCell(id);
  if (!nb) return;
  const i = nb.cells.findIndex((c) => c.id === id);
  const next = nb.cells[i + 1];
  if (next) editors.get(next.id)?.focus();
}

function onEditorKey(e: KeyboardEvent, id: string): void {
  if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) void runAndAdvance(id);
    else void runCell(id);
    return;
  }
  if (e.key === 'Escape') {
    (e.target as HTMLTextAreaElement).blur();
    stopEdit(id);
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const el = e.target as HTMLTextAreaElement;
    const s = el.selectionStart;
    el.value = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd);
    el.selectionStart = el.selectionEnd = s + 2;
    setCellSource(id, el.value);
  }
}

/**
 * The textarea is deliberately NOT reactively bound. A createEffect writes the
 * value only when it differs from the DOM, which keeps the cursor put while still
 * picking up agent-side edits.
 */
export function CellEditor(cell: () => Cell) {
  return html`
    <textarea
      class="lab-editor"
      spellcheck="false"
      ref=${(el: HTMLTextAreaElement) => {
        editors.set(cell().id, el);
        el.value = cell().source;
        // createEffect runs after the node is attached, so this is also where the
        // first autosize happens — scrollHeight reads 0 before insertion.
        createEffect(() => {
          const src = cell().source;
          if (el.value !== src) el.value = src;
          autosize(el);
        });
      }}
      onInput=${(e: Event) => {
        const el = e.target as HTMLTextAreaElement;
        autosize(el);
        setCellSource(cell().id, el.value);
      }}
      onKeyDown=${(e: KeyboardEvent) => onEditorKey(e, cell().id)}
      onBlur=${() => stopEdit(cell().id)}
    ></textarea>`;
}
