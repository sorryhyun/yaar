/**
 * io-utils.ts
 * Storage I/O operations: save, open workbook, export CSV.
 */
import { createXlsxWorkbook, parseXlsxWorkbook } from './xlsx-utils';
import { parseRef, key as cellKey } from './ref-utils';
import { csvEscape } from './data-utils';
import {
  storageAvailable, storageSave, storageRead,
  storagePath,
  cells, setIoStatus,
  tryImportWorkbook, importWorkbook,
  serializeWorkbook, getRaw,
} from './state';

export async function saveWorkbookToStorage() {
  if (!storageAvailable()) {
    setIoStatus('Storage API unavailable in this runtime.', true);
    return;
  }
  try {
    const path = storagePath();
    const binary = createXlsxWorkbook(cells);
    await storageSave(path, binary);
    setIoStatus(`Saved XLSX to storage: ${path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save';
    setIoStatus(message, true);
  }
}

export async function openWorkbookFromStorage() {
  if (!storageAvailable()) {
    setIoStatus('Storage API unavailable in this runtime.', true);
    return;
  }
  try {
    const path = storagePath();
    const lower = path.toLowerCase();

    if (lower.endsWith('.json')) {
      const text = await storageRead(path, 'text');
      if (typeof text !== 'string') throw new Error('Workbook content is not text');
      if (tryImportWorkbook(text, `Invalid JSON in ${path}`)) {
        setIoStatus(`Opened JSON from storage: ${path}`);
      }
      return;
    }

    const data = await storageRead(path, 'arraybuffer');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    const parsed = parseXlsxWorkbook(bytes);
    importWorkbook(parsed);
    setIoStatus(`Opened XLSX from storage: ${path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to open file';
    setIoStatus(message, true);
  }
}

export function exportCsv() {
  let maxRow = 1;
  let maxCol = 1;

  for (const ref of Object.keys(cells)) {
    const parsed = parseRef(ref);
    if (!parsed) continue;
    if (!cells[ref]) continue;
    maxRow = Math.max(maxRow, parsed.r);
    maxCol = Math.max(maxCol, parsed.c);
  }

  const lines: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row: string[] = [];
    for (let c = 1; c <= maxCol; c++) row.push(csvEscape(getRaw(cellKey(c, r))));
    lines.push(row.join(','));
  }

  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sheet.csv';
  a.click();
  URL.revokeObjectURL(url);
}
