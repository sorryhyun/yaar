import { html, mount, show } from '@bundled/yaar';
import './styles.css';
import {
  ioStatusVisible, ioStatusText, ioStatusIsError,
  storageApi, autosavePath,
  cells, mutable, refs,
  setIoStatus, tryImportWorkbook,
  toggleStyle, clearSelectionValues,
  undo, redo,
  refreshAll,
  clearHighlights,
} from './state';
import { saveWorkbookToStorage, openWorkbookFromStorage } from './io-utils';
import { createToolbar } from './ui/toolbar';
import { createChartPanel, createStatsPanel } from './ui/chart-panel';
import { createGrid, buildSheet, applyFill } from './ui/grid';
import { registerAppProtocol } from './protocol';

// ── Mount ─────────────────────────────────────────────────────────────
mount(html`
  <div class="wrap">
    ${createToolbar()}
    ${show(() => ioStatusVisible(), () => html`
      <div class="io-status"
        style=${() => `color:${ioStatusIsError() ? '#b42318' : '#374151'};border-color:${ioStatusIsError() ? '#f6b5ad' : '#d8e1ef'}`}>
        ${() => ioStatusText()}
      </div>
    `)}
    ${createChartPanel()}
    ${createStatsPanel()}
    ${createGrid()}
  </div>
`);

// ── Build grid imperatively (refs are set after mount) ─────────────────
buildSheet();
refreshAll();

// ── Global event listeners ────────────────────────────────────────────
document.addEventListener('mouseup', () => {
  mutable.isSelecting = false;

  if (mutable.isFillDragging) {
    applyFill();
    mutable.isFillDragging = false;
    mutable.fillSource = null;
    mutable.fillTarget = null;
    clearHighlights('fill-preview');
  }
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const isFormula = target === refs.formulaInput;

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

// ── Autosave recovery ─────────────────────────────────────────────────
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

// ── App Protocol ──────────────────────────────────────────────────────
registerAppProtocol();
