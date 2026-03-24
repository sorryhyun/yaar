import html from '@bundled/solid-js/html';
import {
  chartPanelOpen, setChartPanelOpen, refs, mutable,
  applyStyleToSelection, toggleStyle,
  undo, redo,
  setIoStatus, serializeWorkbook, tryImportWorkbook,
  commitCell, inputs,
} from '../state';
import { saveWorkbookToStorage, openWorkbookFromStorage, exportCsv } from '../io-utils';
import { renderSelectionChart, renderSelectionStats } from '../render-utils';
import type { Align } from '../types';

function exportCsvAndNotify() {
  exportCsv();
  setIoStatus('CSV exported.');
}

async function copyToClipboard() {
  try {
    await navigator.clipboard.writeText(serializeWorkbook());
    setIoStatus('Workbook JSON copied to clipboard.');
  } catch {
    alert('Clipboard access failed. Use Save Store instead.');
  }
}

function pasteFromClipboard() {
  const text = prompt('Paste JSON: { cells: {...}, styles: {...} } (legacy cell map also supported)');
  if (!text) return;
  if (tryImportWorkbook(text, 'Invalid JSON')) {
    setIoStatus('Loaded workbook from pasted JSON.');
  }
}

export function createToolbar() {
  return html`
    <div class="toolbar">
      <div class="toolbar-row file">
        <button class="y-btn y-btn-sm" onClick=${() => void saveWorkbookToStorage()} title="Save workbook XLSX to YAAR storage" aria-label="Save File">💾</button>
        <button class="y-btn y-btn-sm" onClick=${() => void openWorkbookFromStorage()} title="Open workbook from YAAR storage (XLSX/JSON)" aria-label="Open File">📂</button>
        <button class="y-btn y-btn-sm" onClick=${() => void copyToClipboard()} title="Copy sheet JSON to clipboard" aria-label="Copy JSON">⎘</button>
        <button class="y-btn y-btn-sm" onClick=${pasteFromClipboard} title="Paste sheet JSON from a dialog" aria-label="Paste JSON">📋</button>
        <button class="y-btn y-btn-sm" onClick=${exportCsvAndNotify} title="Export CSV" aria-label="Export CSV">⬇</button>
        <button class="y-btn y-btn-sm" onClick=${() => renderSelectionChart()} title="Create chart from selection" aria-label="Chart Selection">📊</button>
        <button class="y-btn y-btn-sm" onClick=${() => renderSelectionStats()} title="Selection statistics" aria-label="Selection Statistics">Σ</button>
        <select ref=${(el: HTMLSelectElement) => { refs.chartTypeSel = el; }} title="Chart type"
          onChange=${() => { if (chartPanelOpen()) renderSelectionChart(); }} >
          <option value="bar">Bar</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
          <option value="doughnut">Doughnut</option>
          <option value="scatter">Scatter</option>
        </select>
        <input id="storagePathInput" ref=${(el: HTMLInputElement) => { refs.storagePathInput = el; }} title="Storage path" value="sheet.xlsx" />
      </div>
      <div class="toolbar-row edit">
        <button class="y-btn y-btn-sm" onClick=${() => undo()} title="Undo" aria-label="Undo">↶</button>
        <button class="y-btn y-btn-sm" onClick=${() => redo()} title="Redo" aria-label="Redo">↷</button>
        <div class="name" ref=${(el: HTMLDivElement) => { refs.cellName = el; }}>A1</div>
        <input class="y-input" id="formulaInput" ref=${(el: HTMLInputElement) => { refs.formulaInput = el; }}
          placeholder="Value or formula (=A1+B1, =SUM(A1:A10))"
          onKeydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              commitCell(mutable.selected, refs.formulaInput!.value);
              inputs.get(mutable.selected)?.focus();
            }
          }} />
        <button class="y-btn y-btn-sm" ref=${(el: HTMLButtonElement) => { refs.boldBtn = el; }}
          onClick=${() => toggleStyle('bold')}><b>B</b></button>
        <button class="y-btn y-btn-sm" ref=${(el: HTMLButtonElement) => { refs.italicBtn = el; }}
          onClick=${() => toggleStyle('italic')}><i>I</i></button>
        <button class="y-btn y-btn-sm" ref=${(el: HTMLButtonElement) => { refs.underlineBtn = el; }}
          onClick=${() => toggleStyle('underline')}><u>U</u></button>
        <select ref=${(el: HTMLSelectElement) => { refs.fontSizeSel = el; }} title="Font size"
          onChange=${(e: Event) => applyStyleToSelection({ fontSize: Number((e.target as HTMLSelectElement).value) })}>
          <option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option><option value="24">24</option>
        </select>
        <input id="textColor" type="color" ref=${(el: HTMLInputElement) => { refs.textColor = el; }} value="#e6edf3" title="Text color"
          onChange=${(e: Event) => applyStyleToSelection({ color: (e.target as HTMLInputElement).value })} />
        <input id="bgColor" type="color" ref=${(el: HTMLInputElement) => { refs.bgColor = el; }} value="#ffffff" title="Cell background"
          onChange=${(e: Event) => applyStyleToSelection({ bg: (e.target as HTMLInputElement).value })} />
        <select ref=${(el: HTMLSelectElement) => { refs.alignSel = el; }} title="Alignment"
          onChange=${(e: Event) => applyStyleToSelection({ align: (e.target as HTMLSelectElement).value as Align })}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </select>
      </div>
    </div>
  `;
}
