# SQLite for App Storage — Design Plan

## Motivation

Apps currently store data as flat files under `storage/apps/{appId}/`. This works but limits what apps can do:

- **No queries** — Apps load entire JSON files into memory to filter/search
- **No transactions** — Multi-file writes can partially fail
- **No structured data** — Everything is serialized JSON strings
- **No search** — `storageGrep` does regex over raw text files (O(n) per file)
- **No aggregation** — Counting, summing, grouping requires full data load

Bun has `bun:sqlite` built in — zero dependencies, WAL mode, fast. This plan adds SQLite as a structured storage layer for apps while keeping the existing filesystem API working.

---

## Current State

### How apps store data today

| Pattern | Apps | Example |
|---------|------|---------|
| Single JSON file (load-all, save-all) | memo, rss-reader, slides-lite | `appStorage.save('memos.json', JSON.stringify(all))` |
| `createPersistedSignal` (auto-save signal) | word-lite, falling-blocks, rss-reader, thesingularity-reader | `createPersistedSignal('settings.json', defaults)` |
| Multiple files in directories | devtools (project files), thesingularity-reader (auth/) | `appStorage.save('projects/abc/main.ts', code)` |
| Binary via base64 | excel-lite (xlsx), pdf-viewer, image-viewer | `appStorage.save(path, btoa(data), { encoding: 'base64' })` |

### SDK surface (`@bundled/yaar`)

```typescript
appStorage.save(path, content, options?)   // write text or base64
appStorage.read(path)                      // read as text
appStorage.readJson<T>(path)               // read + JSON.parse
appStorage.readJsonOr<T>(path, fallback)   // read + parse + fallback
appStorage.readBinary(path)                // → { data: base64, mimeType }
appStorage.readBlob(path)                  // → Blob
appStorage.list(dirPath?)                  // → [{ path, isDirectory, size, modifiedAt }]
appStorage.remove(path)                    // delete
```

### Server-side flow

```
appStorage.save('notes.json', data)
  → iframe postMessage → verb SDK → POST /api/verb
  → invoke('yaar://apps/{appId}/storage/notes.json', { action: 'write', content: data })
  → apps handler → storageWrite('apps/{appId}/notes.json', data)
  → Bun.write('storage/apps/{appId}/notes.json', data)
```

---

## Design Decisions

### 1. New `appDb` API — don't replace `appStorage`

**Decision:** Add a new `appDb` SDK alongside `appStorage`. Don't change the existing API.

**Why:**
- Existing apps keep working without changes
- SQLite's value is structured queries — shoehorning it behind a file-path API wastes the capability
- Apps opt in to SQLite when they need it; simple apps stay with `appStorage`
- `appStorage` could later be backed by SQLite transparently (Phase 3), but the user-facing API stays

### 2. One database per app

**Decision:** Each app gets `storage/apps/{appId}/data.db`.

**Why:**
- Natural isolation (same as current `storage/apps/{appId}/` directory)
- Apps can't accidentally read each other's data
- Easy to delete when app is uninstalled
- SQLite performs best with focused databases, not one mega-database

### 3. Schema-on-write with `collections`

**Decision:** Use a collection-based API (like MongoDB/Firestore), not raw SQL.

**Why:**
- LLM-generated app code works better with simple APIs than raw SQL
- Collections map naturally to what apps already do (arrays of objects in JSON files)
- Server validates and indexes; apps don't need to manage schemas
- Still backed by real SQL tables for performance

### 4. Binary data stays on filesystem

**Decision:** `appDb` stores structured data. Binary blobs (images, PDFs, XLSX) continue using `appStorage`.

**Why:**
- SQLite blobs above ~100KB hurt performance
- Binary files need to be served directly via HTTP (`/api/storage/...`)
- Current apps that store binary are few and work fine with the file API

---

## Schema Design

### Internal SQLite schema (per-app `data.db`)

```sql
-- One table per collection, created on first insert
-- Example: app calls appDb.collection('notes').insert({ title: 'Hi', body: '...' })
-- Server creates:

CREATE TABLE IF NOT EXISTS notes (
  _id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  _data TEXT NOT NULL,              -- JSON blob of the full document
  _created_at TEXT DEFAULT (datetime('now')),
  _updated_at TEXT DEFAULT (datetime('now'))
);

-- Auto-created FTS index per collection
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  _data,
  content=notes,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, _data) VALUES (new.rowid, new._data);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, _data) VALUES('delete', old.rowid, old._data);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, _data) VALUES('delete', old.rowid, old._data);
  INSERT INTO notes_fts(rowid, _data) VALUES (new.rowid, new._data);
END;
```

### Why JSON in `_data` instead of dynamic columns?

- Apps have heterogeneous documents — not every note has the same fields
- JSON extract in SQLite is fast: `json_extract(_data, '$.title')`
- Avoids ALTER TABLE on every new field
- Apps can still create explicit indexes on JSON paths:

```sql
CREATE INDEX IF NOT EXISTS notes_idx_tag ON notes(json_extract(_data, '$.tag'));
```

---

## SDK API Design

### `appDb` — new import from `@bundled/yaar`

```typescript
import { appDb } from '@bundled/yaar';

// Get a collection handle (lazy — no network call)
const notes = appDb.collection<Note>('notes');

// Insert
const id = await notes.insert({ title: 'Hello', body: '...', tags: ['intro'] });

// Insert many
const ids = await notes.insertMany([{ title: 'A' }, { title: 'B' }]);

// Find by ID
const note = await notes.get(id);

// Find with filter
const results = await notes.find({ tags: 'intro' });

// Find with options
const page = await notes.find(
  { tags: 'intro' },
  { sort: { _created_at: -1 }, limit: 20, offset: 0 }
);

// Full-text search
const matches = await notes.search('hello world');

// Update
await notes.update(id, { title: 'Updated' }); // partial merge

// Delete
await notes.remove(id);

// Delete matching
await notes.removeWhere({ tags: 'draft' });

// Count
const n = await notes.count({ tags: 'intro' });

// List collections
const names = await appDb.collections();

// Drop collection
await appDb.drop('notes');
```

### Filter syntax

Simple, LLM-friendly filter objects:

```typescript
// Exact match
{ status: 'active' }

// Multiple conditions (AND)
{ status: 'active', priority: 'high' }

// Comparison operators
{ age: { $gt: 18 } }
{ score: { $gte: 90, $lt: 100 } }
{ name: { $ne: 'admin' } }

// Array contains
{ tags: 'intro' }                    // tag array contains 'intro'
{ tags: { $in: ['a', 'b'] } }       // tag is one of these

// Existence
{ avatar: { $exists: true } }
```

### `createPersistedCollection` — reactive Solid.js binding

```typescript
import { appDb } from '@bundled/yaar';

// Reactive collection that auto-syncs with SQLite
const [notes, { insert, update, remove, refresh }] = appDb.createReactiveCollection<Note>(
  'notes',
  { sort: { _created_at: -1 }, limit: 50 }
);

// notes() is a Solid signal — rerenders on change
// insert/update/remove mutate SQLite then refresh the signal
```

---

## Server-Side Implementation

### New files

```
packages/server/src/
├── db/
│   ├── app-db.ts          # AppDatabase class (per-app SQLite wrapper)
│   ├── pool.ts            # Database pool (Map<appId, AppDatabase>), idle cleanup
│   ├── query-builder.ts   # Filter object → SQL WHERE clause
│   └── index.ts           # Barrel exports
```

### `AppDatabase` class

```typescript
import { Database } from 'bun:sqlite';

class AppDatabase {
  private db: Database;
  private collections: Set<string>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.collections = this.loadCollectionNames();
  }

  ensureCollection(name: string): void { /* CREATE TABLE IF NOT EXISTS ... */ }
  insert(collection: string, doc: object): string { /* ... */ }
  get(collection: string, id: string): object | null { /* ... */ }
  find(collection: string, filter: object, options: FindOptions): object[] { /* ... */ }
  search(collection: string, query: string): object[] { /* FTS5 MATCH */ }
  update(collection: string, id: string, patch: object): boolean { /* ... */ }
  remove(collection: string, id: string): boolean { /* ... */ }
  count(collection: string, filter?: object): number { /* ... */ }
  drop(collection: string): void { /* DROP TABLE ... */ }
  close(): void { this.db.close(); }
}
```

### Database pool

```typescript
// Map<appId, { db: AppDatabase, lastAccess: number }>
// Idle timeout: 5 minutes (close db to free file handles)
// Max open: 20 databases (LRU eviction)
```

### URI routing — new verbs on existing `yaar://apps/{appId}/db` path

```
invoke('yaar://apps/{appId}/db/{collection}', { action: 'insert', doc: {...} })
  → 201, { _id: '...' }

read('yaar://apps/{appId}/db/{collection}', { filter?, sort?, limit?, offset? })
  → 200, [{ _id, ...doc, _created_at, _updated_at }]

read('yaar://apps/{appId}/db/{collection}/{id}')
  → 200, { _id, ...doc, _created_at, _updated_at }

invoke('yaar://apps/{appId}/db/{collection}/{id}', { action: 'update', patch: {...} })
  → 200, { updated: true }

invoke('yaar://apps/{appId}/db/{collection}', { action: 'search', query: 'hello' })
  → 200, [{ _id, ...doc, rank }]

delete('yaar://apps/{appId}/db/{collection}/{id}')
  → 200, { deleted: true }

list('yaar://apps/{appId}/db')
  → 200, ['notes', 'tags', ...]   (collection names)

delete('yaar://apps/{appId}/db/{collection}')
  → 200, { dropped: true }
```

### Query builder: filter → SQL

```typescript
function buildWhere(filter: Record<string, unknown>): { sql: string; params: unknown[] } {
  // { status: 'active' }
  //   → "json_extract(_data, '$.status') = ?" [active]
  //
  // { age: { $gt: 18 } }
  //   → "json_extract(_data, '$.age') > ?" [18]
  //
  // { tags: 'intro' }  (array contains)
  //   → "EXISTS (SELECT 1 FROM json_each(json_extract(_data, '$.tags')) WHERE value = ?)" [intro]
}
```

---

## SDK Shim (`packages/compiler/src/shims/yaar.ts`)

Add `appDb` alongside existing `appStorage`:

```typescript
function appDbUri(path: string): string {
  return `yaar://apps/self/db/${path}`;
}

class CollectionHandle<T> {
  constructor(private name: string) {}

  async insert(doc: Omit<T, '_id'>): Promise<string> {
    const result = await y.invoke(appDbUri(this.name), { action: 'insert', doc });
    return result._id;
  }

  async get(id: string): Promise<T | null> {
    try {
      return await y.read(appDbUri(`${this.name}/${id}`));
    } catch { return null; }
  }

  async find(filter?: object, options?: FindOptions): Promise<T[]> {
    return y.read(appDbUri(this.name), { filter, ...options });
  }

  async search(query: string): Promise<T[]> {
    return y.invoke(appDbUri(this.name), { action: 'search', query });
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    await y.invoke(appDbUri(`${this.name}/${id}`), { action: 'update', patch });
  }

  async remove(id: string): Promise<void> {
    await y.delete(appDbUri(`${this.name}/${id}`));
  }

  async removeWhere(filter: object): Promise<number> {
    const result = await y.invoke(appDbUri(this.name), { action: 'removeWhere', filter });
    return result.deleted;
  }

  async count(filter?: object): Promise<number> {
    const result = await y.invoke(appDbUri(this.name), { action: 'count', filter });
    return result.count;
  }

  async insertMany(docs: Omit<T, '_id'>[]): Promise<string[]> {
    const result = await y.invoke(appDbUri(this.name), { action: 'insertMany', docs });
    return result.ids;
  }
}

export const appDb = {
  collection<T = Record<string, unknown>>(name: string): CollectionHandle<T> {
    return new CollectionHandle<T>(name);
  },
  async collections(): Promise<string[]> {
    return y.list(appDbUri(''));
  },
  async drop(name: string): Promise<void> {
    await y.delete(appDbUri(name));
  },
};
```

---

## Coexistence with Filesystem Storage

### What lives where

| Data type | Storage | Reason |
|-----------|---------|--------|
| Structured records (notes, feeds, settings objects) | `appDb` (SQLite) | Queryable, transactional |
| User-uploaded files (images, PDFs, XLSX) | `appStorage` (filesystem) | Direct HTTP serving, large blobs |
| Simple key-value config | Either | `appStorage` for single files, `appDb` for many keys |
| App credentials/tokens | `appStorage` (filesystem) | Human-inspectable, simple read/write |

### No conflict — parallel systems

```
storage/apps/{appId}/
├── data.db              ← NEW: SQLite database (appDb)
├── draft.json           ← EXISTING: file storage (appStorage)  
├── auth/
│   └── credentials.json ← EXISTING: file storage (appStorage)
└── uploads/
    └── photo.png        ← EXISTING: file storage (appStorage)
```

Both APIs work simultaneously. `appStorage` doesn't touch `data.db`. `appDb` only touches `data.db`. No migration needed for existing apps.

### AI agent access

The AI agent already uses the 5 generic verb tools. The new `yaar://apps/{appId}/db/` URIs register in the same handler — the agent can query app databases directly:

```
read('yaar://apps/memo/db/notes', { filter: { tags: 'important' }, limit: 5 })
```

This is a major upgrade — the agent can now search and filter app data without loading everything.

---

## Phase Plan

### Phase 1: Core infrastructure (smallest useful thing)

**Scope:** `AppDatabase` class + pool + URI handlers + SDK shim

**Files to create:**
- `packages/server/src/db/app-db.ts`
- `packages/server/src/db/pool.ts`
- `packages/server/src/db/query-builder.ts`
- `packages/server/src/db/index.ts`

**Files to modify:**
- `packages/server/src/handlers/apps.ts` — add `yaar://apps/{appId}/db/*` routes
- `packages/compiler/src/shims/yaar.ts` — add `appDb` and `CollectionHandle`
- `packages/compiler/src/bundled-types/index.d.ts` — add type declarations

**Deliverable:** An app can `import { appDb } from '@bundled/yaar'` and do insert/find/get/update/remove on collections.

### Phase 2: Full-text search + reactive bindings

**Scope:** FTS5 integration + `createReactiveCollection` for Solid.js

**Files to create/modify:**
- `packages/server/src/db/app-db.ts` — add FTS table creation + search method
- `packages/compiler/src/shims/yaar.ts` — add `createReactiveCollection`

**Deliverable:** Apps can do `notes.search('hello')` and use reactive collections that auto-update UI.

### Phase 3: Advanced (optional, future)

- **Indexes on JSON paths** — `appDb.collection('notes').createIndex('$.tag')`
- **Cross-session persistence** — Agent can query app data across sessions
- **Backup/export** — `appDb.export()` → JSON dump, `appDb.import(json)` → restore
- **`appStorage` backed by SQLite** — Transparent migration of file API to SQLite KV table (non-breaking)
- **Subscriptions** — `appDb.collection('notes').subscribe(filter, callback)` for live queries

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SQLite file locking under concurrent access | App agent + iframe writing simultaneously | WAL mode handles concurrent readers; writes are serialized per-db (single-process server) |
| Database corruption on crash | Data loss | WAL + `PRAGMA synchronous=NORMAL` — survives process crashes. Worst case: rebuild from WAL |
| Large databases slow down app uninstall | UX lag | Just `rm data.db` — SQLite is a single file |
| Filter syntax too limited | Apps need raw SQL | Could add `appDb.raw(sql, params)` escape hatch in Phase 3 |
| Memory usage from open databases | Server OOM | Pool with LRU eviction (max 20 open, 5min idle timeout) |
| Breaking change to app shim | Existing apps break | Purely additive — `appDb` is new, `appStorage` unchanged |

---

## Example: Memo App (before/after)

### Before (filesystem)

```typescript
import { appStorage } from '@bundled/yaar';

// Load ALL memos into memory
const raw = await appStorage.readJsonOr<Memo[]>('memos.json', []);
const [memos, setMemos] = createSignal(raw);

// Search = filter in memory
const results = memos().filter(m => m.title.includes(query));

// Save = serialize entire array
async function addMemo(memo: Memo) {
  setMemos(prev => [...prev, memo]);
  await appStorage.save('memos.json', JSON.stringify(memos()));
}
```

### After (SQLite)

```typescript
import { appDb } from '@bundled/yaar';

const memos = appDb.collection<Memo>('memos');

// Search = server-side FTS
const results = await memos.search(query);

// Save = single insert
async function addMemo(memo: Memo) {
  await memos.insert(memo);
}

// Paginated list
const page = await memos.find({}, { sort: { _created_at: -1 }, limit: 20, offset: 0 });
```

No more load-all-save-all. No more in-memory filtering. Scales to thousands of records.
