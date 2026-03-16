import { createSignal } from '@bundled/solid-js';
import { format } from '@bundled/date-fns';
import { debounce } from '@bundled/lodash';
import { appStorage } from '@bundled/yaar';
import { createFormulaEngine } from './formula-utils';
import { cloneMap } from './data-utils';
import { applySnapshotToMaps, pushHistorySnapshot } from './history-utils';
import { rangeRect, refsInRect } from './ref-utils';
import { getStyleForRef, normalizeStyle } from './style-utils';
import type { Align, CellMap, CellStyle, CellStyleMap, Rect, Snapshot } from './types';

// ── UI Signals ────────────────────────────────────────────────────────
export const [chartPanelOpen, setChartPanelOpen] = createSignal(false);
export const [chartTitleText, setChartTitleText] = createSignal('Selection Chart');
export interface StatRow { label: string; value: string; }
export const [statsRows, setStatsRows] = createSignal<StatRow[]>([]);
export const [statsRangeLabel, setStatsRangeLabel] = createSignal('');
export const [statsPanelOpen, setStatsPanelOpen] = createSignal(false);

// ── Shared mutable state object ───────────────────────────────────────
// All mutable primitives and DOM refs live here so any module can
// read/write by property access without ESM live-binding concerns.
export const refs = {
  sheetEl: null as HTMLDivElement | null,
  formulaInput: null as HTMLInputElement | null,
  cellName: null as HTMLDivElement | null,
  boldBtn: null as HTMLButtonElement | null,
  italicBtn: null as HTMLButtonElement | null,
  underlineBtn: null as HTMLButtonElement | null,
  fontSizeSel: null as HTMLSelectElement | null,
  textColor: null as HTMLInputElement | null,
  bgColor: null as HTMLInputElement | null,
  alignSel: null as HTMLSelectElement | null,
  storagePathInput: null as HTMLInputElement | null,
  chartTypeSel: null as HTMLSelectElement | null,
  chartCanvas: null as HTMLCanvasElement | null,
};

export const mutable = {
  selected: 'A1',
  selectionStart: 'A1',
  selectionEnd: 'A1',
  editingRef: null as string | null,
  isSelecting: false,
  isFillDragging: false,
  fillSource: null as Rect | null,
  fillTarget: null as string | null,
};

// ── Mutable Data Stores ───────────────────────────────────────────────
export const cells: CellMap = {};
export const styles: CellStyleMap = {};
export const inputs = new Map<string, HTMLInputElement>();
export const tds = new Map<string, HTMLTableCellElement>();

export const fillHandle = document.createElement('div');
fillHandle.className = 'fill-handle';

export const history: Snapshot[] = [];
export const future: Snapshot[] = [];

// ── Storage helpers using @bundled/yaar ───────────────────────────────

export async function storageSave(path: string, content: string | Uint8Array): Promise<void> {
  if (content instanceof Uint8Array) {
    let binary = '';
    for (let i = 0; i < content.length; i++) binary += String.fromCharCode(content[i]);
    await appStorage.save(path, btoa(binary), { encoding: 'base64' });
  } else {
    await appStorage.save(path, content);
  }
}

export async function storageRead(path: string, as: 'text' | 'json' | 'arraybuffer' = 'text'): Promise<any> {
  if (as === 'arraybuffer') {
    const { data } = await appStorage.readBinary(path);
    const bin = atob(data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  const text = await appStorage.read(path);
  if (as === 'json') return JSON.parse(text);
  return text;
}

export async function storageList(dir: string): Promise<Array<{ path: string; isDirectory: boolean; size: number; modifiedAt: string }>> {
  try {
    return (await appStorage.list(dir)) as any[];
  } catch {
    return [];
  }
}

export async function storageDelete(path: string): Promise<void> {
  await appStorage.remove(path);
}

// ── Formula Engine ────────────────────────────────────────────────────
export function getRaw(ref: string): string {
  return cells[ref] ?? '';
}

export const formulaEngine = createFormulaEngine(getRaw);

// ── Toast helper ──────────────────────────────────────────────────────
function showToast(msg: string, type: 'info' | 'success' | 'error' = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `y-toast y-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── IO Status ─────────────────────────────────────────────────────────
export function setIoStatus(message: string, isError = false) {
  const timeStr = format(new Date(), 'HH:mm:ss');
  showToast(`[${timeStr}] ${message}`, isError ? 'error' : 'success', isError ? 4200 : 2400);
}

export function storagePath() {
  const path = (refs.storagePathInput!.value.trim()) || 'sheet.xlsx';
  refs.storagePathInput!.value = path;
  return path;
}

// ── History ───────────────────────────────────────────────────────────
export function pushHistory() {
  pushHistorySnapshot(history, future, cells, styles);
}

export function undo() {
  const prev = history.pop();
  if (!prev) return;
  future.push({ cells: cloneMap(cells), styles: cloneMap(styles) });
  applySnapshotToMaps(prev, cells, styles);
  refreshAll();
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  history.push({ cells: cloneMap(cells), styles: cloneMap(styles) });
  applySnapshotToMaps(next, cells, styles);
  refreshAll();
}

// ── UI State Operations ───────────────────────────────────────────────
export function clearHighlights(className: string) {
  tds.forEach(td => td.classList.remove(className));
}

export function updateToolbarState() {
  const style = getStyleForRef(styles, mutable.selected);
  refs.boldBtn?.classList.toggle('active', !!style.bold);
  refs.italicBtn?.classList.toggle('active', !!style.italic);
  refs.underlineBtn?.classList.toggle('active', !!style.underline);
  if (refs.fontSizeSel) refs.fontSizeSel.value = String(style.fontSize);
  if (refs.textColor) refs.textColor.value = style.color;
  if (refs.bgColor) refs.bgColor.value = style.bg;
  if (refs.alignSel) refs.alignSel.value = style.align;
}

export function updateSelectionUI() {
  clearHighlights('selected');
  clearHighlights('active');
  clearHighlights('fill-preview');

  const rect = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  for (const ref of refsInRect(rect)) tds.get(ref)?.classList.add('selected');

  const activeTd = tds.get(mutable.selected);
  if (activeTd) {
    activeTd.classList.add('active');
    activeTd.appendChild(fillHandle);
  }

  if (refs.cellName) {
    refs.cellName.textContent = mutable.selectionStart === mutable.selectionEnd
      ? mutable.selected
      : `${mutable.selectionStart}:${mutable.selectionEnd}`;
  }

  if (refs.formulaInput && mutable.editingRef !== mutable.selected) {
    refs.formulaInput.value = getRaw(mutable.selected);
  }
  updateToolbarState();
}

export function setSelection(start: string, end: string, active = false) {
  mutable.selectionStart = start;
  mutable.selectionEnd = end;
  if (active) mutable.selected = end;
  updateSelectionUI();
}

export function refreshCell(ref: string) {
  const input = inputs.get(ref);
  if (!input) return;

  if (mutable.editingRef !== ref) input.value = formulaEngine.display(ref);

  const style = getStyleForRef(styles, ref);
  input.style.fontWeight = style.bold ? '700' : '400';
  input.style.fontStyle = style.italic ? 'italic' : 'normal';
  input.style.textDecoration = style.underline ? 'underline' : 'none';
  input.style.fontSize = `${style.fontSize}px`;
  input.style.color = style.color;
  input.style.background = style.bg;
  input.style.textAlign = style.align;
}

export function refreshAll() {
  inputs.forEach((_, ref) => refreshCell(ref));
  updateSelectionUI();
}

export function commitCell(ref: string, value: string) {
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

export function applyStyleToSelection(patch: Partial<CellStyle>) {
  pushHistory();
  const rect = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  for (const ref of refsInRect(rect)) {
    const merged = { ...getStyleForRef(styles, ref), ...patch };
    const normalized = normalizeStyle(merged);
    if (normalized) styles[ref] = normalized;
    else delete styles[ref];
  }
  refreshAll();
  scheduleAutosave();
}

export function toggleStyle(styleKey: 'bold' | 'italic' | 'underline') {
  const current = getStyleForRef(styles, mutable.selected);
  applyStyleToSelection({ [styleKey]: !current[styleKey] } as Partial<CellStyle>);
}

export function clearSelectionValues() {
  pushHistory();
  const rect = rangeRect(mutable.selectionStart, mutable.selectionEnd);
  for (const ref of refsInRect(rect)) delete cells[ref];
  refreshAll();
  scheduleAutosave();
}

// ── Serialization ─────────────────────────────────────────────────────
export function serializeWorkbook() {
  return JSON.stringify({ cells, styles }, null, 2);
}

export function importWorkbook(parsed: any) {
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

export function tryImportWorkbook(text: string, errorMessage = 'Invalid JSON') {
  try {
    const parsed = JSON.parse(text) as any;
    importWorkbook(parsed);
    return true;
  } catch {
    alert(errorMessage);
    return false;
  }
}

// ── Autosave ──────────────────────────────────────────────────────────
export const autosavePath = 'autosave.json';

const _autosaveWorkbook = debounce(async () => {
  try {
    await storageSave(autosavePath, serializeWorkbook());
  } catch {
    // ignore autosave errors
  }
}, 1400);

export function scheduleAutosave() {
  void _autosaveWorkbook();
}
