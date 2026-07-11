/**
 * Apps domain handlers for the verb layer.
 *
 * Maps app operations to the verb layer:
 *
 *   list('yaar://apps')                              → list all installed apps
 *   read('yaar://apps/{appId}')                      → load SKILL.md
 *   invoke('yaar://apps/{appId}', { action, ... })   → set_badge
 *   delete('yaar://apps/{appId}')                    → uninstall app
 *
 * App-scoped storage (Phase 2):
 *   read('yaar://apps/{appId}/storage/{path}')       → read file
 *   list('yaar://apps/{appId}/storage/{dir}')        → list directory
 *   invoke('yaar://apps/{appId}/storage/{path}', ..) → write file
 *   delete('yaar://apps/{appId}/storage/{path}')     → delete file
 *
 * On disk: storage/apps/{appId}/{path}
 *
 * App-scoped database (SQLite collections, see docs/sqlite-plan.md):
 *   list('yaar://apps/{appId}/db')                          → collection names
 *   read('yaar://apps/{appId}/db/{coll}')                   → recent documents
 *   read('yaar://apps/{appId}/db/{coll}/{id}')              → one document
 *   invoke('yaar://apps/{appId}/db/{coll}', { action })     → insert | insertMany | find | search | count | removeWhere
 *   invoke('yaar://apps/{appId}/db/{coll}/{id}', { action })→ update
 *   delete('yaar://apps/{appId}/db/{coll}/{id}')            → remove document
 *   delete('yaar://apps/{appId}/db/{coll}')                 → drop collection
 *
 * On disk: storage/apps/{appId}/data.db
 */

import type { OSAction } from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import {
  ok,
  okJson,
  okResource,
  okLinks,
  okWithImages,
  error,
  validateRelativePath,
  extractIdFromUri,
  mimeFromPath,
} from './utils.js';
import { resolvePath } from '../storage/storage-manager.js';
import { actionEmitter } from '../session/action-emitter.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { listApps } from '../features/apps/discovery.js';
import { describeApp, loadAppSkillWithManifest } from '../features/apps/describe.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
  storageGrep,
} from '../storage/storage-manager.js';
import { uninstallApp } from '../features/apps/install.js';
import { getAppDatabase, type DbFilter, type DbFindOptions } from '../db/index.js';

/**
 * Parse `yaar://apps/{appId}/storage/{path}` → { appId, path } or null.
 * Rejects paths containing `..` segments to prevent cross-app traversal.
 */
function parseAppStoragePath(uri: string): { appId: string; path: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/storage(?:\/(.*))?$/);
  if (!match) return null;
  const path = match[2] ?? '';
  // Block path traversal — apps must stay within their own namespace
  if (validateRelativePath(path)) return null;
  return { appId: match[1], path };
}

/** Parse `yaar://apps/{appId}/db[/{collection}[/{docId}]]` or null. */
function parseAppDbPath(
  uri: string,
): { appId: string; collection?: string; docId?: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/db(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/);
  if (!match) return null;
  return { appId: match[1], collection: match[2], docId: match[3] };
}

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

const DB_DESCRIBE = {
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
async function handleDbVerb(
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
    return error(err instanceof Error ? err.message : String(err));
  }
}

export function registerAppsHandlers(registry: ResourceRegistry): void {
  // ── yaar://apps — list all installed apps (exact match) ──
  const listHandler: ResourceHandler = {
    description: 'List all installed apps.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const apps = await listApps();
      return okLinks(
        apps.map((app) => ({
          uri: `yaar://apps/${app.id}`,
          name: app.name,
          description: app.description,
          kind: app.kind,
        })),
      );
    },
  };
  registry.register('yaar://apps', listHandler);

  // ── yaar://apps/{appId} — per-app operations + app-scoped storage/db ──
  registry.register('yaar://apps/*', {
    description:
      'A specific app. Read to load its SKILL.md, invoke to set_badge/install, delete to uninstall. ' +
      'Sub-path /storage/{path} provides app-scoped file storage. ' +
      'Sub-path /db/{collection} provides app-scoped SQLite collections (Mongo-style filters + full-text search).',
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['set_badge', 'install', 'write', 'clone'],
          description:
            'set_badge for app badge, install from marketplace, write for app storage, clone for source cloning',
        },
        count: { type: 'number', description: 'Badge count (0 to clear, for set_badge)' },
        content: { type: 'string', description: 'File content (for write)' },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Content encoding (default: utf-8)',
        },
      },
    },

    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      // Db sub-paths get the db API describe
      if (parseAppDbPath(resolved.sourceUri)) {
        return okJson({ uri: resolved.sourceUri, ...DB_DESCRIBE });
      }

      // Storage sub-paths get generic describe
      if (parseAppStoragePath(resolved.sourceUri)) {
        return okJson({
          uri: resolved.sourceUri,
          description: 'App-scoped file storage.',
          verbs: ['read', 'list', 'invoke', 'delete'],
        });
      }

      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');

      const result = await describeApp(appId);
      if (!result) return error(`App "${appId}" not found.`);

      result.uri = resolved.sourceUri;
      return okJson(result);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App db sub-path ──
      const dbResult = await handleDbVerb('read', resolved);
      if (dbResult) return dbResult;

      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        if (!storagePath.path) {
          // Bare storage root → redirect to list
          const listResult = await storageList(prefixedPath);
          if (!listResult.success) return error(listResult.error!);
          const readEntries = listResult.entries ?? [];
          return okLinks(
            readEntries.map((e) => {
              const relPath = e.path.replace(`apps/${storagePath.appId}/`, '');
              return {
                uri: `yaar://apps/${storagePath.appId}/storage/${relPath}`,
                name: relPath || e.path,
                description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
                mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
              };
            }),
          );
        }
        const result = await storageRead(prefixedPath);
        if (!result.success) return error(result.error!);
        // Images / PDFs — return base64 content items
        if (result.images?.length) {
          return okWithImages(result.content!, result.images);
        }
        // Unknown binary — read raw bytes and return as base64
        if (result.content?.startsWith('Binary file')) {
          const resolvedFile = resolvePath(prefixedPath);
          if (resolvedFile) {
            const buf = Buffer.from(await Bun.file(resolvedFile.absolutePath).arrayBuffer());
            return okWithImages('', [
              { data: buf.toString('base64'), mimeType: 'application/octet-stream' },
            ]);
          }
        }
        // Text content — return as embedded resource with URI + MIME
        return okResource(resolved.sourceUri, result.content!, mimeFromPath(storagePath.path));
      }

      // ── App skill (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');

      const result = await loadAppSkillWithManifest(appId);
      if (result === null) return error(`No SKILL.md found for app "${appId}".`);

      return okResource(resolved.sourceUri, result, 'text/markdown');
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App db sub-path ──
      const dbResult = await handleDbVerb('list', resolved);
      if (dbResult) return dbResult;

      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const result = await storageList(prefixedPath);
        if (!result.success) return error(result.error!);
        const entries = result.entries ?? [];
        return okLinks(
          entries.map((e) => {
            const relPath = e.path.replace(`apps/${storagePath.appId}/`, '');
            return {
              uri: `yaar://apps/${storagePath.appId}/storage/${relPath}`,
              name: relPath || e.path,
              description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
              mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
            };
          }),
        );
      }

      // Non-storage list on a specific app doesn't make sense
      return error(
        'Cannot list an app directly. Use list("yaar://apps") for all apps, ' +
          'or list("yaar://apps/{appId}/storage/") for app storage.',
      );
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      // ── App db sub-path ──
      const dbResult = await handleDbVerb('invoke', resolved, payload);
      if (dbResult) return dbResult;

      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        if (!payload?.action) return error('Payload must include "action".');

        if (payload.action === 'grep') {
          if (typeof payload.pattern !== 'string')
            return error('"pattern" (string) is required for grep.');
          const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
          const result = await storageGrep(
            prefixedPath,
            payload.pattern,
            payload.glob as string | undefined,
          );
          if (!result.success) return error(result.error!);
          return okJson({ matches: result.matches, truncated: result.truncated });
        }

        if (!storagePath.path) return error('Provide a file path under /storage/.');
        if (payload.action !== 'write') return error(`Unknown storage action "${payload.action}".`);
        if (typeof payload.content !== 'string')
          return error('"content" (string) is required for write.');

        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const content =
          payload.encoding === 'base64' ? Buffer.from(payload.content, 'base64') : payload.content;
        const result = await storageWrite(prefixedPath, content);
        if (!result.success) return error(result.error!);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return ok(`Written to yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
      }

      // ── App operations (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');
      if (!payload?.action) return error('Payload must include "action".');

      if (payload.action === 'set_badge') {
        const count = (payload.count as number) ?? 0;
        const osAction: OSAction = { type: 'app.badge', appId, count };
        actionEmitter.emitAction(osAction);
        return ok(
          count > 0 ? `Badge set to ${count} on "${appId}"` : `Badge cleared on "${appId}"`,
        );
      }

      if (payload.action === 'install') {
        const { installApp } = await import('../features/apps/install.js');
        return installApp(appId);
      }

      if (payload.action === 'clone') {
        const { cloneAppSource } = await import('../features/dev/clone.js');
        const result = await cloneAppSource(appId);
        if (!result.success) return error(result.error!);
        return okJson({ files: result.files, meta: result.meta });
      }

      return error(`Unknown action "${payload.action}".`);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App db sub-path ──
      const dbResult = await handleDbVerb('delete', resolved);
      if (dbResult) return dbResult;

      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        if (!storagePath.path) return error('Provide a file path to delete.');
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const result = await storageDelete(prefixedPath);
        if (!result.success) return error(result.error!);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return ok(`Deleted yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
      }

      // ── App uninstall (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');
      return uninstallApp(appId);
    },
  });
}
