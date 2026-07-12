import { createSignal } from '@bundled/solid-js';
import { appDb, appStorage } from '@bundled/yaar';
import type { Memo, MemoDoc, MemoStore } from './types';

const COLLECTION = 'memos';
const LEGACY_FILE = 'memos.json';
// find() defaults to 100 docs server-side; raise to the server max for the list
const LIST_LIMIT = 1000;

const collection = appDb.collection<MemoDoc>(COLLECTION);

// Reactive query over the collection, newest first. Mutations through the
// helpers refresh the signal; external writes (the agent inserting via
// yaar://apps/memo/db/memos) arrive via a verb subscription.
const [memoDocs, memosDb] = appDb.createReactiveCollection<MemoDoc>(COLLECTION, {
  sort: { createdAt: -1 },
  limit: LIST_LIMIT,
});

export const [selectedId, setSelectedId] = createSignal<string | null>(null);
export const [editMode, setEditMode] = createSignal<'none' | 'new' | 'edit'>('none');
export const [editTitle, setEditTitle] = createSignal('');
export const [editContent, setEditContent] = createSignal('');
export const [searchQuery, setSearchQuery] = createSignal('');

/** SQLite datetime ("YYYY-MM-DD HH:MM:SS", UTC) → ISO string. */
function dbDateToIso(value: string): string {
  return value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
}

// Documents inserted directly by the agent may omit fields — fall back to
// the server's _created_at/_updated_at meta so the UI never shows Invalid Date.
function toMemo(doc: MemoDoc & YaarDbMeta): Memo {
  return {
    id: doc._id,
    title: doc.title ?? 'Untitled',
    content: doc.content ?? '',
    createdAt: doc.createdAt ?? dbDateToIso(doc._created_at),
    updatedAt: doc.updatedAt ?? dbDateToIso(doc._updated_at),
  };
}

export function memos(): Memo[] {
  return memoDocs().map(toMemo);
}

export async function loadMemos(): Promise<void> {
  await migrateLegacyFile();
  await memosDb.refresh();
}

/** One-time migration of the pre-appDb memos.json file into the collection. */
async function migrateLegacyFile(): Promise<void> {
  try {
    const legacy = await appStorage.readJsonOr<MemoStore | null>(LEGACY_FILE, null);
    if (!legacy || !Array.isArray(legacy.memos) || legacy.memos.length === 0) return;
    if ((await collection.count()) === 0) {
      await collection.insertMany(legacy.memos.map(({ id: _id, ...doc }) => doc));
    }
    await appStorage.save(`${LEGACY_FILE}.bak`, JSON.stringify(legacy));
    await appStorage.remove(LEGACY_FILE);
  } catch (err) {
    console.error('[memo] legacy storage migration failed:', err);
  }
}

export async function addMemo(title: string, content: string): Promise<Memo> {
  const now = new Date().toISOString();
  const doc: MemoDoc = { title: title.trim() || 'Untitled', content, createdAt: now, updatedAt: now };
  const id = await memosDb.insert(doc);
  return { id, ...doc };
}

export async function updateMemo(id: string, title?: string, content?: string): Promise<Memo | null> {
  const patch: Partial<MemoDoc> = { updatedAt: new Date().toISOString() };
  if (title !== undefined) patch.title = title.trim() || 'Untitled';
  if (content !== undefined) patch.content = content;
  await memosDb.update(id, patch);
  const doc = await collection.get(id);
  return doc ? toMemo(doc) : null;
}

export async function deleteMemo(id: string): Promise<boolean> {
  if (!memos().some((m) => m.id === id)) return false;
  await memosDb.remove(id);
  if (selectedId() === id) {
    setSelectedId(null);
    setEditMode('none');
  }
  return true;
}

/** In-memory substring filter — instant, used for search-as-you-type. */
export function searchMemos(query: string): Memo[] {
  const q = query.toLowerCase();
  return memos().filter(m =>
    m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
  );
}

/** Server-side FTS5 search across all memo fields, best matches first. */
export async function searchMemosFts(query: string, limit?: number): Promise<Memo[]> {
  const docs = await collection.search(query, limit);
  return docs.map(toMemo);
}

export function getFilteredMemos(): Memo[] {
  const q = searchQuery().trim();
  if (!q) return memos();
  return searchMemos(q);
}

export function getMemoById(id: string): Memo | undefined {
  return memos().find(m => m.id === id);
}
