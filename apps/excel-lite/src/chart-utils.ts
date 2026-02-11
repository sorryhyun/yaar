import { parseRef } from './ref-utils';
import type { CellMap } from './types';

export type ChartPoint = { label: string; value: number };

export function selectionChartPoints(
  refs: string[],
  cells: CellMap,
  displayValue: (ref: string) => string
): ChartPoint[] {
  const points: ChartPoint[] = [];

  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!parsed) continue;

    const shown = displayValue(ref).trim();
    const raw = (cells[ref] ?? '').trim();
    const candidate = shown || raw;
    const numeric = Number(candidate);
    if (!Number.isFinite(numeric)) continue;

    points.push({ label: ref, value: numeric });
  }

  return points;
}
