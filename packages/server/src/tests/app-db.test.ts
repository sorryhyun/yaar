import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AppDatabase, assertCollectionName } from '../db/app-db.js';
import { buildWhere, buildTail, MAX_LIMIT } from '../db/query-builder.js';

describe('query-builder', () => {
  it('empty filter matches everything', () => {
    const { sql, params } = buildWhere();
    expect(sql).toBe('WHERE 1=1');
    expect(params).toEqual([]);
  });

  it('binds JSON paths and values as parameters', () => {
    const { sql, params } = buildWhere({ status: 'active' });
    expect(sql).toContain('json_each(_data, ?)');
    expect(params).toEqual(['$."status"', 'active']);
  });

  it('normalizes booleans to 1/0', () => {
    const { params } = buildWhere({ done: true });
    expect(params).toEqual(['$."done"', 1]);
  });

  it('maps meta fields to columns', () => {
    const { sql, params } = buildWhere({ _id: 'abc' });
    expect(sql).toContain('_id = ?');
    expect(sql).not.toContain('json_extract');
    expect(params).toEqual(['abc']);
  });

  it('nests dotted field names', () => {
    const { params } = buildWhere({ 'author.name': 'kim' });
    expect(params[0]).toBe('$."author"."name"');
  });

  it('rejects unknown operators', () => {
    expect(() => buildWhere({ x: { $regex: '.*' } })).toThrow('Unknown operator');
  });

  it('rejects empty $in', () => {
    expect(() => buildWhere({ x: { $in: [] } })).toThrow('non-empty');
  });

  it('rejects field names with double quotes', () => {
    expect(() => buildWhere({ 'a"b': 1 })).toThrow('double quotes');
  });

  it('clamps limit to MAX_LIMIT and defaults offset', () => {
    const { sql, params } = buildTail({ limit: 999999, offset: -5 });
    expect(sql).toBe(' LIMIT ?');
    expect(params).toEqual([MAX_LIMIT]);
  });

  it('sorts by meta column and JSON path', () => {
    const { sql, params } = buildTail({ sort: { _created_at: -1, title: 1 } });
    expect(sql).toContain('_created_at DESC');
    expect(sql).toContain('json_extract(_data, ?) ASC');
    expect(params[0]).toBe('$."title"');
  });
});

describe('collection name validation', () => {
  it('accepts typical names', () => {
    expect(() => assertCollectionName('notes')).not.toThrow();
    expect(() => assertCollectionName('my-feed_items2')).not.toThrow();
    expect(() => assertCollectionName('_private')).not.toThrow();
  });

  it('rejects SQL-breaking and reserved names', () => {
    expect(() => assertCollectionName('notes"; DROP TABLE x;--')).toThrow();
    expect(() => assertCollectionName('a b')).toThrow();
    expect(() => assertCollectionName('')).toThrow();
    expect(() => assertCollectionName('1abc')).toThrow();
    expect(() => assertCollectionName('sqlite_master')).toThrow('reserved');
    expect(() => assertCollectionName('notes_fts')).toThrow('reserved');
    expect(() => assertCollectionName('notes_fts_data')).toThrow('reserved');
  });
});

describe('AppDatabase', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('insert/get roundtrip with meta fields', () => {
    const id = db.insert('notes', { title: 'Hello', tags: ['intro'] });
    expect(id).toMatch(/^[0-9a-f]{16}$/);

    const doc = db.get('notes', id);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('Hello');
    expect(doc!.tags).toEqual(['intro']);
    expect(doc!._id).toBe(id);
    expect(typeof doc!._created_at).toBe('string');
    expect(typeof doc!._updated_at).toBe('string');
  });

  it('strips caller-provided meta keys on insert', () => {
    const id = db.insert('notes', { _id: 'spoofed', title: 'x' });
    expect(id).not.toBe('spoofed');
    expect(db.get('notes', id)!._id).toBe(id);
  });

  it('reads on missing collections return empty, not created tables', () => {
    expect(db.get('ghost', 'x')).toBeNull();
    expect(db.find('ghost')).toEqual([]);
    expect(db.count('ghost')).toBe(0);
    expect(db.search('ghost', 'q')).toEqual([]);
    expect(db.collections()).toEqual([]);
  });

  it('find with equality, operators, and array contains', () => {
    db.insertMany('items', [
      { name: 'a', score: 10, tags: ['x', 'y'], active: true },
      { name: 'b', score: 50, tags: ['y'], active: false },
      { name: 'c', score: 90, tags: [], active: true },
    ]);

    expect(db.find('items', { name: 'b' })).toHaveLength(1);
    expect(db.find('items', { score: { $gt: 20 } })).toHaveLength(2);
    expect(db.find('items', { score: { $gte: 10, $lt: 90 } })).toHaveLength(2);
    expect(db.find('items', { tags: 'y' })).toHaveLength(2); // array contains
    expect(db.find('items', { active: true })).toHaveLength(2); // boolean normalization
    expect(db.find('items', { name: { $in: ['a', 'c'] } })).toHaveLength(2);
    expect(db.find('items', { name: { $ne: 'a' } })).toHaveLength(2);
    expect(db.find('items', { missing: { $exists: false } })).toHaveLength(3);
    expect(db.find('items', { score: { $exists: true } })).toHaveLength(3);
    expect(db.find('items', { name: 'a', score: 10 })).toHaveLength(1); // AND
    expect(db.find('items', { name: 'a', score: 99 })).toHaveLength(0);
  });

  it('$ne matches documents missing the field', () => {
    db.insert('m', { a: 1 });
    db.insert('m', { b: 2 });
    expect(db.find('m', { a: { $ne: 1 } })).toHaveLength(1);
  });

  it('matches JSON null vs missing distinctly', () => {
    db.insert('n', { v: null });
    db.insert('n', { w: 1 });
    expect(db.find('n', { v: null })).toHaveLength(1);
    expect(db.find('n', { v: { $exists: true } })).toHaveLength(1);
  });

  it('sort, limit, offset', () => {
    db.insertMany('s', [{ n: 3 }, { n: 1 }, { n: 2 }]);
    const sorted = db.find('s', undefined, { sort: { n: 1 } });
    expect(sorted.map((d) => d.n)).toEqual([1, 2, 3]);

    const page = db.find('s', undefined, { sort: { n: -1 }, limit: 1, offset: 1 });
    expect(page.map((d) => d.n)).toEqual([2]);
  });

  it('update shallow-merges and preserves other fields', () => {
    const id = db.insert('notes', { title: 'old', body: 'keep' });
    expect(db.update('notes', id, { title: 'new', _id: 'spoof' })).toBe(true);

    const doc = db.get('notes', id)!;
    expect(doc.title).toBe('new');
    expect(doc.body).toBe('keep');
    expect(doc._id).toBe(id);

    expect(db.update('notes', 'nonexistent', { x: 1 })).toBe(false);
  });

  it('remove and removeWhere', () => {
    const id = db.insert('r', { kind: 'draft' });
    db.insertMany('r', [{ kind: 'draft' }, { kind: 'final' }]);

    expect(db.remove('r', id)).toBe(true);
    expect(db.remove('r', id)).toBe(false);
    expect(db.removeWhere('r', { kind: 'draft' })).toBe(1);
    expect(db.count('r')).toBe(1);
  });

  it('full-text search stays in sync through insert/update/delete', () => {
    const id = db.insert('docs', { title: 'quantum computing intro' });
    db.insert('docs', { title: 'gardening tips' });

    expect(db.search('docs', 'quantum')).toHaveLength(1);
    expect(db.search('docs', 'quantum computing')).toHaveLength(1);

    db.update('docs', id, { title: 'classical mechanics' });
    expect(db.search('docs', 'quantum')).toHaveLength(0);
    expect(db.search('docs', 'classical')).toHaveLength(1);

    db.remove('docs', id);
    expect(db.search('docs', 'classical')).toHaveLength(0);
    expect(db.search('docs', 'gardening')).toHaveLength(1);
  });

  it('search survives FTS syntax characters in the query', () => {
    db.insert('q', { text: 'hello world' });
    expect(() => db.search('q', 'hello "unbalanced OR (')).not.toThrow();
    expect(db.search('q', 'hello')).toHaveLength(1);
  });

  it('collections() lists tables without FTS shadows; drop removes them', () => {
    db.insert('alpha', { x: 1 });
    db.insert('beta', { x: 2 });
    expect(db.collections().sort()).toEqual(['alpha', 'beta']);

    db.drop('alpha');
    expect(db.collections()).toEqual(['beta']);
    expect(db.find('alpha')).toEqual([]);

    // Re-creating a dropped collection works (ensured-cache invalidation)
    db.insert('alpha', { x: 3 });
    expect(db.count('alpha')).toBe(1);
  });

  it('insertMany is transactional and returns ids in order', () => {
    const ids = db.insertMany('t', [{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(ids).toHaveLength(3);
    ids.forEach((id, i) => expect(db.get('t', id)!.i).toBe(i));
  });

  it('object and array values compare by JSON equality', () => {
    db.insert('o', { pos: { x: 1, y: 2 }, tags: ['a', 'b'] });
    expect(db.find('o', { pos: { x: 1, y: 2 } })).toHaveLength(1); // operator-less object → JSON equality
    expect(db.find('o', { tags: ['a', 'b'] })).toHaveLength(1);
  });
});
