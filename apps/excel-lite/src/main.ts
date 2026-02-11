import { Chart, registerables } from '@bundled/chart.js';
import { format } from '@bundled/date-fns';
import * as d3 from '@bundled/d3';
import { debounce } from '@bundled/lodash';
import { selectionChartPoints } from './chart-utils';
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
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: #f3f6fc; user-select: none; color: #111827; }
    .wrap { padding: 10px; display: grid; gap: 8px; }
    .toolbar {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid #d8e1ef;
      border-radius: 12px;
      background: linear-gradient(180deg, #ffffff, #f8fbff);
      box-shadow: 0 6px 18px rgba(42, 109, 246, 0.08);
      position: sticky;
      top: 8px;
      z-index: 10;
    }
    .toolbar-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: nowrap;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 2px;
    }
    .toolbar-row.file #storagePathInput { flex: 1 1 280px; min-width: 240px; }
    .toolbar-row.edit #formulaInput { flex: 1 1 360px; min-width: 260px; }
    .toolbar-row.edit .name { flex: 0 0 auto; }
    .name {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 700;
      min-width: 78px;
      text-align: center;
      border: 1px solid #cfd8e6;
      border-radius: 8px;
      padding: 7px 8px;
      background: #f7faff;
    }
    input, select {
      height: 34px;
      padding: 6px 9px;
      border: 1px solid #ccd6e4;
      border-radius: 8px;
      font-size: 13px;
      background: white;
      box-sizing: border-box;
    }
    #formulaInput { width: 100%; }
    #storagePathInput { min-width: 260px; }
    #textColor, #bgColor { width: 42px; padding: 2px; }
    button {
      height: 34px;
      min-width: 34px;
      padding: 6px 10px;
      border: 1px solid #c8d3e3;
      border-radius: 9px;
      background: linear-gradient(180deg, #ffffff, #f7f9fd);
      cursor: pointer;
      transition: all 120ms ease;
      font-weight: 600;
      color: #1f2937;
    }
    button:hover { background: #edf3ff; border-color: #aec2e6; transform: translateY(-1px); }
    button.active { background: #dce8ff; border-color: #89abf0; }
    .sheetWrap { overflow: auto; border: 1px solid #d8e1ef; border-radius: 10px; background: white; max-height: calc(100vh - 160px); }
    .chartPanel {
      border: 1px solid #d8e1ef;
      border-radius: 10px;
      background: #ffffff;
      padding: 8px;
      display: none;
      min-height: 220px;
      box-shadow: inset 0 0 0 1px #eef3ff;
    }
    .chartPanel.open { display: block; }
    .chartPanelHead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      color: #1e293b;
      font-size: 13px;
    }
    #chartCanvas { width: 100%; max-height: 220px; }
    .statsPanel {
      border: 1px solid #d8e1ef;
      border-radius: 10px;
      background: #ffffff;
      padding: 10px;
      display: none;
    }
    .statsPanel.open { display: block; }
    .statsGrid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
    }
    .statCard {
      border: 1px solid #e5ecf8;
      border-radius: 8px;
      background: #f8fbff;
      padding: 8px;
    }
    .statLabel { font-size: 11px; color: #64748b; }
    .statValue { font-size: 14px; font-weight: 700; color: #0f172a; margin-top: 2px; }
    table { border-collapse: collapse; min-width: 1250px; table-layout: fixed; }
    th, td { border: 1px solid #e7ecf5; }
    th { position: sticky; top: 0; background: #f8faff; z-index: 2; font-weight: 600; }
    .rowHead { position: sticky; left: 0; background: #f8faff; z-index: 1; text-align: right; padding: 6px 8px; min-width: 46px; }
    .corner { position: sticky; left: 0; top: 0; z-index: 3; background: #eef3ff; min-width: 46px; }
    td { position: relative; min-width: 98px; }
    td input { width: 100%; border: none; padding: 7px 8px; box-sizing: border-box; outline: none; background: transparent; }
    td.selected { background: #dce8ff; box-shadow: inset 0 0 0 1px #93b4f4; }
    td.active { box-shadow: inset 0 0 0 2px #2a6df6; z-index: 1; }
    .fill-handle { position: absolute; width: 8px; height: 8px; right: -4px; bottom: -4px; border-radius: 1px; background: #2a6df6; cursor: crosshair; z-index: 5; }
    td.fill-preview { background: #c7dcff; box-shadow: inset 0 0 0 1px #79a3ff; }
    .hint { color: #5c6475; font-size: 12px; display: none; }
    .io-status {
      position: fixed;
      right: 18px;
      bottom: 14px;
      z-index: 30;
      font-size: 12px;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid #d8e1ef;
      background: rgba(255, 255, 255, 0.95);
      color: #374151;
      box-shadow: 0 6px 20px rgba(16, 24, 40, 0.12);
      display: none;
    }
    @media (max-width: 1200px) {
      #formulaInput, #storagePathInput { min-width: 220px; }
    }
  </style>
  <div class="wrap">
    <div class="toolbar">
      <div class="toolbar-row file">
        <button id="saveFileBtn" title="Save workbook XLSX to YAAR storage" aria-label="Save File">💾</button>
        <button id="openFileBtn" title="Open workbook from YAAR storage (XLSX/JSON)" aria-label="Open File">📂</button>
        <button id="saveBtn" title="Copy sheet JSON to clipboard" aria-label="Copy JSON">⎘</button>
        <button id="loadBtn" title="Paste sheet JSON from a dialog" aria-label="Paste JSON">📋</button>
        <button id="csvBtn" title="Export CSV" aria-label="Export CSV">⬇</button>
        <button id="chartBtn" title="Create chart from selection" aria-label="Chart Selection">📊</button>
        <button id="statsBtn" title="Selection statistics" aria-label="Selection Statistics">Σ</button>
        <select id="chartTypeSel" title="Chart type">
          <option value="bar" selected>Bar</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
        </select>
        <input id="storagePathInput" title="Storage path" value="excel-lite/sheet.xlsx" />
      </div>
      <div class="toolbar-row edit">
        <button id="undoBtn" title="Undo" aria-label="Undo">↶</button>
        <button id="redoBtn" title="Redo" aria-label="Redo">↷</button>
        <div class="name" id="cellName">A1</div>
        <input id="formulaInput" placeholder="Value or formula (=A1+B1, =SUM(A1:A10))" />
        <button id="boldBtn"><b>B</b></button>
        <button id="italicBtn"><i>I</i></button>
        <button id="underlineBtn"><u>U</u></button>
        <select id="fontSizeSel" title="Font size">
          <option value="12">12</option><option value="14" selected>14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option><option value="24">24</option>
        </select>
        <input id="textColor" type="color" value="#111827" title="Text color" />
        <input id="bgColor" type="color" value="#ffffff" title="Cell background" />
        <select id="alignSel" title="Alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
      </div>
    </div>
    <div class="hint io-status" id="ioStatus" aria-live="polite">Storage ready.</div>
    <div class="chartPanel" id="chartPanel">
      <div class="chartPanelHead">
        <strong id="chartTitle">Selection Chart</strong>
        <button id="closeChartBtn" title="Close chart">✕</button>
      </div>
      <canvas id="chartCanvas" height="180"></canvas>
    </div>
    <div class="statsPanel" id="statsPanel"></div>
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
const chartBtn = document.getElementById('chartBtn') as HTMLButtonElement;
const statsBtn = document.getElementById('statsBtn') as HTMLButtonElement;
const chartTypeSel = document.getElementById('chartTypeSel') as HTMLSelectElement;
const chartPanel = document.getElementById('chartPanel') as HTMLDivElement;
const statsPanel = document.getElementById('statsPanel') as HTMLDivElement;
const chartCanvas = document.getElementById('chartCanvas') as HTMLCanvasElement;
const chartTitle = document.getElementById('chartTitle') as HTMLHeadingElement;
const closeChartBtn = document.getElementById('closeChartBtn') as HTMLButtonElement;
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
Chart.register(...registerables);

const storageApi = (window as any).yaar?.storage;

let ioStatusTimer: number | undefined;
let selectionChart: Chart | null = null;

function setIoStatus(message: string, isError = false) {
  ioStatus.textContent = `[${format(new Date(), 'HH:mm:ss')}] ${message}`;
  ioStatus.style.display = 'block';
  ioStatus.style.color = isError ? '#b42318' : '#374151';
  ioStatus.style.borderColor = isError ? '#f6b5ad' : '#d8e1ef';

  if (ioStatusTimer) window.clearTimeout(ioStatusTimer);
  ioStatusTimer = window.setTimeout(() => {
    ioStatus.style.display = 'none';
  }, isError ? 4200 : 2400);
}

function storagePath() {
  const path = storagePathInput.value.trim() || 'excel-lite/sheet.xlsx';
  storagePathInput.value = path;
  return path;
}

const autosavePath = 'excel-lite/autosave.json';

const autosaveWorkbook = debounce(async () => {
  if (!storageApi) return;
  try {
    await storageApi.save(autosavePath, serializeWorkbook());
  } catch {
    // ignore autosave errors; explicit save still reports errors
  }
}, 1400);

function scheduleAutosave() {
  void autosaveWorkbook();
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
  scheduleAutosave();
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
  scheduleAutosave();
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
  scheduleAutosave();
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
  scheduleAutosave();
}

function renderSelectionChart() {
  const rect = rangeRect(selectionStart, selectionEnd);
  const refs = refsInRect(rect);
  const points = selectionChartPoints(refs, cells, (ref) => formulaEngine.display(ref));

  if (!points.length) {
    setIoStatus('Selection has no numeric values for charting.', true);
    return;
  }

  const chartType = chartTypeSel.value as 'bar' | 'line' | 'pie';
  selectionChart?.destroy();
  selectionChart = new Chart(chartCanvas, {
    type: chartType,
    data: {
      labels: points.map((p) => p.label),
      datasets: [
        {
          label: chartType.toUpperCase(),
          data: points.map((p) => p.value),
          borderColor: '#2a6df6',
          backgroundColor: chartType === 'pie'
            ? ['#2a6df6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe', '#2563eb']
            : 'rgba(42, 109, 246, 0.35)',
          borderWidth: 2,
          fill: chartType === 'line',
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: chartType === 'pie',
        },
      },
    },
  });

  chartTitle.textContent = `${selectionStart === selectionEnd ? selected : `${selectionStart}:${selectionEnd}`} (${points.length} pts)`;
  chartPanel.classList.add('open');
  setIoStatus(`Rendered ${chartType} chart from selection.`);
}

function renderSelectionStats() {
  const rect = rangeRect(selectionStart, selectionEnd);
  const refs = refsInRect(rect);
  const numeric = refs
    .map((ref) => Number.parseFloat(formulaEngine.display(ref)))
    .filter((value) => Number.isFinite(value));

  if (!numeric.length) {
    setIoStatus('Selection has no numeric values for stats.', true);
    return;
  }

  const rows = [
    { label: 'Count', value: String(numeric.length) },
    { label: 'Sum', value: d3.format(',.4~f')(d3.sum(numeric)) },
    { label: 'Mean', value: d3.format(',.4~f')(d3.mean(numeric) ?? 0) },
    { label: 'Median', value: d3.format(',.4~f')(d3.median(numeric) ?? 0) },
    { label: 'Min', value: d3.format(',.4~f')(d3.min(numeric) ?? 0) },
    { label: 'Max', value: d3.format(',.4~f')(d3.max(numeric) ?? 0) },
  ];

  statsPanel.innerHTML = `
    <div class="chartPanelHead">
      <strong>Selection Stats</strong>
      <span>${selectionStart === selectionEnd ? selected : `${selectionStart}:${selectionEnd}`}</span>
    </div>
    <div class="statsGrid">
      ${rows.map((row) => `<div class="statCard"><div class="statLabel">${row.label}</div><div class="statValue">${row.value}</div></div>`).join('')}
    </div>
  `;
  statsPanel.classList.add('open');
  setIoStatus('Computed stats with d3 for selected range.');
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
  scheduleAutosave();
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
      }
      return;
    }

    const data = await storageApi.read(path, { as: 'arraybuffer' });
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    const parsed = parseXlsxWorkbook(bytes);
    importWorkbook(parsed);
    setIoStatus(`Opened XLSX from storage: ${path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to open file';
    setIoStatus(message, true);
  }
}

saveBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(serializeWorkbook());
    setIoStatus('Workbook JSON copied to clipboard.');
  } catch {
    alert('Clipboard access failed. Use Save Store instead.');
  }
});

loadBtn.addEventListener('click', () => {
  const text = prompt('Paste JSON: { cells: {...}, styles: {...} } (legacy cell map also supported)');
  if (!text) return;

  if (tryImportWorkbook(text, 'Invalid JSON')) {
    setIoStatus('Loaded workbook from pasted JSON.');
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
  setIoStatus('CSV exported.');
});

chartBtn.addEventListener('click', () => {
  renderSelectionChart();
});

statsBtn.addEventListener('click', () => {
  renderSelectionStats();
});

chartTypeSel.addEventListener('change', () => {
  if (chartPanel.classList.contains('open')) renderSelectionChart();
});

closeChartBtn.addEventListener('click', () => {
  selectionChart?.destroy();
  selectionChart = null;
  chartPanel.classList.remove('open');
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

async function tryRecoverAutosave() {
  if (!storageApi) return;
  if (Object.keys(cells).length > 0) return;

  try {
    const raw = await storageApi.read(autosavePath, { as: 'text' });
    if (typeof raw !== 'string' || !raw.trim()) return;
    if (tryImportWorkbook(raw, 'Autosave is corrupted and could not be restored.')) {
      setIoStatus(`Recovered autosave from ${autosavePath}`);
    }
  } catch {
    // no autosave yet
  }
}

void tryRecoverAutosave();

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
          scheduleAutosave();
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
          scheduleAutosave();
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
          scheduleAutosave();
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
