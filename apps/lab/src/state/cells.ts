import { batch } from '@bundled/solid-js';
import { markDirty } from './persistence';
import { current, setCurrent, uid } from './signals';
import type { Cell, CellOutput, CellType } from '../types';

/**
 * Every mutation of the open notebook's cells. Each one replaces the notebook
 * object (Solid signals compare by reference) and then marks the notebook dirty,
 * which is what schedules the autosave.
 */

function mutate(fn: (cells: Cell[]) => Cell[]): void {
  const nb = current();
  if (!nb) return;
  setCurrent({ ...nb, cells: fn(nb.cells.slice()) });
  markDirty();
}

export function addCell(source = '', type: CellType = 'code', index?: number): Cell {
  const cell: Cell = { id: uid('c'), type, source };
  mutate((cells) => {
    const at = index === undefined || index < 0 || index > cells.length ? cells.length : index;
    cells.splice(at, 0, cell);
    return cells;
  });
  return cell;
}

export function updateCell(id: string, patch: Partial<Cell>): boolean {
  let found = false;
  mutate((cells) =>
    cells.map((c) => {
      if (c.id !== id) return c;
      found = true;
      return { ...c, ...patch };
    }),
  );
  return found;
}

/** Source edits from the textarea: no full re-render of the cell list needed. */
export function setCellSource(id: string, source: string): void {
  const nb = current();
  if (!nb) return;
  const cells = nb.cells.map((c) => (c.id === id ? { ...c, source } : c));
  setCurrent({ ...nb, cells });
  markDirty();
}

export function setCellOutput(id: string, output: CellOutput | undefined): void {
  const nb = current();
  if (!nb) return;
  setCurrent({ ...nb, cells: nb.cells.map((c) => (c.id === id ? { ...c, output } : c)) });
  markDirty();
}

export function deleteCell(id: string): boolean {
  const nb = current();
  if (!nb) return false;
  if (!nb.cells.some((c) => c.id === id)) return false;
  const cells = nb.cells.filter((c) => c.id !== id);
  setCurrent({ ...nb, cells: cells.length ? cells : [{ id: uid('c'), type: 'code', source: '' }] });
  markDirty();
  return true;
}

export function moveCell(id: string, delta: number): boolean {
  const nb = current();
  if (!nb) return false;
  const i = nb.cells.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= nb.cells.length) return false;
  const cells = nb.cells.slice();
  const [c] = cells.splice(i, 1);
  cells.splice(j, 0, c);
  setCurrent({ ...nb, cells });
  markDirty();
  return true;
}

export function renameNotebook(title: string): void {
  const nb = current();
  if (!nb) return;
  setCurrent({ ...nb, title });
  markDirty();
}

export function clearAllOutputs(): void {
  const nb = current();
  if (!nb) return;
  batch(() => setCurrent({ ...nb, cells: nb.cells.map((c) => ({ ...c, output: undefined })) }));
  markDirty();
}

export function findCell(id: string): Cell | undefined {
  return current()?.cells.find((c) => c.id === id);
}
