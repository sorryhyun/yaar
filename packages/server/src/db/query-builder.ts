/**
 * Query builder — translates Mongo-style filter objects into SQL over the
 * per-collection `_data` JSON column.
 *
 * Field names map to JSON paths (`{ a: 1 }` → `$."a"`; dots nest: `"a.b"` →
 * `$."a"."b"`). The meta columns `_id`, `_created_at`, `_updated_at` are
 * addressed directly. JSON paths and values are always bound as parameters —
 * nothing from a filter ever lands in SQL text.
 *
 * Supported operators: `$gt` `$gte` `$lt` `$lte` `$ne` `$in` `$exists`.
 * Plain equality on a JSON field uses `json_each`, which matches both scalar
 * values and array membership (`{ tags: 'intro' }` matches `tags: ['intro']`).
 */

export type DbFilter = Record<string, unknown>;

export interface DbSort {
  [field: string]: 1 | -1;
}

export interface DbFindOptions {
  sort?: DbSort;
  limit?: number;
  offset?: number;
}

export interface SqlFragment {
  sql: string;
  params: (string | number | null)[];
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

const META_COLUMNS = new Set(['_id', '_created_at', '_updated_at']);

const COMPARISON_OPS: Record<string, string> = {
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
};

/** Convert a JS value to an SQLite-bindable value (JSON booleans store as 1/0). */
function toParam(value: unknown): string | number | null {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  // Objects/arrays compare by canonical JSON text (json_extract returns minified JSON)
  return JSON.stringify(value);
}

/** Build a JSON path parameter for a (possibly dotted) field name. */
function jsonPath(field: string): string {
  if (field.includes('"')) {
    throw new Error(`Invalid field name "${field}": double quotes are not allowed.`);
  }
  const segments = field.split('.').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Empty field name in filter.');
  }
  return '$.' + segments.map((s) => `"${s}"`).join('.');
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((k) => k.startsWith('$'))
  );
}

/** Build one condition for a meta column (`_id`, `_created_at`, `_updated_at`). */
function metaCondition(column: string, value: unknown, frag: SqlFragment): void {
  if (isOperatorObject(value)) {
    for (const [op, operand] of Object.entries(value)) {
      if (COMPARISON_OPS[op]) {
        frag.sql += ` AND ${column} ${COMPARISON_OPS[op]} ?`;
        frag.params.push(toParam(operand));
      } else if (op === '$ne') {
        frag.sql += ` AND ${column} IS NOT ?`;
        frag.params.push(toParam(operand));
      } else if (op === '$in') {
        if (!Array.isArray(operand) || operand.length === 0) {
          throw new Error(`$in requires a non-empty array (field "${column}").`);
        }
        frag.sql += ` AND ${column} IN (${operand.map(() => '?').join(', ')})`;
        frag.params.push(...operand.map(toParam));
      } else if (op === '$exists') {
        frag.sql += operand ? ` AND ${column} IS NOT NULL` : ` AND ${column} IS NULL`;
      } else {
        throw new Error(`Unknown operator "${op}" (field "${column}").`);
      }
    }
    return;
  }
  frag.sql += ` AND ${column} = ?`;
  frag.params.push(toParam(value));
}

/** Build one condition for a JSON document field. */
function fieldCondition(field: string, value: unknown, frag: SqlFragment): void {
  const path = jsonPath(field);

  if (isOperatorObject(value)) {
    for (const [op, operand] of Object.entries(value)) {
      if (COMPARISON_OPS[op]) {
        frag.sql += ` AND json_extract(_data, ?) ${COMPARISON_OPS[op]} ?`;
        frag.params.push(path, toParam(operand));
      } else if (op === '$ne') {
        // IS NOT also matches documents where the field is missing (NULL)
        frag.sql += ` AND json_extract(_data, ?) IS NOT ?`;
        frag.params.push(path, toParam(operand));
      } else if (op === '$in') {
        if (!Array.isArray(operand) || operand.length === 0) {
          throw new Error(`$in requires a non-empty array (field "${field}").`);
        }
        const placeholders = operand.map(() => '?').join(', ');
        frag.sql += ` AND EXISTS (SELECT 1 FROM json_each(_data, ?) WHERE json_each.value IN (${placeholders}))`;
        frag.params.push(path, ...operand.map(toParam));
      } else if (op === '$exists') {
        frag.sql += operand
          ? ` AND json_type(_data, ?) IS NOT NULL`
          : ` AND json_type(_data, ?) IS NULL`;
        frag.params.push(path);
      } else {
        throw new Error(`Unknown operator "${op}" (field "${field}").`);
      }
    }
    return;
  }

  if (value === null) {
    // json_extract can't distinguish JSON null from a missing key; json_type can
    frag.sql += ` AND json_type(_data, ?) = 'null'`;
    frag.params.push(path);
    return;
  }

  if (typeof value === 'object') {
    // Array/object equality — compare canonical JSON text
    frag.sql += ` AND json_extract(_data, ?) = ?`;
    frag.params.push(path, JSON.stringify(value));
    return;
  }

  // Scalar equality via json_each: matches the scalar itself, or membership
  // when the field holds an array (json_each yields one row per element,
  // or a single row with the value for non-arrays; zero rows when missing).
  frag.sql += ` AND EXISTS (SELECT 1 FROM json_each(_data, ?) WHERE json_each.value = ?)`;
  frag.params.push(path, toParam(value));
}

/**
 * Build a WHERE clause (starting with "WHERE 1=1" for uniform AND-chaining)
 * from a filter object. An empty/undefined filter matches everything.
 */
export function buildWhere(filter?: DbFilter): SqlFragment {
  const frag: SqlFragment = { sql: 'WHERE 1=1', params: [] };
  if (!filter) return frag;
  for (const [field, value] of Object.entries(filter)) {
    if (META_COLUMNS.has(field)) {
      metaCondition(field, value, frag);
    } else {
      fieldCondition(field, value, frag);
    }
  }
  return frag;
}

/** Build an ORDER BY / LIMIT / OFFSET tail from find options. */
export function buildTail(options?: DbFindOptions): SqlFragment {
  const frag: SqlFragment = { sql: '', params: [] };

  const sortEntries = Object.entries(options?.sort ?? {});
  if (sortEntries.length > 0) {
    const parts: string[] = [];
    for (const [field, direction] of sortEntries) {
      const dir = direction === -1 ? 'DESC' : 'ASC';
      if (META_COLUMNS.has(field)) {
        parts.push(`${field} ${dir}`);
      } else {
        parts.push(`json_extract(_data, ?) ${dir}`);
        frag.params.push(jsonPath(field));
      }
    }
    frag.sql += ` ORDER BY ${parts.join(', ')}`;
  }

  const limit = Math.min(Math.max(1, Math.floor(options?.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  frag.sql += ' LIMIT ?';
  frag.params.push(limit);

  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  if (offset > 0) {
    frag.sql += ' OFFSET ?';
    frag.params.push(offset);
  }

  return frag;
}
