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

import { okJson, okLinks, error, type VerbResult } from '../../lib/verb-result.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { defineActions, summarizeActions } from '../define-actions.js';
import { errMessage } from '@yaar/lib/errors';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import {
  getAppDatabase,
  type AppDatabase,
  type DbFilter,
  type DbFindOptions,
} from '../../db/index.js';
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

interface CollectionCtx {
  db: AppDatabase;
  collection: string;
  /** The URI invoked, which is what subscribers to this collection are notified on. */
  uri: string;
  payload: Record<string, unknown>;
}

function filterOf(payload: Record<string, unknown>): DbFilter | undefined {
  return (payload.filter ?? undefined) as DbFilter | undefined;
}

/** Actions on `/db/{collection}`. */
const collectionActions = defineActions<CollectionCtx>(
  {
    insert: {
      description: 'Insert "doc"; returns its _id.',
      run: ({ db, collection, uri, payload }) => {
        if (!payload.doc || typeof payload.doc !== 'object') {
          return error('"doc" (object) is required for insert.');
        }
        const _id = db.insert(collection, payload.doc as Record<string, unknown>);
        subscriptionRegistry.notifyChange(uri);
        return okJson({ _id });
      },
    },
    insertMany: {
      description: 'Insert every document in "docs"; returns their ids.',
      run: ({ db, collection, uri, payload }) => {
        if (!Array.isArray(payload.docs)) {
          return error('"docs" (array of objects) is required for insertMany.');
        }
        const ids = db.insertMany(collection, payload.docs as Record<string, unknown>[]);
        subscriptionRegistry.notifyChange(uri);
        return okJson({ ids });
      },
    },
    find: {
      description: 'Documents matching "filter", with optional sort/limit/offset.',
      run: ({ db, collection, payload }) =>
        okJson(db.find(collection, filterOf(payload), findOptionsFrom(payload))),
    },
    search: {
      description: 'Full-text search for "query".',
      run: ({ db, collection, payload }) => {
        if (typeof payload.query !== 'string') {
          return error('"query" (string) is required for search.');
        }
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        return okJson(db.search(collection, payload.query, limit));
      },
    },
    count: {
      description: 'How many documents match "filter".',
      run: ({ db, collection, payload }) =>
        okJson({ count: db.count(collection, filterOf(payload)) }),
    },
    removeWhere: {
      description: 'Delete every document matching a non-empty "filter".',
      run: ({ db, collection, uri, payload }) => {
        const filter = filterOf(payload);
        if (!filter || Object.keys(filter).length === 0) {
          return error(
            'removeWhere requires a non-empty "filter". To delete everything, drop the collection.',
          );
        }
        const deleted = db.removeWhere(collection, filter);
        if (deleted > 0) subscriptionRegistry.notifyChange(uri);
        return okJson({ deleted });
      },
    },
  },
  {
    unknown: (action, names) =>
      error(`Unknown db action "${action}". Supported: ${names.join(', ')}.`),
  },
);

/** Actions on `/db/{collection}/{docId}`. */
const documentActions = defineActions<CollectionCtx & { docId: string }>(
  {
    update: {
      description: 'Shallow-merge "patch" into the document.',
      run: ({ db, collection, docId, uri, payload }) => {
        if (!payload.patch || typeof payload.patch !== 'object') {
          return error('"patch" (object) is required for update.');
        }
        const updated = db.update(collection, docId, payload.patch as Record<string, unknown>);
        if (!updated) return error(`Document "${docId}" not found in collection "${collection}".`);
        subscriptionRegistry.notifyChange(uri);
        return okJson({ updated: true });
      },
    },
  },
  {
    unknown: () => error('Document URIs support only { action: "update", patch: {...} }.'),
  },
);

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
      // One schema for both URI shapes, so the enum is the union of the two tables.
      action: {
        type: 'string',
        enum: [...collectionActions.names, ...documentActions.names],
        description:
          `Collection actions: ${summarizeActions(collectionActions)}. ` +
          `Document actions (URI ends with /{docId}): ${summarizeActions(documentActions)}.`,
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
      // Awaited, here and below, so a throw inside an action (a bad collection name) lands
      // in the catch rather than escaping as a rejection.
      return await documentActions.dispatch(String(payload?.action ?? ''), {
        db,
        collection,
        docId,
        uri: resolved.sourceUri,
        payload: payload ?? {},
      });
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
    return await collectionActions.dispatch(String(action), {
      db,
      collection,
      uri: resolved.sourceUri,
      payload: payload!,
    });
  } catch (err) {
    return error(errMessage(err));
  }
}
