import * as XLSX from '@bundled/xlsx';
import type { CellMap } from './types';

export function createXlsxWorkbook(cells: CellMap): Uint8Array {
  const ws: XLSX.WorkSheet = {};
  let maxCol = 0;
  let maxRow = 0;

  for (const [ref, value] of Object.entries(cells)) {
    if (!value) continue;
    ws[ref] = { v: value, t: 's' };
    const pos = XLSX.utils.decode_cell(ref);
    if (pos.c > maxCol) maxCol = pos.c;
    if (pos.r > maxRow) maxRow = pos.r;
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: maxCol, r: maxRow } });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Uint8Array(out);
}

export function parseXlsxWorkbook(data: Uint8Array): { cells: CellMap } {
  try {
    const wb = XLSX.read(data, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { cells: {} };

    const ws = wb.Sheets[sheetName];
    const out: CellMap = {};

    for (const [ref, cell] of Object.entries(ws)) {
      if (ref.startsWith('!')) continue;
      const c = cell as XLSX.CellObject;
      if (c.v != null) out[ref.toUpperCase()] = String(c.v);
    }

    return { cells: out };
  } catch {
    return { cells: {} };
  }
}
