/**
 * AppDatabase — per-app SQLite wrapper (bun:sqlite) for structured app data.
 *
 * Collection model (see docs/guides/sqlite.md): one SQL table per collection,
 * documents stored as JSON in `_data` with `_id` / `_created_at` /
 * `_updated_at` meta columns, plus an FTS5 index kept in sync by triggers.
 *
 * Collection names become (quoted) table names, so they are validated against
 * a strict identifier pattern before touching SQL. Filters/values go through
 * the query builder, which binds everything as parameters.
 */

import { Database } from 'bun:sqlite';
import {
  buildWhere,
  buildTail,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  type DbFilter,
  type DbFindOptions,
} from './query-builder.js';

export type DbDocument = Record<string, unknown> & {
  _id: string;
  _created_at: string;
  _updated_at: string;
};

interface Row {
  _id: string;
  _data: string;
  _created_at: string;
  _updated_at: string;
  _rank?: number;
}

const COLLECTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** FTS5 shadow tables created alongside `{name}_fts`. */
const FTS_SHADOW_RE = /_fts(_data|_idx|_docsize|_config|_content)?$/;

export function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new Error(
      `Invalid collection name "${name}". Use letters, digits, "_" or "-" (max 64 chars, must not start with a digit or "-").`,
    );
  }
  if (name.toLowerCase().startsWith('sqlite_')) {
    throw new Error(`Invalid collection name "${name}": "sqlite_" prefix is reserved.`);
  }
  if (FTS_SHADOW_RE.test(name)) {
    throw new Error(`Invalid collection name "${name}": "_fts" suffix is reserved.`);
  }
}

const META_KEYS = ['_id', '_created_at', '_updated_at', '_rank'];

/** Strip meta keys so user data can't shadow the generated columns. */
function stripMeta(doc: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...doc };
  for (const key of META_KEYS) delete clean[key];
  return clean;
}

function rowToDoc(row: Row): DbDocument {
  return {
    ...(JSON.parse(row._data) as Record<string, unknown>),
    _id: row._id,
    _created_at: row._created_at,
    _updated_at: row._updated_at,
    ...(row._rank !== undefined ? { _rank: row._rank } : {}),
  };
}

/** Quote each whitespace-separated term so FTS5 syntax chars can't break the query. */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ');
}

export class AppDatabase {
  private db: Database;
  private ensured = new Set<string>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
  }

  private hasTable(name: string): boolean {
    const row = this.db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    return row !== null;
  }

  /** Create the collection table, FTS index, and sync triggers (idempotent). */
  ensureCollection(name: string): void {
    assertCollectionName(name);
    if (this.ensured.has(name)) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${name}" (
        _id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        _data TEXT NOT NULL,
        _created_at TEXT NOT NULL DEFAULT (datetime('now')),
        _updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS "${name}_fts" USING fts5(
        _data,
        content="${name}",
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS "${name}_fts_ai" AFTER INSERT ON "${name}" BEGIN
        INSERT INTO "${name}_fts"(rowid, _data) VALUES (new.rowid, new._data);
      END;
      CREATE TRIGGER IF NOT EXISTS "${name}_fts_ad" AFTER DELETE ON "${name}" BEGIN
        INSERT INTO "${name}_fts"("${name}_fts", rowid, _data) VALUES ('delete', old.rowid, old._data);
      END;
      CREATE TRIGGER IF NOT EXISTS "${name}_fts_au" AFTER UPDATE ON "${name}" BEGIN
        INSERT INTO "${name}_fts"("${name}_fts", rowid, _data) VALUES ('delete', old.rowid, old._data);
        INSERT INTO "${name}_fts"(rowid, _data) VALUES (new.rowid, new._data);
      END;
    `);
    this.ensured.add(name);
  }

  insert(collection: string, doc: Record<string, unknown>): string {
    this.ensureCollection(collection);
    const row = this.db
      .query(`INSERT INTO "${collection}" (_data) VALUES (?) RETURNING _id`)
      .get(JSON.stringify(stripMeta(doc))) as { _id: string };
    return row._id;
  }

  insertMany(collection: string, docs: Record<string, unknown>[]): string[] {
    this.ensureCollection(collection);
    const insertAll = this.db.transaction((items: Record<string, unknown>[]) => {
      const stmt = this.db.query(`INSERT INTO "${collection}" (_data) VALUES (?) RETURNING _id`);
      return items.map((d) => (stmt.get(JSON.stringify(stripMeta(d))) as { _id: string })._id);
    });
    return insertAll(docs);
  }

  get(collection: string, id: string): DbDocument | null {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return null;
    const row = this.db
      .query(`SELECT _id, _data, _created_at, _updated_at FROM "${collection}" WHERE _id = ?`)
      .get(id) as Row | null;
    return row ? rowToDoc(row) : null;
  }

  find(collection: string, filter?: DbFilter, options?: DbFindOptions): DbDocument[] {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return [];
    const where = buildWhere(filter);
    const tail = buildTail(options);
    const rows = this.db
      .query(
        `SELECT _id, _data, _created_at, _updated_at FROM "${collection}" ${where.sql}${tail.sql}`,
      )
      .all(...where.params, ...tail.params) as Row[];
    return rows.map(rowToDoc);
  }

  count(collection: string, filter?: DbFilter): number {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return 0;
    const where = buildWhere(filter);
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM "${collection}" ${where.sql}`)
      .get(...where.params) as { n: number };
    return row.n;
  }

  /** Full-text search via FTS5, best matches first. */
  search(collection: string, query: string, limit = DEFAULT_LIMIT): DbDocument[] {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return [];
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .query(
        `SELECT c._id, c._data, c._created_at, c._updated_at, "${collection}_fts".rank AS _rank
         FROM "${collection}_fts" JOIN "${collection}" c ON c.rowid = "${collection}_fts".rowid
         WHERE "${collection}_fts" MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT)) as Row[];
    return rows.map(rowToDoc);
  }

  /** Shallow-merge `patch` into the stored document. Returns false if the id doesn't exist. */
  update(collection: string, id: string, patch: Record<string, unknown>): boolean {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return false;
    const row = this.db.query(`SELECT _data FROM "${collection}" WHERE _id = ?`).get(id) as {
      _data: string;
    } | null;
    if (!row) return false;
    const merged = { ...(JSON.parse(row._data) as Record<string, unknown>), ...stripMeta(patch) };
    this.db.run(
      `UPDATE "${collection}" SET _data = ?, _updated_at = datetime('now') WHERE _id = ?`,
      [JSON.stringify(merged), id],
    );
    return true;
  }

  remove(collection: string, id: string): boolean {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return false;
    const result = this.db.run(`DELETE FROM "${collection}" WHERE _id = ?`, [id]);
    return result.changes > 0;
  }

  /** Delete all documents matching the filter. An empty filter deletes everything. */
  removeWhere(collection: string, filter?: DbFilter): number {
    assertCollectionName(collection);
    if (!this.hasTable(collection)) return 0;
    const where = buildWhere(filter);
    // .changes would also count FTS trigger writes — count matches explicitly
    const matched = this.count(collection, filter);
    if (matched > 0) {
      this.db.run(`DELETE FROM "${collection}" ${where.sql}`, where.params);
    }
    return matched;
  }

  /** List collection names (excludes FTS shadow tables). */
  collections(): string[] {
    const rows = this.db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name).filter((n) => !FTS_SHADOW_RE.test(n));
  }

  drop(collection: string): void {
    assertCollectionName(collection);
    this.db.exec(`DROP TABLE IF EXISTS "${collection}"`);
    this.db.exec(`DROP TABLE IF EXISTS "${collection}_fts"`);
    this.ensured.delete(collection);
  }

  close(): void {
    this.db.close();
  }
}
