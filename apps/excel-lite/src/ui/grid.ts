import html from '@bundled/solid-js/html';
import { COLS, ROWS } from '../constants';
import { colLabel, key as cellKey, parseRef, rangeRect } from '../ref-utils';
import { computeFillDestination, sourceForDestination } from '../fill-utils';
import { shiftFormula } from '../formula-utils';
import {
  mutable, refs,
  cells, styles, inputs, tds, fillHandle,
  formulaEngine, getRaw,
  setSelection, refreshAll, commitCell,
  clearHighlights,
  pushHistory, scheduleAutosave,
} from '../state';

function refsInRect(rect: { c1: number; c2: number; r1: number; r2: number }) {
  const out: string[] = [];
  for (let r = rect.r1; r <= rect.r2; r++)
    for (let c = rect.c1; c <= rect.c2; c++)
      out.push(cellKey(c, r));
  return out;
}

export function updateFillPreview() {
  clearHighlights('fill-preview');
  if (!mutable.isFillDragging || !mutable.fillSource || !mutable.fillTarget) return;
  const dest = computeFillDestination(mutable.fillSource, mutable.fillTarget);
  if (!dest) return;
  for (const ref of refsInRect(dest)) tds.get(ref)?.classList.add('fill-preview');
}

export function applyFill() {
  if (!mutable.fillSource || !mutable.fillTarget) return;
  const dest = computeFillDestination(mutable.fillSource, mutable.fillTarget);
  if (!dest) return;

  pushHistory();

  for (const ref of refsInRect(dest)) {
    const src = sourceForDestination(mutable.fillSource, ref);
    const pDest = parseRef(ref)!;
    const pSrc = parseRef(src)!;
    const shifted = shiftFormula(getRaw(src), pDest.r - pSrc.r, pDest.c - pSrc.c);
    if (shifted) cells[ref] = shifted;
    else delete cells[ref];

    const srcStyle = styles[src];
    if (srcStyle) styles[ref] = { ...srcStyle };
    else delete styles[ref];
  }

  const fs = mutable.fillSource;
  if (dest.r2 > fs.r2) {
    setSelection(cellKey(fs.c1, fs.r1), cellKey(fs.c2, dest.r2));
  } else if (dest.r1 < fs.r1) {
    setSelection(cellKey(fs.c1, dest.r1), cellKey(fs.c2, fs.r2));
  } else if (dest.c2 > fs.c2) {
    setSelection(cellKey(fs.c1, fs.r1), cellKey(dest.c2, fs.r2));
  } else if (dest.c1 < fs.c1) {
    setSelection(cellKey(dest.c1, fs.r1), cellKey(fs.c2, fs.r2));
  }

  refreshAll();
  scheduleAutosave();
}

export function buildSheet() {
  const el = refs.sheetEl!;

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
        mutable.isSelecting = true;
        if (e.shiftKey) setSelection(mutable.selectionStart, ref, true);
        else {
          mutable.selected = ref;
          setSelection(ref, ref, true);
        }
        input.focus();
      });

      td.addEventListener('mouseenter', () => {
        if (mutable.isSelecting) setSelection(mutable.selectionStart, ref, true);
        if (mutable.isFillDragging) {
          mutable.fillTarget = ref;
          updateFillPreview();
        }
      });

      input.addEventListener('focus', () => {
        mutable.editingRef = ref;
        mutable.selected = ref;
        if (!mutable.isSelecting) setSelection(ref, ref, true);
        input.value = getRaw(ref);
      });

      input.addEventListener('blur', () => {
        const value = input.value;
        mutable.editingRef = null;
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
  el.innerHTML = '';
  el.appendChild(table);

  fillHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    mutable.isFillDragging = true;
    mutable.fillSource = rangeRect(mutable.selectionStart, mutable.selectionEnd);
    mutable.fillTarget = mutable.selected;
    updateFillPreview();
  });
}

export function createGrid() {
  return html`
    <div class="sheetWrap y-scroll" ref=${(el: HTMLDivElement) => { refs.sheetEl = el; }}></div>
  `;
}
