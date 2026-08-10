import { createSignal } from '@bundled/solid-js';
import type { Notebook, NotebookMeta } from '../types';

/**
 * The reactive centre of the app. Everything else in state/ mutates these; the UI
 * and the protocol only read them. Kept in its own module so persistence.ts and
 * cells.ts can both reach the setters without importing each other.
 */

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

const [notebooks, setNotebooks] = createSignal<NotebookMeta[]>([]);
const [current, setCurrent] = createSignal<Notebook | null>(null);
const [dirty, setDirty] = createSignal(false);
const [status, setStatus] = createSignal('');
const [runningCell, setRunningCell] = createSignal<string | null>(null);
/** The cell an agent just touched — CellRow scrolls to it and highlights it briefly. */
const [flashCell, setFlashCell] = createSignal<string | null>(null);

let flashTimer = 0;
/** Mark a cell as agent-touched for ~2s. Repeated calls restart the timer. */
export function flashCellFor(id: string, ms = 2000): void {
  setFlashCell(id);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => setFlashCell(null), ms);
}

export {
  notebooks, setNotebooks,
  current, setCurrent,
  dirty, setDirty,
  status, setStatus,
  runningCell, setRunningCell,
  flashCell, setFlashCell,
};
