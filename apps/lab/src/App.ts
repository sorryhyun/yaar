import { createSignal, createEffect, onMount, Index, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showConfirm, showToast, errMsg } from '@bundled/yaar';
import {
  notebooks, current, dirty, status, runningCell,
  bootstrap, openNotebook, newNotebook, deleteNotebook, saveCurrent,
  addCell, deleteCell, moveCell, setCellSource, updateCell, renameNotebook, clearAllOutputs,
} from './store';
import { busy, cancelRun, resetKernel } from './kernel';
import { runCell, runAll, lastRun, timeoutMs, setTimeoutMs } from './run';
import { OutputView, renderMarkdown } from './output';
import type { Cell } from './types';

const editors = new Map<string, HTMLTextAreaElement>();
const [editingMd, setEditingMd] = createSignal<string[]>([]);
const [sidebar, setSidebar] = createSignal(true);

const isEditing = (id: string) => editingMd().includes(id);
const startEdit = (id: string) => setEditingMd([...editingMd(), id]);
const stopEdit = (id: string) => setEditingMd(editingMd().filter((x) => x !== id));

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = Math.max(38, Math.min(700, el.scrollHeight + 2)) + 'px';
}

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

function CellEditor(cell: () => Cell) {
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

function CellRow(cell: () => Cell, index: number) {
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

function Sidebar() {
  return html`
    <div class="lab-sidebar">
      <div class="lab-side-head">
        <span class="lab-side-title">Notebooks</span>
        <button class="lab-mini" title="New notebook" onClick=${async () => {
          await saveCurrent();
          await newNotebook('Untitled');
        }}>+</button>
      </div>
      <div class="lab-side-list">
        <${For} each=${notebooks}>
          ${(m: { id: string; title: string; cellCount: number; updatedAt: number }) => html`
            <div
              class=${() => 'lab-side-item' + (current()?.id === m.id ? ' lab-side-item-on' : '')}
              onClick=${async () => {
                if (current()?.id === m.id) return;
                await saveCurrent();
                try { await openNotebook(m.id); } catch (e) { showToast(errMsg(e), 'error'); }
              }}
            >
              <div class="lab-side-name">${m.title}</div>
              <div class="lab-side-meta">${m.cellCount} cells · ${new Date(m.updatedAt).toLocaleDateString()}</div>
              <button
                class="lab-side-del"
                title="Delete notebook"
                onClick=${async (e: MouseEvent) => {
                  e.stopPropagation();
                  if (await showConfirm('Delete "' + m.title + '"?', { danger: true, okLabel: 'Delete' })) {
                    await deleteNotebook(m.id);
                  }
                }}
              >✕</button>
            </div>`}
        <//>
      </div>
    </div>`;
}

export default function App() {
  onMount(() => {
    void bootstrap();
  });

  const cells = () => current()?.cells || [];

  return html`
    <div class=${() => 'lab-root' + (sidebar() ? '' : ' lab-no-side')}>
      ${() => (sidebar() ? Sidebar() : null)}
      <div class="lab-main">
        <div class="lab-toolbar">
          <button class="lab-mini" title="Toggle notebook list" onClick=${() => setSidebar(!sidebar())}>☰</button>
          <input
            class="lab-title"
            value=${() => current()?.title || ''}
            placeholder="Untitled"
            onInput=${(e: Event) => renameNotebook((e.target as HTMLInputElement).value)}
          />
          <span class="lab-spacer"></span>
          <button class="lab-btn" disabled=${busy} onClick=${() => void runAll()}>▶▶ Run all</button>
          <button class="lab-btn" onClick=${() => addCell('', 'code')}>+ Code</button>
          <button class="lab-btn" onClick=${() => addCell('', 'markdown')}>+ Text</button>
          <button class="lab-btn" onClick=${() => clearAllOutputs()}>Clear out</button>
          <button class="lab-btn" onClick=${() => { resetKernel(); showToast('Kernel restarted', 'info'); }}>Reset kernel</button>
          <label class="lab-timeout">
            timeout
            <input
              type="number"
              min="1"
              max="600"
              value=${() => Math.round(timeoutMs() / 1000)}
              onChange=${(e: Event) => setTimeoutMs(Math.max(1, Number((e.target as HTMLInputElement).value) || 30) * 1000)}
            />s
          </label>
        </div>
        <div class="lab-cells">
          <${Index} each=${cells}>${(cell: () => Cell, i: number) => CellRow(cell, i)}<//>
          <div class="lab-add-row">
            <button class="lab-btn" onClick=${() => addCell('', 'code')}>+ Add cell</button>
          </div>
        </div>
        <div class="lab-status">
          <${Show} when=${busy} fallback=${() => html`<span class="lab-dot lab-dot-idle"></span><span>idle</span>`}>
            <span class="lab-dot lab-dot-busy"></span><span>running…</span>
            <button class="lab-mini lab-mini-danger" onClick=${() => cancelRun()}>Cancel</button>
          <//>
          <span class="lab-spacer"></span>
          <span class="lab-note">${() => status()}</span>
          <span class="lab-note">${() => {
            const r = lastRun();
            return r ? (r.ok ? 'last: ' : 'last failed: ') + r.summary.slice(0, 90) + ' (' + r.durationMs + 'ms)' : '';
          }}</span>
          <span class="lab-note">${() => (dirty() ? 'unsaved' : 'saved')}</span>
          <button class="lab-mini" onClick=${async () => { (await saveCurrent()) && showToast('Saved', 'success'); }}>Save</button>
        </div>
      </div>
    </div>`;
}
