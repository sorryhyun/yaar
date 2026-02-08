import { cloneMap } from './data-utils';
import type { CellMap, CellStyleMap, Snapshot } from './types';

export function pushHistorySnapshot(
  history: Snapshot[],
  future: Snapshot[],
  cells: CellMap,
  styles: CellStyleMap,
  limit = 100
) {
  history.push({ cells: cloneMap(cells), styles: cloneMap(styles) });
  if (history.length > limit) history.shift();
  future.length = 0;
}

export function applySnapshotToMaps(snapshot: Snapshot, cells: CellMap, styles: CellStyleMap) {
  for (const k of Object.keys(cells)) delete cells[k];
  for (const [k, v] of Object.entries(snapshot.cells)) cells[k] = v;

  for (const k of Object.keys(styles)) delete styles[k];
  for (const [k, v] of Object.entries(snapshot.styles)) styles[k] = v;
}
