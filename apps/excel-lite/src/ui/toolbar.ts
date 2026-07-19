import html from '@bundled/solid-js/html';
import { showToast, showPrompt } from '@bundled/yaar';
import {
  chartPanelOpen,
  refs,
  mutable,
  applyStyleToSelection,
  toggleStyle,
  undo,
  redo,
  setIoStatus,
  serializeWorkbook,
  tryImportWorkbook,
  commitCell,
  inputs,
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
    showToast('Clipboard access failed. Use Save Store instead.', 'error');
  }
}

async function pasteFromClipboard() {
  const text = await showPrompt(
    'Paste JSON: { cells: {...}, styles: {...} } (legacy cell map also supported)',
  );
  if (!text) return;
  if (tryImportWorkbook(text, 'Invalid JSON')) {
    setIoStatus('Loaded workbook from pasted JSON.');
  }
}

/** Top header bar: logo badge, file-name field, primary document actions. */
export function createHeader() {
  return html`
    <div class="topbar">
      <div class="brand">
        <span class="brand-badge">X</span>
        <span class="brand-name">Excel Lite</span>
      </div>

      <div class="doc-meta">
        <span class="doc-icon">▦</span>
        <input
          class="doc-title-input"
          id="storagePathInput"
          ref=${(el: HTMLInputElement) => {
            refs.storagePathInput = el;
          }}
          title="Storage path"
          placeholder="sheet.xlsx"
          value="sheet.xlsx"
        />
      </div>

      <div class="header-actions">
        <button
          class="tb-btn tb-btn-text"
          onClick=${() => void openWorkbookFromStorage()}
          title="Open workbook from YAAR storage (Ctrl+O)"
        >
          <span class="tb-ico">◧</span><span class="tb-label">Open</span>
        </button>
        <button
          class="tb-btn tb-btn-text tb-btn-primary"
          onClick=${() => void saveWorkbookToStorage()}
          title="Save workbook to YAAR storage (Ctrl+S)"
        >
          <span class="tb-ico">↓</span><span class="tb-label">Save</span>
        </button>
      </div>
    </div>
  `;
}

/** Formatting toolbar: segmented groups, export pill group. */
export function createToolbar() {
  return html`
    <div class="toolbar">
      <div class="toolbar-row">
        <div class="tb-group">
          <button class="tb-btn" onClick=${() => undo()} title="Undo (Ctrl+Z)" aria-label="Undo">
            ↶
          </button>
          <button class="tb-btn" onClick=${() => redo()} title="Redo (Ctrl+Y)" aria-label="Redo">
            ↷
          </button>
        </div>

        <span class="tb-sep"></span>

        <div class="tb-group">
          <button
            class="tb-btn"
            ref=${(el: HTMLButtonElement) => {
              refs.boldBtn = el;
            }}
            onClick=${() => toggleStyle('bold')}
            title="Bold (Ctrl+B)"
            aria-label="Bold"
          >
            <b>B</b>
          </button>
          <button
            class="tb-btn"
            ref=${(el: HTMLButtonElement) => {
              refs.italicBtn = el;
            }}
            onClick=${() => toggleStyle('italic')}
            title="Italic (Ctrl+I)"
            aria-label="Italic"
          >
            <i>I</i>
          </button>
          <button
            class="tb-btn"
            ref=${(el: HTMLButtonElement) => {
              refs.underlineBtn = el;
            }}
            onClick=${() => toggleStyle('underline')}
            title="Underline (Ctrl+U)"
            aria-label="Underline"
          >
            <u>U</u>
          </button>
        </div>

        <span class="tb-sep"></span>

        <div class="tb-group">
          <select
            class="tb-select"
            ref=${(el: HTMLSelectElement) => {
              refs.fontSizeSel = el;
            }}
            title="Font size"
            onChange=${(e: Event) =>
              applyStyleToSelection({ fontSize: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value="12">12</option>
            <option value="14">14</option>
            <option value="16">16</option>
            <option value="18">18</option>
            <option value="20">20</option>
            <option value="24">24</option>
          </select>
          <label class="color-field" title="Text color">
            <span class="color-glyph">A</span>
            <input
              id="textColor"
              class="color-swatch"
              type="color"
              ref=${(el: HTMLInputElement) => {
                refs.textColor = el;
              }}
              value="#e6edf3"
              aria-label="Text color"
              onChange=${(e: Event) =>
                applyStyleToSelection({ color: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="color-field" title="Cell background">
            <span class="color-glyph">■</span>
            <input
              id="bgColor"
              class="color-swatch"
              type="color"
              ref=${(el: HTMLInputElement) => {
                refs.bgColor = el;
              }}
              value="#ffffff"
              aria-label="Cell background"
              onChange=${(e: Event) =>
                applyStyleToSelection({ bg: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>

        <span class="tb-sep"></span>

        <div class="tb-group">
          <select
            class="tb-select"
            ref=${(el: HTMLSelectElement) => {
              refs.alignSel = el;
            }}
            title="Alignment"
            onChange=${(e: Event) =>
              applyStyleToSelection({ align: (e.target as HTMLSelectElement).value as Align })}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>

        <span class="tb-sep"></span>

        <div class="tb-group">
          <button
            class="tb-btn"
            onClick=${() => renderSelectionChart()}
            title="Chart from selection"
            aria-label="Chart Selection"
          >
            <span class="tb-ico">◫</span>
          </button>
          <select
            class="tb-select"
            ref=${(el: HTMLSelectElement) => {
              refs.chartTypeSel = el;
            }}
            title="Chart type"
            onChange=${() => {
              if (chartPanelOpen()) renderSelectionChart();
            }}
          >
            <option value="bar">Bar</option>
            <option value="line">Line</option>
            <option value="pie">Pie</option>
            <option value="doughnut">Doughnut</option>
            <option value="scatter">Scatter</option>
          </select>
          <button
            class="tb-btn"
            onClick=${() => renderSelectionStats()}
            title="Selection statistics"
            aria-label="Selection Statistics"
          >
            <span class="tb-ico">Σ</span>
          </button>
        </div>

        <span class="tb-spacer"></span>

        <div class="tb-group tb-export">
          <span class="tb-export-icon">⤓</span>
          <button class="tb-chip" onClick=${exportCsvAndNotify} title="Export as CSV">.csv</button>
          <button class="tb-chip" onClick=${() => void copyToClipboard()} title="Copy workbook JSON">
            .json
          </button>
          <button class="tb-chip" onClick=${pasteFromClipboard} title="Paste workbook JSON">
            paste
          </button>
        </div>
      </div>

      <div class="formula-bar">
        <div
          class="name"
          ref=${(el: HTMLDivElement) => {
            refs.cellName = el;
          }}
        >
          A1
        </div>
        <span class="fx-label">fx</span>
        <input
          class="y-input"
          id="formulaInput"
          ref=${(el: HTMLInputElement) => {
            refs.formulaInput = el;
          }}
          placeholder="Value or formula (=A1+B1, =SUM(A1:A10))"
          onKeydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              commitCell(mutable.selected, refs.formulaInput!.value);
              inputs.get(mutable.selected)?.focus();
            }
          }}
        />
      </div>
    </div>
  `;
}

/** Bottom status bar: selection stats on the left, IO status badge on the right. */
export function createStatusBar() {
  return html`
    <div class="statusbar">
      <div
        class="status-stats"
        ref=${(el: HTMLDivElement) => {
          refs.statusStats = el;
        }}
      >
        A1
      </div>
      <div
        class="status-save"
        ref=${(el: HTMLDivElement) => {
          refs.statusBadge = el;
        }}
      >
        Ready
      </div>
    </div>
  `;
}
