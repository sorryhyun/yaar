# App Database Reference (`appDb`)

**Source:** `packages/server/src/db/app-db.ts`, `packages/server/src/db/query-builder.ts`, `packages/server/src/handlers/apps/db-resource.ts`, `packages/compiler/src/shims/yaar/app-db.ts`

`appDb` is a structured storage layer for apps: one SQLite database per app
(`storage/apps/{appId}/data.db`), exposed as a Mongo-style collection API. It sits alongside the
file-based `appStorage` API — use `appDb` for structured, queryable records (notes, feeds, settings
objects) and `appStorage` for binary blobs and simple single-file state. Usage guide:
[app-development.md](../guides/app-development.md#app-scoped-database-appdb).

---

## SDK (`@bundled/yaar`)

```typescript
import { appDb } from '@bundled/yaar';

const notes = appDb.collection<Note>('notes');
```

### `appDb`

| Method | Signature | Description |
|--------|-----------|-------------|
| `collection` | `<T>(name: string) → CollectionHandle<T>` | Get a collection handle. Lazy — no network call until a method is invoked. |
| `collections` | `() → Promise<string[]>` | List collection names in this app's database. |
| `drop` | `(name: string) → Promise<void>` | Drop a collection and all its documents. |
| `createReactiveCollection` | `<T>(name, options?) → [() => (T & Meta)[], helpers]` | Reactive Solid.js binding — see below. |

### `CollectionHandle<T>`

| Method | Signature | Description |
|--------|-----------|-------------|
| `insert` | `(doc: T) → Promise<string>` | Insert a document. Returns the generated `_id`. |
| `insertMany` | `(docs: T[]) → Promise<string[]>` | Insert many documents in one transaction. Returns generated ids. |
| `get` | `(id: string) → Promise<(T & Meta) \| null>` | Fetch one document by `_id`, or `null` if it doesn't exist. |
| `find` | `(filter?, options?) → Promise<(T & Meta)[]>` | Query documents matching the filter (all documents when omitted). |
| `search` | `(query: string, limit?: number) → Promise<(T & Meta)[]>` | Full-text search across all document fields, best matches first. |
| `update` | `(id: string, patch: Partial<T>) → Promise<void>` | Shallow-merge `patch` into the stored document. |
| `remove` | `(id: string) → Promise<void>` | Delete one document by `_id`. |
| `removeWhere` | `(filter) → Promise<number>` | Delete all documents matching a non-empty filter. Returns the deleted count. |
| `count` | `(filter?) → Promise<number>` | Count documents matching the filter (all documents when omitted). |

`Meta` is `{ _id: string; _created_at: string; _updated_at: string }` — set by the server, stripped
out of any `doc`/`patch` you pass in so app data can't shadow it.

`FindOptions` (used by `find`, and by `createReactiveCollection`'s options): `{ sort?: Record<string, 1 | -1>; limit?: number; offset?: number }`. Sort direction: `1` ascending, `-1` descending. `limit` defaults to 100, clamped to 1000.

### Filter syntax

Mongo-style filter objects. Multiple fields AND together.

```typescript
// Exact match
{ status: 'active' }

// Comparison operators
{ age: { $gt: 18 } }
{ score: { $gte: 90, $lt: 100 } }
{ name: { $ne: 'admin' } }        // also matches documents missing the field

// Membership
{ tags: { $in: ['a', 'b'] } }

// Array contains (same syntax as scalar equality)
{ tags: 'intro' }                 // matches a scalar field equal to 'intro', or an array field containing it

// Existence
{ avatar: { $exists: true } }

// Dotted path into a nested object
{ 'address.city': 'nyc' }
```

Supported operators: `$gt` `$gte` `$lt` `$lte` `$ne` `$in` `$exists`. `_id`, `_created_at`,
`_updated_at` are matched directly as meta columns; every other field is a JSON path into the
stored document.

### `createReactiveCollection`

```typescript
const [notes, { insert, update, remove, refresh, dispose }] = appDb.createReactiveCollection<Note>(
  'notes',
  { filter: { tags: 'intro' }, sort: { _created_at: -1 }, limit: 50 },
);

// notes() is a Solid signal holding the current query results
```

Runs the query once on creation and keeps a Solid signal in sync: `insert`/`update`/`remove`
mutate the collection then refresh the signal; `refresh()` re-runs the query manually; `dispose()`
stops refreshing and drops the change subscription (called automatically on Solid cleanup, via
`onCleanup`, when created inside a reactive owner). Also subscribes (best-effort) to server-side
changes on the collection, so a write from another window or the agent triggers a refetch too.

---

## On-Disk Schema (`data.db`)

One SQLite database per app at `storage/apps/{appId}/data.db`, opened with
`PRAGMA journal_mode=WAL` and `PRAGMA synchronous=NORMAL`. One table per collection, created
lazily on first use (`ensureCollection`, idempotent):

```sql
CREATE TABLE IF NOT EXISTS "{name}" (
  _id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  _data TEXT NOT NULL,                          -- JSON blob of the full document
  _created_at TEXT NOT NULL DEFAULT (datetime('now')),
  _updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 index kept in sync by triggers, content-linked (no duplicated text)
CREATE VIRTUAL TABLE IF NOT EXISTS "{name}_fts" USING fts5(
  _data,
  content="{name}",
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS "{name}_fts_ai" AFTER INSERT ON "{name}" BEGIN
  INSERT INTO "{name}_fts"(rowid, _data) VALUES (new.rowid, new._data);
END;
CREATE TRIGGER IF NOT EXISTS "{name}_fts_ad" AFTER DELETE ON "{name}" BEGIN
  INSERT INTO "{name}_fts"("{name}_fts", rowid, _data) VALUES ('delete', old.rowid, old._data);
END;
CREATE TRIGGER IF NOT EXISTS "{name}_fts_au" AFTER UPDATE ON "{name}" BEGIN
  INSERT INTO "{name}_fts"("{name}_fts", rowid, _data) VALUES ('delete', old.rowid, old._data);
  INSERT INTO "{name}_fts"(rowid, _data) VALUES (new.rowid, new._data);
END;
```

Collection names become quoted table names, so they're validated before touching SQL:
`/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/`, not starting with `sqlite_` (reserved by SQLite), and not
ending in `_fts`/`_fts_data`/`_fts_idx`/`_fts_docsize`/`_fts_config`/`_fts_content` (the FTS shadow
tables). `drop(collection)` drops both the collection table and its `_fts` table.

`search(collection, query, limit?)` quotes each whitespace-separated term of `query`
(escaping embedded `"`) before handing it to FTS5 `MATCH`, so user input can't inject FTS query
syntax. Results carry an extra `_rank` field and are ordered best-match first. An empty query
(after quoting) returns `[]` without touching the database.

---

## Filter → SQL Translation

Field names map to JSON paths: `{ a: 1 }` → `$."a"`; a dotted field `"a.b"` → `$."a"."b"`. JSON
paths and values are always bound as parameters — nothing from a filter ever lands in SQL text.

| Filter shape | SQL (on a JSON field) | SQL (on a meta column: `_id`/`_created_at`/`_updated_at`) |
|---|---|---|
| `{ f: v }` (scalar) | `EXISTS (SELECT 1 FROM json_each(_data, ?) WHERE json_each.value = ?)` — matches the scalar or array-membership | `{column} = ?` |
| `{ f: null }` | `json_type(_data, ?) = 'null'` | `{column} = ?` |
| `{ f: {obj/array} }` | `json_extract(_data, ?) = ?` (canonical JSON text) | n/a |
| `{ f: { $gt/$gte/$lt/$lte: v } }` | `json_extract(_data, ?) {op} ?` | `{column} {op} ?` |
| `{ f: { $ne: v } }` | `json_extract(_data, ?) IS NOT ?` (also matches a missing field) | `{column} IS NOT ?` |
| `{ f: { $in: [...] } }` | `EXISTS (SELECT 1 FROM json_each(_data, ?) WHERE json_each.value IN (...))` | `{column} IN (...)` |
| `{ f: { $exists: true\|false } }` | `json_type(_data, ?) IS [NOT] NULL` | `{column} IS [NOT] NULL` |

`$in` requires a non-empty array (throws otherwise). Booleans bind as `1`/`0`; `null`/`undefined`
bind as SQL `NULL`; objects/arrays bind as their `JSON.stringify` text.

`find` options compile to an `ORDER BY … LIMIT ? [OFFSET ?]` tail: each sort entry is
`{column} ASC|DESC` for a meta column or `json_extract(_data, ?) ASC|DESC` for a JSON field;
`limit` clamps to `[1, 1000]` (default 100 when omitted); `offset` clamps to `>= 0` and is only
emitted when positive.

---

## URI Routing (`yaar://apps/{appId}/db`)

Verbs: `read`, `list`, `invoke`, `delete`. Every mutation notifies subscribers of that URI
(`subscriptionRegistry.notifyChange`), which is what powers `createReactiveCollection`'s
cross-window refresh.

| URI | `read` / `list` | `invoke` | `delete` |
|---|---|---|---|
| `yaar://apps/{appId}/db` | Collection listing: `[{ uri, name, description: "N documents" }, ...]` | refused — requires a collection | refused — drop collections individually |
| `yaar://apps/{appId}/db/{collection}` | Recent documents, sorted `_created_at` desc (default limit) | see actions below | Drop the collection → `{ dropped: true }` |
| `yaar://apps/{appId}/db/{collection}/{docId}` | One document, or an error if not found | `{ action: 'update', patch }` → `{ updated: true }` | Delete the document → `{ deleted: true }`, or an error if not found |

`invoke` on a collection dispatches on `payload.action`:

| Action | Payload | Result |
|---|---|---|
| `insert` | `{ doc }` | `{ _id }` |
| `insertMany` | `{ docs: [...] }` | `{ ids: [...] }` |
| `find` | `{ filter?, sort?, limit?, offset? }` | `[doc, ...]` |
| `search` | `{ query, limit? }` | `[{ ...doc, _rank }, ...]` |
| `count` | `{ filter? }` | `{ count }` |
| `removeWhere` | `{ filter }` (must be non-empty) | `{ deleted }` |

`update` is a document-level action only (`yaar://apps/{appId}/db/{collection}/{docId}`), not a
collection-level one. Every document returned carries the meta fields
`_id`, `_created_at`, `_updated_at` (plus `_rank` for `search` results).

---

## Database Pool

**Source:** `packages/server/src/db/pool.ts`

One `AppDatabase` stays open per app while in use, keyed by `appId` (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`,
otherwise `getAppDatabase` throws). The file lives at `storage/apps/{appId}/data.db`, resolved
through the storage manager (parent directories created on first open).

| Constant | Value | Behavior |
|---|---|---|
| `MAX_OPEN` | 20 | Above this, the least-recently-used database is closed before opening a new one. |
| `IDLE_TIMEOUT_MS` | 5 minutes | A sweep (every `SWEEP_INTERVAL_MS` = 60s) closes any database idle longer than this. |

`closeAppDatabase(appId)` closes one database on demand (e.g. app uninstall);
`closeAllAppDatabases()` closes every pooled database (server shutdown).
