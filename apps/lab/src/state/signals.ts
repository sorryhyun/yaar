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

export {
  notebooks, setNotebooks,
  current, setCurrent,
  dirty, setDirty,
  status, setStatus,
  runningCell, setRunningCell,
};
