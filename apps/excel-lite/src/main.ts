class Chart {
  static register(..._args: any[]) {}
  private canvas: HTMLCanvasElement;
  private cfg: any;
  constructor(canvas: HTMLCanvasElement, cfg: any) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.render();
  }
  destroy() {
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  private render() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const values = this.cfg.data.datasets[0]?.data ?? [];
    if (!values.length) return;
    const max = Math.max(...values, 1);

    if (this.cfg.type === 'pie') {
      let start = -Math.PI / 2;
      const total = values.reduce((a, b) => a + b, 0) || 1;
      values.forEach((v, i) => {
        const end = start + (v / total) * Math.PI * 2;
        const hue = (i * 57) % 360;
        ctx.fillStyle = `hsl(${hue} 75% 55%)`;
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.38, start, end);
        ctx.closePath();
        ctx.fill();
        start = end;
      });
      return;
    }

    const n = values.length;
    const padding = 24;
    const innerW = w - padding * 2;
    const innerH = h - padding * 2;

    ctx.strokeStyle = '#9aa7bd';
    ctx.beginPath();
    ctx.moveTo(padding, h - padding);
    ctx.lineTo(w - padding, h - padding);
    ctx.stroke();

    if (this.cfg.type === 'line') {
      ctx.strokeStyle = '#2a6df6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = padding + (i / Math.max(1, n - 1)) * innerW;
        const y = h - padding - (v / max) * innerH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      return;
    }

    const barW = innerW / n;
    values.forEach((v, i) => {
      const x = padding + i * barW + 3;
      const bh = (v / max) * innerH;
      const y = h - padding - bh;
      ctx.fillStyle = 'rgba(42,109,246,0.6)';
      ctx.fillRect(x, y, Math.max(2, barW - 6), bh);
    });
  }
}

const registerables: any[] = [];

function format(date: Date, pattern: string) {
  if (pattern !== 'HH:mm:ss') return date.toISOString();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
}

const d3 = {
  format: (_fmt: string) => (n: number) => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '0',
  sum: (arr: number[]) => arr.reduce((a, b) => a + b, 0),
  mean: (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined),
  median: (arr: number[]) => {
    if (!arr.length) return undefined;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },
  min: (arr: number[]) => (arr.length ? Math.min(...arr) : undefined),
  max: (arr: number[]) => (arr.length ? Math.max(...arr) : undefined),
};

function debounce<T extends (...args: any[]) => any>(fn: T, wait = 300) {
  let t: number | null = null;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => fn(...args), wait);
  };
}
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
import { css, html, mount, signal, show } from '@bundled/yaar';

// ── UI Signals ────────────────────────────────────────────────────────
const ioStatusText = signal('');
const ioStatusVisible = signal(false);
const ioStatusIsError = signal(false);
const chartPanelOpen = signal(false);
const chartTitleText = signal('Selection Chart');
interface StatRow { label: string; value: string; }
const statsRows = signal<StatRow[]>([]);
const statsRangeLabel = signal('');
const statsPanelOpen = signal(false);

// ── Refs ──────────────────────────────────────────────────────────────
let sheetEl!: HTMLDivElement;
let formulaInput!: HTMLInputElement;
let cellName!: HTMLDivElement;
let boldBtn!: HTMLButtonElement;
let italicBtn!: HTMLButtonElement;
let underlineBtn!: HTMLButtonElement;
let fontSizeSel!: HTMLSelectElement;
let textColor!: HTMLInputElement;
let bgColor!: HTMLInputElement;
let alignSel!: HTMLSelectElement;
let storagePathInput!: HTMLInputElement;
let chartTypeSel!: HTMLSelectElement;
let chartCanvas!: HTMLCanvasElement;

// ── CSS ───────────────────────────────────────────────────────────────
css`
  :root {
    color-scheme: light;
    --yaar-bg: #f8f9fa;
    --yaar-bg-surface: #ffffff;
    --yaar-bg-surface-hover: #f0f1f3;
    --yaar-text: #1f2328;
    --yaar-text-muted: #656d76;
    --yaar-text-dim: #8b949e;
    --yaar-border: #d0d7de;
    --yaar-shadow-sm: 0 1px 2px rgba(0,0,0,.08);
    --yaar-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  body { margin: 0; font-family: Inter, Arial, sans-serif; background: var(--yaar-bg); user-select: none; color: var(--yaar-text); }
  .wrap { padding: 10px; display: grid; gap: 8px; }
  .toolbar {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--yaar-border);
    border-radius: 12px;
    background: var(--yaar-bg-surface);
    box-shadow: var(--yaar-shadow-sm);
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
    border: 1px solid var(--yaar-border);
    border-radius: 8px;
    padding: 7px 8px;
    background: var(--yaar-bg);
  }
  input, select {
    height: 34px;
    padding: 6px 9px;
    border: 1px solid var(--yaar-border);
    border-radius: 8px;
    font-size: 13px;
    background: var(--yaar-bg-surface);
    box-sizing: border-box;
  }
  #formulaInput { width: 100%; }
  #storagePathInput { min-width: 260px; }
  #textColor, #bgColor { width: 42px; padding: 2px; }
  button.active { background: #dce8ff; border-color: #89abf0; }
  .sheetWrap { overflow: auto; border: 1px solid var(--yaar-border); border-radius: 10px; background: var(--yaar-bg-surface); max-height: calc(100vh - 160px); }
  .chartPanel {
    border: 1px solid var(--yaar-border);
    border-radius: 10px;
    background: var(--yaar-bg-surface);
    padding: 8px;
    display: none;
    min-height: 220px;
  }
  .chartPanel.open { display: block; }
  .chartPanelHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: var(--yaar-text);
    font-size: 13px;
  }
  #chartCanvas { width: 100%; max-height: 220px; }
  .statsPanel {
    border: 1px solid var(--yaar-border);
    border-radius: 10px;
    background: var(--yaar-bg-surface);
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
    border: 1px solid var(--yaar-border);
    border-radius: 8px;
    background: var(--yaar-bg);
    padding: 8px;
  }
  .statLabel { font-size: 11px; color: var(--yaar-text-muted); }
  .statValue { font-size: 14px; font-weight: 700; color: var(--yaar-text); margin-top: 2px; }
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
    border: 1px solid var(--yaar-border);
    background: rgba(255, 255, 255, 0.95);
    color: var(--yaar-text);
    box-shadow: var(--yaar-shadow);
  }
  @media (max-width: 1200px) {
    #formulaInput, #storagePathInput { min-width: 220px; }
  }
`;

// ── App Shell ─────────────────────────────────────────────────────────
mount(html`
  <div class="wrap">
    <div class="toolbar">
      <div class="toolbar-row file">
        <button class="y-btn y-btn-sm" onClick=${() => saveWorkbookToStorage()} title="Save workbook XLSX to YAAR storage" aria-label="Save File">&#x1F4BE;</button>
        <button class="y-btn y-btn-sm" onClick=${() => openWorkbookFromStorage()} title="Open workbook from YAAR storage (XLSX/JSON)" aria-label="Open File">&#x1F4C2;</button>
        <button class="y-btn y-btn-sm" onClick=${async () => {
          try {
            await navigator.clipboard.writeText(serializeWorkbook());
            setIoStatus('Workbook JSON copied to clipboard.');
          } catch {
            alert('Clipboard access failed. Use Save Store instead.');
          }
        }} title="Copy sheet JSON to clipboard" aria-label="Copy JSON">&#x2398;</button>
        <button class="y-btn y-btn-sm" onClick=${() => {
          const text = prompt('Paste JSON: { cells: {...}, styles: {...} } (legacy cell map also supported)');
          if (!text) return;
          if (tryImportWorkbook(text, 'Invalid JSON')) {
            setIoStatus('Loaded workbook from pasted JSON.');
          }
        }} title="Paste sheet JSON from a dialog" aria-label="Paste JSON">&#x1F4CB;</button>
        <button class="y-btn y-btn-sm" onClick=${() => { exportCsv(); setIoStatus('CSV exported.'); }} title="Export CSV" aria-label="Export CSV">&#x2B07;</button>
        <button class="y-btn y-btn-sm" onClick=${() => renderSelectionChart()} title="Create chart from selection" aria-label="Chart Selection">&#x1F4CA;</button>
        <button class="y-btn y-btn-sm" onClick=${() => renderSelectionStats()} title="Selection statistics" aria-label="Selection Statistics">&#x3A3;</button>
        <select ref=${(el: HTMLSelectElement) => { chartTypeSel = el; }} title="Chart type"
          onChange=${() => { if (chartPanelOpen()) renderSelectionChart(); }}>
          <option value="bar">Bar</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
        </select>
        <input id="storagePathInput" ref=${(el: HTMLInputElement) => { storagePathInput = el; }} title="Storage path" value="excel-lite/sheet.xlsx" />
      </div>
      <div class="toolbar-row edit">
        <button class="y-btn y-btn-sm" onClick=${() => undo()} title="Undo" aria-label="Undo">&#x21B6;</button>
        <button class="y-btn y-btn-sm" onClick=${() => redo()} title="Redo" aria-label="Redo">&#x21B7;</button>
        <div class="name" ref=${(el: HTMLDivElement) => { cellName = el; }}>A1</div>
        <input class="y-input" id="formulaInput" ref=${(el: HTMLInputElement) => { formulaInput = el; }}
          placeholder="Value or formula (=A1+B1, =SUM(A1:A10))"
          onKeydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              commitCell(selected, formulaInput.value);
              inputs.get(selected)?.focus();
            }
          }} />
        <button class="y-btn y-btn-sm" ref=${(el: HTMLButtonElement) => { boldBtn = el; }}
          onClick=${() => toggleStyle('bold')}><b>B</b></button>
        <button class="y-btn y-btn-sm" ref=${(el: HTMLButtonElement) => { italicBtn = el; }}
          onClick=${() => toggleStyle('italic')}><i>I</i></button>
        <button class="y-btn y-btn-sm" ref=${(el: HTMLButtonElement) => { underlineBtn = el; }}
          onClick=${() => toggleStyle('underline')}><u>U</u></button>
        <select ref=${(el: HTMLSelectElement) => { fontSizeSel = el; }} title="Font size"
          onChange=${() => applyStyleToSelection({ fontSize: Number(fontSizeSel.value) })}>
          <option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option><option value="24">24</option>
        </select>
        <input id="textColor" type="color" ref=${(el: HTMLInputElement) => { textColor = el; }} value="#111827" title="Text color"
          onChange=${() => applyStyleToSelection({ color: textColor.value })} />
        <input id="bgColor" type="color" ref=${(el: HTMLInputElement) => { bgColor = el; }} value="#ffffff" title="Cell background"
          onChange=${() => applyStyleToSelection({ bg: bgColor.value })} />
        <select ref=${(el: HTMLSelectElement) => { alignSel = el; }} title="Alignment"
          onChange=${() => applyStyleToSelection({ align: alignSel.value as Align })}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </select>
      </div>
    </div>

    ${show(() => ioStatusVisible(), () => html`
      <div class="io-status"
        style=${() => `color:${ioStatusIsError() ? '#b42318' : '#374151'};border-color:${ioStatusIsError() ? '#f6b5ad' : '#d8e1ef'}`}>
        ${() => ioStatusText()}
      </div>
    `)}

    <div class=${() => `chartPanel${chartPanelOpen() ? ' open' : ''}`}>
      <div class="chartPanelHead">
        <strong>${() => chartTitleText()}</strong>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => {
          selectionChart?.destroy();
          selectionChart = null;
          chartPanelOpen(false);
        }} title="Close chart">&#x2715;</button>
      </div>
      <canvas ref=${(el: HTMLCanvasElement) => { chartCanvas = el; }} id="chartCanvas" height="180"></canvas>
    </div>

    <div class=${() => `statsPanel${statsPanelOpen() ? ' open' : ''}`}>
      ${show(() => statsPanelOpen(), () => html`
        <div class="chartPanelHead">
          <strong>Selection Stats</strong>
          <span>${() => statsRangeLabel()}</span>
        </div>
        <div class="statsGrid">
          ${() => statsRows().map(row => html`
            <div class="statCard">
              <div class="statLabel">${row.label}</div>
              <div class="statValue">${row.value}</div>
            </div>
          `)}
        </div>
      `)}
    </div>

    <div class="sheetWrap y-scroll" ref=${(el: HTMLDivElement) => { sheetEl = el; }}></div>
  </div>
`);

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
  ioStatusText(`[${format(new Date(), 'HH:mm:ss')}] ${message}`);
  ioStatusIsError(isError);
  ioStatusVisible(true);

  if (ioStatusTimer) window.clearTimeout(ioStatusTimer);
  ioStatusTimer = window.setTimeout(() => {
    ioStatusVisible(false);
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

  chartTitleText(`${selectionStart === selectionEnd ? selected : `${selectionStart}:${selectionEnd}`} (${points.length} pts)`);
  chartPanelOpen(true);
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

  statsRows(rows);
  statsRangeLabel(selectionStart === selectionEnd ? selected : `${selectionStart}:${selectionEnd}`);
  statsPanelOpen(true);
  setIoStatus('Computed stats for selected range.');
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
