import * as XLSX from '@bundled/xlsx';
import { parseRef } from './ref-utils';
import type { CellMap } from './types';

function isNumericText(value: string) {
  const t = value.trim();
  if (!t) return false;
  return /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(t);
}

function buildWorksheet(cells: CellMap): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {};
  let maxR = 1;
  let maxC = 1;

  for (const [refRaw, raw] of Object.entries(cells)) {
    if (!raw) continue;

    const ref = refRaw.toUpperCase();
    const parsed = parseRef(ref);
    if (!parsed) continue;

    maxR = Math.max(maxR, parsed.r);
    maxC = Math.max(maxC, parsed.c);

    if (raw.startsWith('=')) {
      sheet[ref] = { t: 'n', f: raw.slice(1) } as XLSX.CellObject;
      continue;
    }

    if (isNumericText(raw)) {
      sheet[ref] = { t: 'n', v: Number(raw.trim()) };
      continue;
    }

    sheet[ref] = { t: 's', v: raw };
  }

  sheet['!ref'] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: Math.max(0, maxC - 1), r: Math.max(0, maxR - 1) } });
  return sheet;
}

export function createXlsxWorkbook(cells: CellMap) {
  const wb = XLSX.utils.book_new();
  const ws = buildWorksheet(cells);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const out = XLSX.write(wb, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
  });

  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

export function parseXlsxWorkbook(data: Uint8Array): { cells: CellMap } {
  const source = data instanceof Uint8Array ? data : new Uint8Array(data);

  const wb = XLSX.read(source, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { cells: {} };

  const ws = wb.Sheets[sheetName];
  if (!ws) return { cells: {} };

  const out: CellMap = {};

  for (const [key, cell] of Object.entries(ws)) {
    if (key.startsWith('!')) continue;
    const ref = key.toUpperCase();
    if (!parseRef(ref)) continue;

    const c = cell as XLSX.CellObject;

    if (c.f != null) {
      out[ref] = `=${c.f}`;
      continue;
    }

    if (c.v == null) {
      out[ref] = '';
      continue;
    }

    if (c.t === 'n') {
      out[ref] = String(c.v);
      continue;
    }

    if (c.t === 'b') {
      out[ref] = c.v ? 'TRUE' : 'FALSE';
      continue;
    }

    out[ref] = String(c.v);
  }

  return { cells: out };
}
