/**
 * io-utils.ts
 * Storage I/O operations: save, open workbook, export CSV.
 */
import { createXlsxWorkbook, parseXlsxWorkbook } from './xlsx-utils';
import { parseRef, key as cellKey } from './ref-utils';
import { csvEscape } from './data-utils';
import {
  storageSave, storageRead,
  storagePath,
  cells, setIoStatus,
  tryImportWorkbook, importWorkbook,
  serializeWorkbook, getRaw,
} from './state';

/** Extract a human-readable message from an unknown error value. */
function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export async function saveWorkbookToStorage() {
  try {
    const path   = storagePath();
    const binary = createXlsxWorkbook(cells);
    await storageSave(path, binary);
    setIoStatus(`Saved XLSX to storage: ${path}`);
  } catch (err) {
    setIoStatus(getErrorMessage(err, 'Failed to save'), true);
  }
}

export async function openWorkbookFromStorage() {
  try {
    const path  = storagePath();
    const lower = path.toLowerCase();

    if (lower.endsWith('.json')) {
      const text = await storageRead(path, 'text');
      if (typeof text !== 'string') throw new Error('Workbook content is not text');
      if (tryImportWorkbook(text, `Invalid JSON in ${path}`)) {
        setIoStatus(`Opened JSON from storage: ${path}`);
      }
      return;
    }

    const data  = await storageRead(path, 'arraybuffer');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    importWorkbook(parseXlsxWorkbook(bytes));
    setIoStatus(`Opened XLSX from storage: ${path}`);
  } catch (err) {
    setIoStatus(getErrorMessage(err, 'Failed to open file'), true);
  }
}

export function exportCsv() {
  let maxRow = 1;
  let maxCol = 1;

  for (const ref of Object.keys(cells)) {
    const parsed = parseRef(ref);
    if (!parsed || !cells[ref]) continue;
    maxRow = Math.max(maxRow, parsed.r);
    maxCol = Math.max(maxCol, parsed.c);
  }

  const lines: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row: string[] = [];
    for (let c = 1; c <= maxCol; c++) row.push(csvEscape(getRaw(cellKey(c, r))));
    lines.push(row.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'sheet.csv';
  a.click();
  URL.revokeObjectURL(url);
}
