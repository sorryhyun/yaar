import { createSignal, batch } from '@bundled/solid-js';
import { appStorage, errMsg } from '@bundled/yaar';
import type { Cell, CellOutput, CellType, Notebook, NotebookMeta } from './types';

const INDEX_PATH = 'notebooks/index.json';
const STATE_PATH = 'state.json';
const nbPath = (id: string) => 'notebooks/' + id + '.json';

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

const [notebooks, setNotebooks] = createSignal<NotebookMeta[]>([]);
const [current, setCurrent] = createSignal<Notebook | null>(null);
const [dirty, setDirty] = createSignal(false);
const [status, setStatus] = createSignal('');
const [runningCell, setRunningCell] = createSignal<string | null>(null);

export { notebooks, current, dirty, status, runningCell, setRunningCell, setStatus };

/* ------------------------------------------------------------- snapshots -- */

const MAX_SNAPSHOT_ROWS = 200;
const MAX_SNAPSHOT_JSON = 20000;
const MAX_SNAPSHOT_IMAGE = 400000;
const MAX_SNAPSHOT_POINTS = 2000;

function trimOutput(o: CellOutput | undefined): CellOutput | undefined {
  if (!o) return undefined;
  const parts = (o.parts || []).slice(0, 8).map((p) => {
    if (p.kind === 'table' && p.rows) {
      return {
        ...p,
        rows: p.rows.slice(0, MAX_SNAPSHOT_ROWS),
        truncated: p.truncated || p.rows.length > MAX_SNAPSHOT_ROWS,
      };
    }
    if (p.kind === 'json' && p.json && p.json.length > MAX_SNAPSHOT_JSON) {
      return { ...p, json: p.json.slice(0, MAX_SNAPSHOT_JSON), truncated: true };
    }
    if (p.kind === 'text' && p.text && p.text.length > MAX_SNAPSHOT_JSON) {
      return { ...p, text: p.text.slice(0, MAX_SNAPSHOT_JSON), truncated: true };
    }
    if (p.kind === 'image' && p.src && p.src.length > MAX_SNAPSHOT_IMAGE) {
      return { kind: 'text' as const, text: '[image dropped from saved snapshot: ' + p.src.length + ' bytes]' };
    }
    if (p.kind === 'chart' && p.spec) {
      const spec = p.spec;
      const datasets = spec.data.datasets.map((d) => ({ ...d, data: (d.data || []).slice(0, MAX_SNAPSHOT_POINTS) }));
      return { ...p, spec: { ...spec, data: { ...spec.data, labels: (spec.data.labels || []).slice(0, MAX_SNAPSHOT_POINTS), datasets } } };
    }
    return p;
  });
  return { ...o, parts, logs: (o.logs || []).slice(0, 100) };
}

/* ----------------------------------------------------------- persistence -- */

function metaOf(nb: Notebook): NotebookMeta {
  return { id: nb.id, title: nb.title, updatedAt: nb.updatedAt, cellCount: nb.cells.length };
}

async function writeIndex(list: NotebookMeta[]): Promise<void> {
  const sorted = list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  setNotebooks(sorted);
  await appStorage.trySave(INDEX_PATH, JSON.stringify(sorted, null, 2));
}

let saveTimer: number | null = null;

export function markDirty(): void {
  setDirty(true);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveCurrent();
  }, 900);
}

export async function saveCurrent(): Promise<boolean> {
  const nb = current();
  if (!nb) return false;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot: Notebook = {
    ...nb,
    updatedAt: Date.now(),
    cells: nb.cells.map((c) => ({ id: c.id, type: c.type, source: c.source, output: trimOutput(c.output) })),
  };
  const ok = await appStorage.trySave(nbPath(nb.id), JSON.stringify(snapshot), { label: nb.title });
  if (!ok) return false;
  setCurrent({ ...nb, updatedAt: snapshot.updatedAt });
  setDirty(false);
  const list = notebooks().filter((m) => m.id !== nb.id);
  list.push(metaOf(snapshot));
  await writeIndex(list);
  await appStorage.trySave(STATE_PATH, JSON.stringify({ lastOpened: nb.id }));
  return true;
}

function starterCells(): Cell[] {
  return [
    {
      id: uid('c'),
      type: 'markdown',
      source:
        '# Lab\n\nJS cells run in a Web Worker. Variables persist between cells; the last expression is the output.\n\nHelpers in scope: `store`, `csv`, `df`, `stats`, `plot`, `http`, `show()`, `md()`, `sleep()`.',
    },
    {
      id: uid('c'),
      type: 'code',
      source:
        "// Shift+Enter runs a cell.\nconst sales = [\n  { region: 'North', month: 'Jan', amount: 120 },\n  { region: 'North', month: 'Feb', amount: 180 },\n  { region: 'South', month: 'Jan', amount: 90 },\n  { region: 'South', month: 'Feb', amount: 140 },\n];\ndf(sales).groupBy('region').agg({ amount: 'sum' })",
    },
  ];
}

export function makeNotebook(title: string, cells?: Cell[]): Notebook {
  const now = Date.now();
  return {
    id: uid('nb'),
    title: title || 'Untitled',
    cells: cells && cells.length ? cells : [{ id: uid('c'), type: 'code', source: '' }],
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadIndex(): Promise<NotebookMeta[]> {
  const list = await appStorage.readJsonOr<NotebookMeta[]>(INDEX_PATH, []);
  const clean = Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
  clean.sort((a, b) => b.updatedAt - a.updatedAt);
  setNotebooks(clean);
  return clean;
}

export async function openNotebook(id: string): Promise<Notebook> {
  const nb = await appStorage.readJson<Notebook>(nbPath(id));
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Notebook ' + id + ' is missing or corrupt');
  nb.cells = nb.cells.map((c) => ({ ...c, id: c.id || uid('c'), type: c.type === 'markdown' ? 'markdown' : 'code' }));
  setCurrent(nb);
  setDirty(false);
  await appStorage.trySave(STATE_PATH, JSON.stringify({ lastOpened: id }));
  return nb;
}

export async function newNotebook(title?: string, withStarter = false): Promise<Notebook> {
  const nb = makeNotebook(title || 'Untitled', withStarter ? starterCells() : undefined);
  setCurrent(nb);
  await saveCurrent();
  return nb;
}

export async function deleteNotebook(id: string): Promise<void> {
  try {
    await appStorage.remove(nbPath(id));
  } catch {
    /* already gone */
  }
  await writeIndex(notebooks().filter((m) => m.id !== id));
  if (current()?.id === id) {
    const next = notebooks()[0];
    if (next) await openNotebook(next.id);
    else await newNotebook('Untitled', true);
  }
}

export async function bootstrap(): Promise<void> {
  try {
    const list = await loadIndex();
    const st = await appStorage.readJsonOr<{ lastOpened?: string }>(STATE_PATH, {});
    const wanted = st.lastOpened && list.some((m) => m.id === st.lastOpened) ? st.lastOpened : list[0]?.id;
    if (wanted) {
      try {
        await openNotebook(wanted);
        return;
      } catch {
        /* fall through to a fresh notebook */
      }
    }
    await newNotebook('Scratch', true);
  } catch (e) {
    setStatus('load failed: ' + errMsg(e));
    setCurrent(makeNotebook('Scratch', starterCells()));
  }
}

/* ------------------------------------------------------------ cell edits -- */

function mutate(fn: (cells: Cell[]) => Cell[]): void {
  const nb = current();
  if (!nb) return;
  setCurrent({ ...nb, cells: fn(nb.cells.slice()) });
  markDirty();
}

export function addCell(source = '', type: CellType = 'code', index?: number): Cell {
  const cell: Cell = { id: uid('c'), type, source };
  mutate((cells) => {
    const at = index === undefined || index < 0 || index > cells.length ? cells.length : index;
    cells.splice(at, 0, cell);
    return cells;
  });
  return cell;
}

export function updateCell(id: string, patch: Partial<Cell>): boolean {
  let found = false;
  mutate((cells) =>
    cells.map((c) => {
      if (c.id !== id) return c;
      found = true;
      return { ...c, ...patch };
    }),
  );
  return found;
}

/** Source edits from the textarea: no full re-render of the cell list needed. */
export function setCellSource(id: string, source: string): void {
  const nb = current();
  if (!nb) return;
  const cells = nb.cells.map((c) => (c.id === id ? { ...c, source } : c));
  setCurrent({ ...nb, cells });
  markDirty();
}

export function setCellOutput(id: string, output: CellOutput | undefined): void {
  const nb = current();
  if (!nb) return;
  setCurrent({ ...nb, cells: nb.cells.map((c) => (c.id === id ? { ...c, output } : c)) });
  markDirty();
}

export function deleteCell(id: string): boolean {
  const nb = current();
  if (!nb) return false;
  if (!nb.cells.some((c) => c.id === id)) return false;
  const cells = nb.cells.filter((c) => c.id !== id);
  setCurrent({ ...nb, cells: cells.length ? cells : [{ id: uid('c'), type: 'code', source: '' }] });
  markDirty();
  return true;
}

export function moveCell(id: string, delta: number): boolean {
  const nb = current();
  if (!nb) return false;
  const i = nb.cells.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= nb.cells.length) return false;
  const cells = nb.cells.slice();
  const [c] = cells.splice(i, 1);
  cells.splice(j, 0, c);
  setCurrent({ ...nb, cells });
  markDirty();
  return true;
}

export function renameNotebook(title: string): void {
  const nb = current();
  if (!nb) return;
  setCurrent({ ...nb, title });
  markDirty();
}

export function clearAllOutputs(): void {
  const nb = current();
  if (!nb) return;
  batch(() => setCurrent({ ...nb, cells: nb.cells.map((c) => ({ ...c, output: undefined })) }));
  markDirty();
}

export function findCell(id: string): Cell | undefined {
  return current()?.cells.find((c) => c.id === id);
}
