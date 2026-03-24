import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import {
  storageRead,
  autosavePath,
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
import { onShortcut } from '@bundled/yaar';

// ── Mount ─────────────────────────────────────────────────────
render(() => html`
  <div class="wrap y-light">
    ${createToolbar()}
    ${createChartPanel()}
    ${createStatsPanel()}
    ${createGrid()}
  </div>
`, document.getElementById('app')!);

// ── Build grid imperatively (refs are set after mount) ──────────────────
buildSheet();
refreshAll();

// ── Global event listeners ─────────────────────────────────────────
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

// Ctrl/Cmd shortcuts via SDK
onShortcut('ctrl+s', () => void saveWorkbookToStorage());
onShortcut('ctrl+o', () => void openWorkbookFromStorage());
onShortcut('ctrl+shift+z', () => redo());
onShortcut('ctrl+z', () => undo());
onShortcut('ctrl+y', () => redo());
onShortcut('ctrl+b', () => toggleStyle('bold'));
onShortcut('ctrl+i', () => toggleStyle('italic'));
onShortcut('ctrl+u', () => toggleStyle('underline'));

// Delete key (no modifier, conditional on focus target)
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const isFormula = target === refs.formulaInput;
  if (e.key === 'Delete' && !isFormula) {
    clearSelectionValues();
  }
});

// ── Autosave recovery ───────────────────────────────────────────
async function tryRecoverAutosave() {
  if (Object.keys(cells).length > 0) return;
  try {
    const raw = await storageRead(autosavePath, 'text');
    if (typeof raw !== 'string' || !raw.trim()) return;
    if (tryImportWorkbook(raw, 'Autosave is corrupted and could not be restored.')) {
      setIoStatus(`Recovered autosave from ${autosavePath}`);
    }
  } catch {
    // no autosave yet
  }
}

void tryRecoverAutosave();

// ── App Protocol ────────────────────────────────────────────────
registerAppProtocol();
