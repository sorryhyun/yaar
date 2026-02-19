import { parseRef } from './ref-utils';
import type { CellMap } from './types';

type Snapshot = { cells: CellMap; format: 'excel-lite-json-v1' };

export function createXlsxWorkbook(cells: CellMap) {
  const normalized: CellMap = {};
  for (const [refRaw, raw] of Object.entries(cells)) {
    const ref = refRaw.toUpperCase();
    if (!parseRef(ref)) continue;
    normalized[ref] = String(raw ?? '');
  }

  const payload: Snapshot = { cells: normalized, format: 'excel-lite-json-v1' };
  const text = JSON.stringify(payload);
  return new TextEncoder().encode(text);
}

export function parseXlsxWorkbook(data: Uint8Array): { cells: CellMap } {
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as Partial<Snapshot>;
    const rawCells = parsed && parsed.cells && typeof parsed.cells === 'object' ? parsed.cells : {};

    const out: CellMap = {};
    for (const [refRaw, value] of Object.entries(rawCells)) {
      const ref = refRaw.toUpperCase();
      if (!parseRef(ref)) continue;
      out[ref] = String(value ?? '');
    }

    return { cells: out };
  } catch {
    return { cells: {} };
  }
}
