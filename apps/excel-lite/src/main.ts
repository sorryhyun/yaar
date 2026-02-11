import { COLS, ROWS } from './constants';
import { cloneMap, csvEscape } from './data-utils';
import { computeFillDestination, sourceForDestination } from './fill-utils';
import { createFormulaEngine, shiftFormula } from './formula-utils';
import { applySnapshotToMaps, pushHistorySnapshot } from './history-utils';
import { colLabel, key as cellKey, parseRef, rangeRect, refsInRect } from './ref-utils';
import { getStyleForRef, normalizeStyle } from './style-utils';
import type { Align, CellMap, CellStyle, CellStyleMap, Rect, Snapshot } from './types';
import { createXlsxWorkbook, parseXlsxWorkbook } from './xlsx-utils';

const app = document.createElement('div');
app.innerHTML = `
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: #f5f7fb; user-select: none; }
    .wrap { padding: 10px; display: grid; gap: 8px; }
    .bar { display: grid; grid-template-columns: auto 1fr repeat(16, auto); gap: 6px; align-items: center; }
    .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; min-width: 74px; text-align: center; border: 1px solid #d0d7e2; border-radius: 8px; padding: 7px 8px; background: white; }
    input, select { padding: 7px 8px; border: 1px solid #d0d7e2; border-radius: 8px; font-size: 13px; background: white; }
    #formulaInput { width: 100%; }
    #storagePathInput { min-width: 220px; }
    button { padding: 7px 10px; border: 1px solid #ccd3df; border-radius: 8px; background: white; cursor: pointer; }
    button:hover { background: #f1f4f9; }
    button.active { background: #dbe8ff; border-color: #96b6ff; }
    .sheetWrap { overflow: auto; border: 1px solid #d9e0ec; border-radius: 10px; background: white; max-height: calc(100vh - 110px); }
    table { border-collapse: collapse; min-width: 1250px; table-layout: fixed; }
    th, td { border: 1px solid #e7ecf5; }
    th { position: sticky; top: 0; background: #f8faff; z-index: 2; font-weight: 600; }
    .rowHead { position: sticky; left: 0; background: #f8faff; z-index: 1; text-align: right; padding: 6px 8px; min-width: 46px; }
    .corner { position: sticky; left: 0; top: 0; z-index: 3; background: #eef3ff; min-width: 46px; }
    td { position: relative; min-width: 98px; }
    td input { width: 100%; border: none; padding: 7px 8px; box-sizing: border-box; outline: none; background: transparent; }
    td.selected { background: #d6e6ff; box-shadow: inset 0 0 0 1px #8eb3ff; }
    td.active { box-shadow: inset 0 0 0 2px #2a6df6; z-index: 1; }
    .fill-handle { position: absolute; width: 8px; height: 8px; right: -4px; bottom: -4px; border-radius: 1px; background: #2a6df6; cursor: crosshair; z-index: 5; }
    td.fill-preview { background: #c1d9ff; box-shadow: inset 0 0 0 1px #79a3ff; }
    .hint { color: #5c6475; font-size: 12px; }
  </style>
  <div class="wrap">
    <div class="bar">
      <div class="name" id="cellName">A1</div>
      <input id="formulaInput" placeholder="Value or formula (=A1+B1, =SUM(A1:A10))" />
      <button id="boldBtn"><b>B</b></button>
      <button id="italicBtn"><i>I</i></button>
      <button id="underlineBtn"><u>U</u></button>
      <select id="fontSizeSel">
        <option value="12">12</option><option value="14" selected>14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option><option value="24">24</option>
      </select>
      <input id="textColor" type="color" value="#111827" title="Text color" />
      <input id="bgColor" type="color" value="#ffffff" title="Cell background" />
      <select id="alignSel"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
      <button id="undoBtn">Undo</button>
      <button id="redoBtn">Redo</button>
      <button id="saveBtn" title="Copy sheet JSON to clipboard">Copy</button>
      <button id="loadBtn" title="Paste sheet JSON from a dialog">Paste</button>
      <input id="storagePathInput" title="Storage path" value="excel-lite/sheet.xlsx" />
      <button id="saveFileBtn" title="Save workbook XLSX to YAAR storage">Save Store</button>
      <button id="openFileBtn" title="Open workbook from YAAR storage (XLSX/JSON)">Open Store</button>
      <button id="csvBtn">CSV</button>
    </div>
    <div class="hint">Drag to select cells. Drag blue corner to fill. Shift+click extends selection. Ctrl+S saves to storage, Ctrl+O opens from storage, Ctrl+B/I/U, Ctrl+Z/Y, Delete supported.</div>
    <div class="hint" id="ioStatus">Storage ready.</div>
    <div class="sheetWrap" id="sheet"></div>
  </div>
`;
document.body.appendChild(app);

const sheetEl = document.getElementById('sheet') as HTMLDivElement;
const formulaInput = document.getElementById('formulaInput') as HTMLInputElement;
const cellName = document.getElementById('cellName') as HTMLDivElement;
const boldBtn = document.getElementById('boldBtn') as HTMLButtonElement;
const italicBtn = document.getElementById('italicBtn') as HTMLButtonElement;
const underlineBtn = document.getElementById('underlineBtn') as HTMLButtonElement;
const fontSizeSel = document.getElementById('fontSizeSel') as HTMLSelectElement;
const textColor = document.getElementById('textColor') as HTMLInputElement;
const bgColor = document.getElementById('bgColor') as HTMLInputElement;
const alignSel = document.getElementById('alignSel') as HTMLSelectElement;
const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement;
const redoBtn = document.getElementById('redoBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const loadBtn = document.getElementById('loadBtn') as HTMLButtonElement;
const storagePathInput = document.getElementById('storagePathInput') as HTMLInputElement;
const saveFileBtn = document.getElementById('saveFileBtn') as HTMLButtonElement;
const openFileBtn = document.getElementById('openFileBtn') as HTMLButtonElement;
const csvBtn = document.getElementById('csvBtn') as HTMLButtonElement;
const ioStatus = document.getElementById('ioStatus') as HTMLDivElement;

const cells: CellMap = {};
const styles: CellStyleMap = {};
const inputs = new Map<string, HTMLInputElement>();
const tds = new Map<string, HTMLTableCellElement>();

const fillHandle = document.createElement('div');
fillHandle.className = 'fill-handle';

let selected = 'A1';
let selectionStart = 'A1';
let selectionEnd = 'A1';
let editingRef: string | null = null;

let isSelecting = false;
let isFillDragging = false;
let fillSource: Rect | null = null;
let fillTarget: string | null = null;

const history: Snapshot[] = [];
const future: Snapshot[] = [];

function getRaw(ref: string): string {
  return cells[ref] ?? '';
}

const formulaEngine = createFormulaEngine(getRaw);

const storageApi = (window as any).yaar?.storage;

function setIoStatus(message: string, isError = false) {
  ioStatus.textContent = message;
  ioStatus.style.color = isError ? '#b42318' : '#5c6475';
}

function storagePath() {
  const path = storagePathInput.value.trim() || 'excel-lite/sheet.xlsx';
  storagePathInput.value = path;
  return path;
}

function pushHistory() {
  pushHistorySnapshot(history, future, cells, styles);
}

function undo() {
  const prev = history.pop();
  if (!prev) return;

  future.push({ cells: cloneMap(cells), styles: cloneMap(styles) });
  applySnapshotToMaps(prev, cells, styles);
  refreshAll();
}

function redo() {
  const next = future.pop();
  if (!next) return;

  history.push({ cells: cloneMap(cells), styles: cloneMap(styles) });
  applySnapshotToMaps(next, cells, styles);
  refreshAll();
}

function clearHighlights(className: string) {
  tds.forEach(td => td.classList.remove(className));
}

function updateToolbarState() {
  const style = getStyleForRef(styles, selected);
  boldBtn.classList.toggle('active', style.bold);
  italicBtn.classList.toggle('active', style.italic);
  underlineBtn.classList.toggle('active', style.underline);
  fontSizeSel.value = String(style.fontSize);
  textColor.value = style.color;
  bgColor.value = style.bg;
  alignSel.value = style.align;
}

function updateSelectionUI() {
  clearHighlights('selected');
  clearHighlights('active');
  clearHighlights('fill-preview');

  const rect = rangeRect(selectionStart, selectionEnd);
  for (const ref of refsInRect(rect)) tds.get(ref)?.classList.add('selected');

  const activeTd = tds.get(selected);
  if (activeTd) {
    activeTd.classList.add('active');
    activeTd.appendChild(fillHandle);
  }

  cellName.textContent = selectionStart === selectionEnd ? selected : `${selectionStart}:${selectionEnd}`;

  if (editingRef !== selected) formulaInput.value = getRaw(selected);
  updateToolbarState();
}

function setSelection(start: string, end: string, active = false) {
  selectionStart = start;
  selectionEnd = end;
  if (active) selected = end;
  updateSelectionUI();
}

function refreshCell(ref: string) {
  const input = inputs.get(ref);
  if (!input) return;

  if (editingRef !== ref) input.value = formulaEngine.display(ref);

  const style = getStyleForRef(styles, ref);
  input.style.fontWeight = style.bold ? '700' : '400';
  input.style.fontStyle = style.italic ? 'italic' : 'normal';
  input.style.textDecoration = style.underline ? 'underline' : 'none';
  input.style.fontSize = `${style.fontSize}px`;
  input.style.color = style.color;
  input.style.background = style.bg;
  input.style.textAlign = style.align;
}

function refreshAll() {
  inputs.forEach((_, ref) => refreshCell(ref));
  updateSelectionUI();
}

function commitCell(ref: string, value: string) {
  const prev = getRaw(ref);
  if (prev === value) {
    refreshCell(ref);
    return;
  }

  pushHistory();
  if (value) cells[ref] = value;
  else delete cells[ref];
  refreshAll();
}

function applyStyleToSelection(patch: Partial<CellStyle>) {
  pushHistory();
  const rect = rangeRect(selectionStart, selectionEnd);

  for (const ref of refsInRect(rect)) {
    const merged = { ...getStyleForRef(styles, ref), ...patch };
    const normalized = normalizeStyle(merged);
    if (normalized) styles[ref] = normalized;
    else delete styles[ref];
  }

  refreshAll();
}

function toggleStyle(styleKey: 'bold' | 'italic' | 'underline') {
  const current = getStyleForRef(styles, selected);
  applyStyleToSelection({ [styleKey]: !current[styleKey] } as Partial<CellStyle>);
}

function clearSelectionValues() {
  pushHistory();
  const rect = rangeRect(selectionStart, selectionEnd);
  for (const ref of refsInRect(rect)) delete cells[ref];
  refreshAll();
}

function updateFillPreview() {
  clearHighlights('fill-preview');
  if (!isFillDragging || !fillSource || !fillTarget) return;

  const dest = computeFillDestination(fillSource, fillTarget);
  if (!dest) return;

  for (const ref of refsInRect(dest)) tds.get(ref)?.classList.add('fill-preview');
}

function applyFill() {
  if (!fillSource || !fillTarget) return;

  const dest = computeFillDestination(fillSource, fillTarget);
  if (!dest) return;

  pushHistory();

  for (const ref of refsInRect(dest)) {
    const src = sourceForDestination(fillSource, ref);
    const pDest = parseRef(ref)!;
    const pSrc = parseRef(src)!;
    const shifted = shiftFormula(getRaw(src), pDest.r - pSrc.r, pDest.c - pSrc.c);

    if (shifted) cells[ref] = shifted;
    else delete cells[ref];

    const srcStyle = styles[src];
    if (srcStyle) styles[ref] = { ...srcStyle };
    else delete styles[ref];
  }

  if (dest.r2 > fillSource.r2) {
    selectionStart = cellKey(fillSource.c1, fillSource.r1);
    selectionEnd = cellKey(fillSource.c2, dest.r2);
  } else if (dest.r1 < fillSource.r1) {
    selectionStart = cellKey(fillSource.c1, dest.r1);
    selectionEnd = cellKey(fillSource.c2, fillSource.r2);
  } else if (dest.c2 > fillSource.c2) {
    selectionStart = cellKey(fillSource.c1, fillSource.r1);
    selectionEnd = cellKey(dest.c2, fillSource.r2);
  } else if (dest.c1 < fillSource.c1) {
    selectionStart = cellKey(dest.c1, fillSource.r1);
    selectionEnd = cellKey(fillSource.c2, fillSource.r2);
  }

  refreshAll();
}

function exportCsv() {
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

function buildSheet() {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  hr.appendChild(corner);

  for (let c = 1; c <= COLS; c++) {
    const th = document.createElement('th');
    th.textContent = colLabel(c);
    hr.appendChild(th);
  }

  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 1; r <= ROWS; r++) {
    const tr = document.createElement('tr');
    const rowHead = document.createElement('th');
    rowHead.className = 'rowHead';
    rowHead.textContent = String(r);
    tr.appendChild(rowHead);

    for (let c = 1; c <= COLS; c++) {
      const ref = cellKey(c, r);
      const td = document.createElement('td');
      td.dataset.ref = ref;
      const input = document.createElement('input');
      input.spellcheck = false;

      td.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).classList.contains('fill-handle')) return;

        isSelecting = true;
        if (e.shiftKey) setSelection(selectionStart, ref, true);
        else {
          selected = ref;
          setSelection(ref, ref, true);
        }
        input.focus();
      });

      td.addEventListener('mouseenter', () => {
        if (isSelecting) setSelection(selectionStart, ref, true);
        if (isFillDragging) {
          fillTarget = ref;
          updateFillPreview();
        }
      });

      input.addEventListener('focus', () => {
        editingRef = ref;
        selected = ref;
        if (!isSelecting) setSelection(ref, ref, true);
        input.value = getRaw(ref);
      });

      input.addEventListener('blur', () => {
        const value = input.value;
        editingRef = null;
        commitCell(ref, value);
      });

      input.addEventListener('keydown', (e) => {
        const parsed = parseRef(ref)!;

        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
          const next = cellKey(parsed.c, Math.min(ROWS, parsed.r + 1));
          inputs.get(next)?.focus();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          input.blur();
          const next = cellKey(Math.min(COLS, parsed.c + 1), parsed.r);
          inputs.get(next)?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          input.value = formulaEngine.display(ref);
          input.blur();
        }
      });

      td.appendChild(input);
      tr.appendChild(td);
      inputs.set(ref, input);
      tds.set(ref, td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  sheetEl.innerHTML = '';
  sheetEl.appendChild(table);

  fillHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isFillDragging = true;
    fillSource = rangeRect(selectionStart, selectionEnd);
    fillTarget = selected;
    updateFillPreview();
  });
}

formulaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    commitCell(selected, formulaInput.value);
    inputs.get(selected)?.focus();
  }
});

boldBtn.addEventListener('click', () => toggleStyle('bold'));
italicBtn.addEventListener('click', () => toggleStyle('italic'));
underlineBtn.addEventListener('click', () => toggleStyle('underline'));
fontSizeSel.addEventListener('change', () => applyStyleToSelection({ fontSize: Number(fontSizeSel.value) }));
textColor.addEventListener('change', () => applyStyleToSelection({ color: textColor.value }));
bgColor.addEventListener('change', () => applyStyleToSelection({ bg: bgColor.value }));
alignSel.addEventListener('change', () => applyStyleToSelection({ align: alignSel.value as Align }));
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

function serializeWorkbook() {
  return JSON.stringify({ cells, styles }, null, 2);
}

function importWorkbook(parsed: any) {
  pushHistory();

  for (const k of Object.keys(cells)) delete cells[k];
  for (const k of Object.keys(styles)) delete styles[k];

  if (parsed && typeof parsed === 'object' && parsed.cells && typeof parsed.cells === 'object') {
    for (const [k, v] of Object.entries(parsed.cells)) {
      if (typeof v === 'string') cells[k.toUpperCase()] = v;
    }

    if (parsed.styles && typeof parsed.styles === 'object') {
      for (const [k, v] of Object.entries(parsed.styles)) {
        if (!v || typeof v !== 'object') continue;
        const normalized = normalizeStyle(v as CellStyle);
        if (normalized) styles[k.toUpperCase()] = normalized;
      }
    }
  } else {
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') cells[k.toUpperCase()] = v;
    }
  }

  refreshAll();
}

function tryImportWorkbook(text: string, errorMessage = 'Invalid JSON') {
  try {
    const parsed = JSON.parse(text) as any;
    importWorkbook(parsed);
    return true;
  } catch {
    alert(errorMessage);
    return false;
  }
}

async function saveWorkbookToStorage() {
  if (!storageApi) {
    setIoStatus('Storage API unavailable in this runtime.', true);
    return;
  }

  try {
    const path = storagePath();
    const binary = createXlsxWorkbook(cells);
    await storageApi.save(path, binary);
    setIoStatus(`Saved XLSX to storage: ${path}`);
    saveFileBtn.textContent = 'Saved';
    setTimeout(() => (saveFileBtn.textContent = 'Save Store'), 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save';
    setIoStatus(message, true);
  }
}

async function openWorkbookFromStorage() {
  if (!storageApi) {
    setIoStatus('Storage API unavailable in this runtime.', true);
    return;
  }

  try {
    const path = storagePath();
    const lower = path.toLowerCase();

    if (lower.endsWith('.json')) {
      const text = await storageApi.read(path, { as: 'text' });
      if (typeof text !== 'string') throw new Error('Workbook content is not text');

      if (tryImportWorkbook(text, `Invalid JSON in ${path}`)) {
        setIoStatus(`Opened JSON from storage: ${path}`);
        openFileBtn.textContent = 'Opened';
        setTimeout(() => (openFileBtn.textContent = 'Open Store'), 1000);
      }
      return;
    }

    const data = await storageApi.read(path, { as: 'arraybuffer' });
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    const parsed = parseXlsxWorkbook(bytes);
    importWorkbook(parsed);
    setIoStatus(`Opened XLSX from storage: ${path}`);
    openFileBtn.textContent = 'Opened';
    setTimeout(() => (openFileBtn.textContent = 'Open Store'), 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to open file';
    setIoStatus(message, true);
  }
}

saveBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(serializeWorkbook());
    saveBtn.textContent = 'Copied';
    setTimeout(() => (saveBtn.textContent = 'Copy'), 1000);
  } catch {
    alert('Clipboard access failed. Use Save Store instead.');
  }
});

loadBtn.addEventListener('click', () => {
  const text = prompt('Paste JSON: { cells: {...}, styles: {...} } (legacy cell map also supported)');
  if (!text) return;

  if (tryImportWorkbook(text, 'Invalid JSON')) {
    setIoStatus('Loaded workbook from pasted JSON.');
    loadBtn.textContent = 'Loaded';
    setTimeout(() => (loadBtn.textContent = 'Paste'), 1000);
  }
});

saveFileBtn.addEventListener('click', () => {
  void saveWorkbookToStorage();
});

openFileBtn.addEventListener('click', () => {
  void openWorkbookFromStorage();
});

csvBtn.addEventListener('click', () => {
  exportCsv();
  csvBtn.textContent = 'Done';
  setTimeout(() => (csvBtn.textContent = 'CSV'), 1000);
});

document.addEventListener('mouseup', () => {
  isSelecting = false;

  if (isFillDragging) {
    applyFill();
    isFillDragging = false;
    fillSource = null;
    fillTarget = null;
    clearHighlights('fill-preview');
  }
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const isFormula = target === formulaInput;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void saveWorkbookToStorage();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    void openWorkbookFromStorage();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleStyle('bold');
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    toggleStyle('italic');
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    toggleStyle('underline');
    return;
  }

  if (e.key === 'Delete' && !isFormula) {
    clearSelectionValues();
  }
});

buildSheet();
refreshAll();

if (!storageApi) {
  setIoStatus('Storage API unavailable in this runtime.', true);
}

// ── App Protocol: expose state and commands to the AI agent ──────

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'excel-lite',
    name: 'Excel Lite',
    state: {
      cells: {
        description: 'All cell values as a { [ref]: rawValue } object (e.g., {"A1":"Hello","B2":"=A1+1"})',
        handler: () => ({ ...cells }),
      },
      styles: {
        description: 'All cell styles as a { [ref]: CellStyle } object',
        handler: () => ({ ...styles }),
      },
      selection: {
        description: 'Current selection: { active, start, end }',
        handler: () => ({ active: selected, start: selectionStart, end: selectionEnd }),
      },
    },
    commands: {
      setCells: {
        description: 'Set one or more cell values. Params: { cells: { [ref]: value } }',
        params: { type: 'object', properties: { cells: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['cells'] },
        handler: (p: { cells: Record<string, string> }) => {
          pushHistory();
          for (const [ref, value] of Object.entries(p.cells)) {
            const upper = ref.toUpperCase();
            if (value) cells[upper] = value;
            else delete cells[upper];
          }
          refreshAll();
          return { ok: true, count: Object.keys(p.cells).length };
        },
      },
      setStyles: {
        description: 'Set styles for one or more cells. Params: { styles: { [ref]: Partial<CellStyle> } }',
        params: { type: 'object', properties: { styles: { type: 'object' } }, required: ['styles'] },
        handler: (p: { styles: Record<string, Partial<CellStyle>> }) => {
          pushHistory();
          for (const [ref, patch] of Object.entries(p.styles)) {
            const upper = ref.toUpperCase();
            const merged = { ...getStyleForRef(styles, upper), ...patch };
            const normalized = normalizeStyle(merged);
            if (normalized) styles[upper] = normalized;
            else delete styles[upper];
          }
          refreshAll();
          return { ok: true };
        },
      },
      selectCell: {
        description: 'Select a cell or range. Params: { ref: string } or { start: string, end: string }',
        params: { type: 'object', properties: { ref: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } } },
        handler: (p: { ref?: string; start?: string; end?: string }) => {
          const start = (p.start ?? p.ref ?? 'A1').toUpperCase();
          const end = (p.end ?? start).toUpperCase();
          selected = start;
          setSelection(start, end, true);
          return { ok: true };
        },
      },
      clearRange: {
        description: 'Clear all cell values in a range. Params: { start: string, end: string }',
        params: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
        handler: (p: { start: string; end: string }) => {
          pushHistory();
          const rect = rangeRect(p.start.toUpperCase(), p.end.toUpperCase());
          let count = 0;
          for (const ref of refsInRect(rect)) {
            if (cells[ref]) { delete cells[ref]; count++; }
          }
          refreshAll();
          return { ok: true, cleared: count };
        },
      },
      importWorkbook: {
        description: 'Import a full workbook JSON. Params: { data: { cells: {...}, styles?: {...} } }',
        params: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
        handler: (p: { data: any }) => {
          importWorkbook(p.data);
          return { ok: true };
        },
      },
    },
  });
}
