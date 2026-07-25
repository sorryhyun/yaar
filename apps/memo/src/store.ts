import { createSignal } from '@bundled/solid-js';
import { appDb, appStorage, showToast } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { LegacyMemoSchema, LegacyMemoStoreSchema } from './schema';
import type { Memo, MemoDoc } from './types';

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
    const raw = await appStorage.readJsonOr<unknown>(LEGACY_FILE, null);
    // No legacy file is the overwhelmingly common case (every install after the
    // first) and is not worth a word. A file that is *there but unreadable* is
    // a different thing entirely, and falls through to the throw below.
    if (raw == null) return;

    const parsed = z.safeParse(LegacyMemoStoreSchema, raw);
    if (!parsed.success) {
      console.error('[memo] legacy memos.json failed validation', parsed.error.issues);
      throw new Error('Malformed legacy memos.json — migration skipped');
    }
    if (parsed.data.memos.length === 0) return;

    // Per-row validation is separate from the envelope's: one unreadable row
    // should not abandon the whole migration, but it must not vanish silently
    // either — the file is deleted at the end of this function, so a skip is the
    // last chance to say anything about that row.
    const docs: MemoDoc[] = [];
    for (const entry of parsed.data.memos) {
      const row = z.safeParse(LegacyMemoSchema, entry);
      if (!row.success) {
        console.error('[memo] skipping unreadable legacy memo', {
          entry,
          issues: row.error.issues,
        });
        continue;
      }
      const { id: _id, ...doc } = row.data;
      docs.push(doc as MemoDoc);
    }

    const skipped = parsed.data.memos.length - docs.length;
    if (docs.length === 0) {
      // Every row was unreadable. Retiring the file here would turn "some memos
      // did not survive the upgrade" into "all my memos are gone", with only the
      // console to say otherwise — so the file stays exactly where it is and the
      // migration is retried on the next launch, by which time a fixed build may
      // read it.
      console.error(
        `[memo] no legacy memo survived validation (${skipped} skipped) — ` +
          `keeping ${LEGACY_FILE} for a later attempt`,
      );
      showToast(
        `Could not read ${skipped} memo(s) from ${LEGACY_FILE} — nothing was imported`,
        'error',
      );
      return;
    }
    // An existing collection wins: the migration has already run (or the user
    // has written memos since), so the legacy file is stale and is only retired,
    // not replayed.
    if ((await collection.count()) === 0) {
      await collection.insertMany(docs);
      if (skipped > 0) {
        showToast(`Imported ${docs.length} memo(s); ${skipped} could not be read`, 'error');
      }
    }
    // Back up what was actually on disk, not the validated projection — the
    // .bak is the only copy left of anything a skipped row contained.
    await appStorage.save(`${LEGACY_FILE}.bak`, JSON.stringify(raw));
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
