/**
 * `yaar://apps/{appId}/db/...` — app-scoped SQLite collections.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts`: the
 * `ResourceRegistry` wildcard syntax has no middle wildcard, so this subresource
 * cannot register itself. `handleDbVerb` returns `null` for a non-db URI, which is
 * how the composite falls through to storage and then to the app itself.
 *
 * See docs/reference/app_db_reference.md. On disk: storage/apps/{appId}/data.db
 */

import type { VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { okJson, okLinks, error } from '../utils.js';
import { errMessage } from '../../lib/errors.js';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import { getAppDatabase, type DbFilter, type DbFindOptions } from '../../db/index.js';
import { parseAppDbPath } from './paths.js';

/** Extract find options ({ sort, limit, offset }) from an invoke payload. */
function findOptionsFrom(payload: Record<string, unknown>): DbFindOptions {
  const options: DbFindOptions = {};
  if (payload.sort && typeof payload.sort === 'object') {
    options.sort = payload.sort as DbFindOptions['sort'];
  }
  if (typeof payload.limit === 'number') options.limit = payload.limit;
  if (typeof payload.offset === 'number') options.offset = payload.offset;
  return options;
}

export const DB_DESCRIBE = {
  description:
    'App-scoped SQLite database. Documents are stored in named collections and queried ' +
    'with Mongo-style filters: exact match { status: "active" }, operators ' +
    '{ age: { $gt: 18 } } ($gt/$gte/$lt/$lte/$ne/$in/$exists), array contains { tags: "intro" }. ' +
    'Meta fields _id, _created_at, _updated_at are set by the server.',
  verbs: ['read', 'list', 'invoke', 'delete'],
  invokeSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['insert', 'insertMany', 'find', 'search', 'count', 'removeWhere', 'update'],
        description:
          'Collection actions: insert/insertMany/find/search/count/removeWhere. ' +
          'Document actions (URI ends with /{docId}): update.',
      },
      doc: { type: 'object', description: 'Document to insert (for insert)' },
      docs: { type: 'array', description: 'Documents to insert (for insertMany)' },
      filter: { type: 'object', description: 'Filter object (for find/count/removeWhere)' },
      sort: { type: 'object', description: 'Sort spec, e.g. { _created_at: -1 } (for find)' },
      limit: { type: 'number', description: 'Max results (default 100, max 1000)' },
      offset: { type: 'number', description: 'Skip N results (for find)' },
      query: { type: 'string', description: 'Full-text search query (for search)' },
      patch: { type: 'object', description: 'Fields to shallow-merge (for update)' },
    },
  },
};

/**
 * Handle all verbs for `yaar://apps/{appId}/db/...` URIs.
 * Returns null when the URI is not a db path (caller falls through).
 */
export async function handleDbVerb(
  verb: 'read' | 'list' | 'invoke' | 'delete',
  resolved: ResolvedUri,
  payload?: Record<string, unknown>,
): Promise<VerbResult | null> {
  const dbPath = parseAppDbPath(resolved.sourceUri);
  if (!dbPath) return null;
  const { appId, collection, docId } = dbPath;

  try {
    const db = getAppDatabase(appId);

    // ── Bare /db — collection listing ──
    if (!collection) {
      if (verb === 'read' || verb === 'list') {
        return okLinks(
          db.collections().map((name) => ({
            uri: `yaar://apps/${appId}/db/${name}`,
            name,
            description: `${db.count(name)} documents`,
          })),
        );
      }
      if (verb === 'delete') {
        return error('Cannot delete the whole database. Drop collections individually.');
      }
      return error('Invoke requires a collection: yaar://apps/{appId}/db/{collection}.');
    }

    // ── /db/{collection}/{docId} — single document ──
    if (docId) {
      if (verb === 'read' || verb === 'list') {
        const doc = db.get(collection, docId);
        if (!doc) return error(`Document "${docId}" not found in collection "${collection}".`);
        return okJson(doc);
      }
      if (verb === 'delete') {
        const deleted = db.remove(collection, docId);
        if (!deleted) return error(`Document "${docId}" not found in collection "${collection}".`);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return okJson({ deleted: true });
      }
      // invoke
      if (payload?.action !== 'update') {
        return error('Document URIs support only { action: "update", patch: {...} }.');
      }
      if (!payload.patch || typeof payload.patch !== 'object') {
        return error('"patch" (object) is required for update.');
      }
      const updated = db.update(collection, docId, payload.patch as Record<string, unknown>);
      if (!updated) return error(`Document "${docId}" not found in collection "${collection}".`);
      subscriptionRegistry.notifyChange(resolved.sourceUri);
      return okJson({ updated: true });
    }

    // ── /db/{collection} — collection-level verbs ──
    if (verb === 'read' || verb === 'list') {
      return okJson(db.find(collection, undefined, { sort: { _created_at: -1 } }));
    }
    if (verb === 'delete') {
      db.drop(collection);
      subscriptionRegistry.notifyChange(resolved.sourceUri);
      return okJson({ dropped: true });
    }

    // invoke
    const action = payload?.action;
    if (!action) return error('Payload must include "action".');
    const filter = (payload?.filter ?? undefined) as DbFilter | undefined;

    switch (action) {
      case 'insert': {
        if (!payload?.doc || typeof payload.doc !== 'object') {
          return error('"doc" (object) is required for insert.');
        }
        const _id = db.insert(collection, payload.doc as Record<string, unknown>);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return okJson({ _id });
      }
      case 'insertMany': {
        if (!Array.isArray(payload?.docs)) {
          return error('"docs" (array of objects) is required for insertMany.');
        }
        const ids = db.insertMany(collection, payload.docs as Record<string, unknown>[]);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return okJson({ ids });
      }
      case 'find':
        return okJson(db.find(collection, filter, findOptionsFrom(payload!)));
      case 'search': {
        if (typeof payload?.query !== 'string') {
          return error('"query" (string) is required for search.');
        }
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        return okJson(db.search(collection, payload.query, limit));
      }
      case 'count':
        return okJson({ count: db.count(collection, filter) });
      case 'removeWhere': {
        if (!filter || Object.keys(filter).length === 0) {
          return error(
            'removeWhere requires a non-empty "filter". To delete everything, drop the collection.',
          );
        }
        const deleted = db.removeWhere(collection, filter);
        if (deleted > 0) subscriptionRegistry.notifyChange(resolved.sourceUri);
        return okJson({ deleted });
      }
      default:
        return error(
          `Unknown db action "${String(action)}". Supported: insert, insertMany, find, search, count, removeWhere.`,
        );
    }
  } catch (err) {
    return error(errMessage(err));
  }
}
