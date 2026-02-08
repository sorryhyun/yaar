type CellMap = Record<string, string>;

const ROWS = 30;
const COLS = 12;

const app = document.createElement('div');
app.innerHTML = `
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: #f5f7fb; }
    .wrap { padding: 12px; display: grid; gap: 10px; }
    .bar { display: grid; grid-template-columns: 90px 1fr auto auto auto; gap: 8px; align-items: center; }
    .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    input { padding: 8px; border: 1px solid #d0d7e2; border-radius: 8px; font-size: 14px; }
    button { padding: 8px 10px; border: 1px solid #ccd3df; border-radius: 8px; background: white; cursor: pointer; }
    button:hover { background: #f1f4f9; }
    .sheetWrap { overflow: auto; border: 1px solid #d9e0ec; border-radius: 10px; background: white; max-height: calc(100vh - 90px); }
    table { border-collapse: collapse; min-width: 900px; }
    th, td { border: 1px solid #e7ecf5; }
    th { position: sticky; top: 0; background: #f8faff; z-index: 1; font-weight: 600; }
    .rowHead { position: sticky; left: 0; background: #f8faff; z-index: 1; text-align: right; padding: 6px 8px; min-width: 42px; }
    .corner { position: sticky; left: 0; top: 0; z-index: 2; background: #eef3ff; min-width: 42px; }
    td input { width: 100%; border: none; padding: 6px 8px; box-sizing: border-box; min-width: 90px; outline: none; background: transparent; }
    td.active { outline: 2px solid #2a6df6; outline-offset: -2px; }
    .hint { color: #5c6475; font-size: 12px; }
  </style>
  <div class="wrap">
    <div class="bar">
      <div class="name" id="cellName">A1</div>
      <input id="formulaInput" placeholder="Type value or formula like =A1+B1 or =SUM(A1:A5)" />
      <button id="saveBtn">Save JSON</button>
      <button id="loadBtn">Load JSON</button>
      <button id="csvBtn">Export CSV</button>
    </div>
    <div class="hint">Supports formulas: + - * /, cell refs (A1), ranges in SUM (A1:A10), and parentheses.</div>
    <div class="sheetWrap" id="sheet"></div>
  </div>
`;

document.body.appendChild(app);

const sheetEl = document.getElementById('sheet') as HTMLDivElement;
const formulaInput = document.getElementById('formulaInput') as HTMLInputElement;
const cellName = document.getElementById('cellName') as HTMLDivElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const loadBtn = document.getElementById('loadBtn') as HTMLButtonElement;
const csvBtn = document.getElementById('csvBtn') as HTMLButtonElement;

const cells: CellMap = {};
let selected = 'A1';

function colLabel(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function key(col: number, row: number) {
  return `${colLabel(col)}${row}`;
}

function parseRef(ref: string): { c: number; r: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { c, r: Number(m[2]) };
}

function getRaw(ref: string): string {
  return cells[ref] ?? '';
}

function evalCell(ref: string, seen = new Set<string>()): number {
  if (seen.has(ref)) return NaN;
  seen.add(ref);
  const raw = getRaw(ref).trim();
  if (!raw) return 0;
  if (!raw.startsWith('=')) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }
  return evalFormula(raw.slice(1), seen);
}

function expandRange(a: string, b: string): string[] {
  const p1 = parseRef(a);
  const p2 = parseRef(b);
  if (!p1 || !p2) return [];
  const out: string[] = [];
  const c1 = Math.min(p1.c, p2.c), c2 = Math.max(p1.c, p2.c);
  const r1 = Math.min(p1.r, p2.r), r2 = Math.max(p1.r, p2.r);
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(key(c, r));
  return out;
}

function evalFormula(expr: string, seen: Set<string>): number {
  try {
    let safe = expr.toUpperCase();

    safe = safe.replace(/SUM\(\s*([A-Z]+\d+)\s*:\s*([A-Z]+\d+)\s*\)/g, (_, a, b) => {
      const refs = expandRange(a, b);
      const sum = refs.reduce((acc, r) => {
        const v = evalCell(r, new Set(seen));
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0);
      return String(sum);
    });

    safe = safe.replace(/\b([A-Z]+\d+)\b/g, (_, ref) => {
      const v = evalCell(ref, new Set(seen));
      return Number.isFinite(v) ? String(v) : 'NaN';
    });

    if (!/^[0-9+\-*/().\sNAN]+$/.test(safe)) return NaN;
    const result = Function(`"use strict"; return (${safe});`)();
    return Number.isFinite(result) ? result : NaN;
  } catch {
    return NaN;
  }
}

function display(ref: string): string {
  const raw = getRaw(ref);
  if (!raw.startsWith('=')) return raw;
  const v = evalCell(ref);
  return Number.isFinite(v) ? String(v) : '#ERR';
}

function selectCell(ref: string) {
  selected = ref;
  cellName.textContent = ref;
  formulaInput.value = getRaw(ref);
  document.querySelectorAll('td.active').forEach(el => el.classList.remove('active'));
  const td = document.querySelector(`td[data-ref="${ref}"]`);
  if (td) td.classList.add('active');
}

function render() {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  hrow.appendChild(corner);
  for (let c = 1; c <= COLS; c++) {
    const th = document.createElement('th');
    th.textContent = colLabel(c);
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 1; r <= ROWS; r++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('th');
    rh.className = 'rowHead';
    rh.textContent = String(r);
    tr.appendChild(rh);

    for (let c = 1; c <= COLS; c++) {
      const ref = key(c, r);
      const td = document.createElement('td');
      td.dataset.ref = ref;
      const input = document.createElement('input');
      input.value = display(ref);
      input.addEventListener('focus', () => selectCell(ref));
      input.addEventListener('dblclick', () => { input.value = getRaw(ref); input.select(); });
      input.addEventListener('change', () => {
        const prev = getRaw(ref);
        cells[ref] = input.value;
        if (!cells[ref]) delete cells[ref];
        if (cells[ref] !== prev) refreshValues();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
          const p = parseRef(ref)!;
          const next = key(p.c, Math.min(ROWS, p.r + 1));
          const n = document.querySelector(`td[data-ref="${next}"] input`) as HTMLInputElement | null;
          n?.focus();
        }
      });
      td.appendChild(input);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sheetEl.innerHTML = '';
  sheetEl.appendChild(table);
  selectCell(selected);
}

function refreshValues() {
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      const ref = key(c, r);
      const input = document.querySelector(`td[data-ref="${ref}"] input`) as HTMLInputElement | null;
      if (input && document.activeElement !== input) input.value = display(ref);
    }
  }
  formulaInput.value = getRaw(selected);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportCsv() {
  let maxRow = 1;
  let maxCol = 1;
  for (const ref of Object.keys(cells)) {
    const p = parseRef(ref);
    if (!p) continue;
    if ((cells[ref] ?? '').length === 0) continue;
    maxRow = Math.max(maxRow, p.r);
    maxCol = Math.max(maxCol, p.c);
  }

  const lines: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row: string[] = [];
    for (let c = 1; c <= maxCol; c++) row.push(csvEscape(getRaw(key(c, r))));
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

formulaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    cells[selected] = formulaInput.value;
    if (!cells[selected]) delete cells[selected];
    refreshValues();
    const input = document.querySelector(`td[data-ref="${selected}"] input`) as HTMLInputElement | null;
    input?.focus();
  }
});

saveBtn.addEventListener('click', async () => {
  const json = JSON.stringify(cells, null, 2);
  await navigator.clipboard.writeText(json);
  saveBtn.textContent = 'Copied';
  setTimeout(() => (saveBtn.textContent = 'Save JSON'), 1200);
});

loadBtn.addEventListener('click', async () => {
  const text = prompt('Paste JSON map of cells (e.g. {"A1":"10","B1":"=A1*2"})');
  if (!text) return;
  try {
    const obj = JSON.parse(text) as Record<string, string>;
    for (const k of Object.keys(cells)) delete cells[k];
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') cells[k.toUpperCase()] = v;
    refreshValues();
  } catch {
    alert('Invalid JSON');
  }
});

csvBtn.addEventListener('click', () => {
  exportCsv();
  csvBtn.textContent = 'Exported';
  setTimeout(() => (csvBtn.textContent = 'Export CSV'), 1200);
});

render();