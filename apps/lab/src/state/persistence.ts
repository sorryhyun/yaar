import { appStorage, errMsg } from '@bundled/yaar';
import { trimOutput } from '../lib/trim';
import { starterCells } from './starter';
import { notebooks, setNotebooks, current, setCurrent, setDirty, setStatus, uid } from './signals';
import type { Cell, Notebook, NotebookMeta } from '../types';

/**
 * Disk layout (see AGENTS.md):
 *   notebooks/index.json   [{ id, title, updatedAt, cellCount }]
 *   notebooks/{id}.json    the notebook, outputs included but trimmed
 *   state.json             { lastOpened }
 * The index is derived data; if it disagrees with the files, the index is wrong.
 */

const INDEX_PATH = 'notebooks/index.json';
const STATE_PATH = 'state.json';
const nbPath = (id: string) => 'notebooks/' + id + '.json';

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
    cells: nb.cells.map((c) => ({
      id: c.id,
      type: c.type,
      source: c.source,
      output: trimOutput(c.output),
    })),
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
  nb.cells = nb.cells.map((c) => ({
    ...c,
    id: c.id || uid('c'),
    type: c.type === 'markdown' ? 'markdown' : 'code',
  }));
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
    const wanted =
      st.lastOpened && list.some((m) => m.id === st.lastOpened) ? st.lastOpened : list[0]?.id;
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
