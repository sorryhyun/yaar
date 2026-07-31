/**
 * Registration for the apps domain — the one place that owns dispatch order.
 *
 * `yaar://apps/{appId}` carries two subresources (`/storage/...` and `/db/...`), and
 * `ResourceRegistry`'s wildcard syntax has no middle wildcard: it cannot match
 * a pattern with a wildcard in the middle, such as `yaar://apps/<wildcard>/storage/...`.
 * So the subresources are *not* independently registered.
 * They are an internal composite behind the single `yaar://apps/*` handler, and each
 * verb below tries them in a fixed order — db, then storage, then agents, then the app
 * itself — with each resource module returning `null` for a URI it does not own.
 *
 * If the registry ever grows middle wildcards, this composite is the thing to delete;
 * the resource modules are already shaped as independent handlers.
 */

import type { ResourceRegistry, VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { okJson } from '../utils.js';
import { parseAppDbPath } from './paths.js';
import { DB_DESCRIBE, handleDbVerb } from './db-resource.js';
import {
  describePersonas,
  readPersonas,
  listPersonas,
  invokePersonas,
  deletePersonas,
} from './agents-resource.js';
import {
  describeStorage,
  readStorage,
  listStorage,
  invokeStorage,
  deleteStorage,
} from './storage-resource.js';
import {
  appsListHandler,
  describeApplication,
  readApplication,
  listApplication,
  invokeApplication,
  deleteApplication,
} from './app-resource.js';

export function registerAppsHandlers(registry: ResourceRegistry): void {
  // ── yaar://apps — list all installed apps (exact match) ──
  registry.register('yaar://apps', appsListHandler);

  // ── yaar://apps/{appId} — per-app operations + app-scoped storage/db ──
  registry.register('yaar://apps/*', {
    description:
      'A specific app. Read for its reference doc (description + protocol + permissions), invoke to set_badge/install/publish, delete to uninstall. ' +
      'Sub-path /storage/{path} provides app-scoped file storage. ' +
      'Sub-path /db/{collection} provides app-scoped SQLite collections (Mongo-style filters + full-text search). ' +
      "Sub-path /agents[/{personaId}] provides the app's own tool-less persona agents.",
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['set_badge', 'install', 'publish', 'write', 'clone'],
          description:
            'set_badge for app badge, install from marketplace, publish to marketplace ' +
            '(refused until the signed-in publisher has accepted the Publisher Terms in ' +
            "the Market Apps publish dialog — that acceptance is the user's to give, not " +
            "an agent's), write for app storage, clone for source cloning",
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
      const storageResult = describeStorage(resolved.sourceUri);
      if (storageResult) return storageResult;

      const personaResult = describePersonas(resolved.sourceUri);
      if (personaResult) return personaResult;

      return describeApplication(resolved);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const dbResult = await handleDbVerb('read', resolved);
      if (dbResult) return dbResult;

      const storageResult = await readStorage(resolved);
      if (storageResult) return storageResult;

      const personaResult = await readPersonas(resolved);
      if (personaResult) return personaResult;

      return readApplication(resolved);
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      const dbResult = await handleDbVerb('list', resolved);
      if (dbResult) return dbResult;

      const storageResult = await listStorage(resolved);
      if (storageResult) return storageResult;

      const personaResult = await listPersonas(resolved);
      if (personaResult) return personaResult;

      return listApplication();
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const dbResult = await handleDbVerb('invoke', resolved, payload);
      if (dbResult) return dbResult;

      const storageResult = await invokeStorage(resolved, payload);
      if (storageResult) return storageResult;

      const personaResult = await invokePersonas(resolved, payload);
      if (personaResult) return personaResult;

      return invokeApplication(resolved, payload);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const dbResult = await handleDbVerb('delete', resolved);
      if (dbResult) return dbResult;

      const storageResult = await deleteStorage(resolved);
      if (storageResult) return storageResult;

      const personaResult = await deletePersonas(resolved);
      if (personaResult) return personaResult;

      return deleteApplication(resolved);
    },
  });
}
