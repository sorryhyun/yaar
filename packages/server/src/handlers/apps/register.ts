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

import type { ReadOptions, ResourceRegistry, VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { okJson, error } from '../utils.js';
import { parseAppDbPath } from './paths.js';
import { COPY_ACTION, COPY_FROM_SCHEMA } from '../storage-copy.js';
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
  describeAppProtocol,
  readAppProtocol,
  listAppProtocol,
  rejectProtocolMutation,
} from './protocol-resource.js';
import { describeAppDocs, readAppDocs, listAppDocs, rejectDocsMutation } from './docs-resource.js';
import {
  appActions,
  appsListHandler,
  describeApplication,
  readApplication,
  listApplication,
  invokeApplication,
  deleteApplication,
} from './app-resource.js';

/**
 * Sub-paths that are *not* addressable under `yaar://apps/{id}` — protocol state and
 * commands belong to a running window, not to the installed app.
 *
 * `yaar://apps/{id}` is the **installed** app; `yaar://windows/{id}` is the **running**
 * instance. State has no value and a command has nothing to act on until an app is
 * open, and the same app open on two monitors is two states — so an `apps/` spelling
 * would either name one of them arbitrarily or name none.
 *
 * Narrow on purpose. The blanket "no sub-paths under apps/" would delete `appStorage`
 * and `appDb`, both of which are built entirely on reads and lists under
 * `yaar://apps/self/{storage,db}/`.
 */
const INSTANCE_SUBPATHS = ['state', 'commands'] as const;

/** The refusal for `yaar://apps/{id}/state/…` and `/commands/…`, on every verb. */
function rejectInstanceSubPath(uri: string): VerbResult | null {
  const match = uri.match(/^yaar:\/\/apps\/[^/]+\/([^/]+)(?:\/|$)/);
  const segment = match?.[1];
  if (!segment || !(INSTANCE_SUBPATHS as readonly string[]).includes(segment)) return null;
  return error(
    `"${uri}" is not addressable. An app's protocol ${segment} belong to a running window, ` +
      'not to the installed app — use yaar://windows/{windowId}/' +
      `${segment}/{key} instead. Find the window with list("yaar://windows").` +
      ` For the *documentation* of a ${segment} key, which does belong to the installed app, ` +
      `read the compiled protocol: yaar://apps/{appId}/protocol/${segment}/{key}.`,
  );
}

/** Every sub-path under `yaar://apps/{id}` that some resource module owns. */
const KNOWN_SUBPATHS = ['storage', 'db', 'agents', 'protocol', 'docs'] as const;

/**
 * The refusal for any sub-path that reached the terminal — `yaar://apps/notes/hamsters`.
 *
 * The composite's terminal case is the app itself, and the app handlers take their id with
 * `extractIdFromUri`, which matches the *first* segment and ignores everything after it. So
 * before this existed, every unclaimed sub-path silently answered as the bare app:
 * `read('yaar://apps/notes/protocol')` cheerfully returned the app's effective manifest,
 * and a caller had no way to tell a real answer from a typo that had been rounded off to
 * one. A false success is worse than a 404 precisely because nothing looks wrong.
 *
 * Runs *last*, so it only ever sees a URI every owning module declined — including a URI
 * whose segment *is* known but whose tail is malformed (a traversing storage path), which
 * is equally not the bare app. `rejectInstanceSubPath` runs first and has a better
 * sentence for the two segments it knows about.
 *
 * A launch parameter is not a sub-path: `yaar://apps/memo?file=yaar://storage/x` names the
 * app itself, so the query and fragment come off before the split.
 */
function rejectUnhandledSubPath(uri: string): VerbResult | null {
  const match = uri.split(/[?#]/)[0].match(/^yaar:\/\/apps\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, appId, rest] = match;
  return error(
    `"${uri}" is not addressable. An app's sub-paths are ` +
      `${KNOWN_SUBPATHS.map((s) => `${s}/`).join(', ')} — "${rest}" is neither one of those ` +
      `nor a valid path under one. describe("yaar://apps/${appId}") lists what this app ` +
      'answers to.',
  );
}

export function registerAppsHandlers(registry: ResourceRegistry): void {
  // ── yaar://apps — list all installed apps (exact match) ──
  registry.register('yaar://apps', appsListHandler);

  // ── yaar://apps/{appId} — per-app operations + app-scoped storage/db ──
  registry.register('yaar://apps/*', {
    description:
      'A specific app — the *installed* app, not a running one. Describe for its manual ' +
      '(SKILL.md, permissions, and the names of its state keys and commands), read for its ' +
      `effective manifest, invoke to ${appActions.names.join('/')}, delete to uninstall. ` +
      'Sub-path /protocol is the compiled protocol: list it for an index of command ' +
      'signatures, read it for the manifest in full, read /protocol/commands/{name} for one ' +
      'command self-contained. ' +
      'Sub-path /docs is the app’s topic docs: list it for an index of topics and their ' +
      'triggers, read /docs/{name} for one topic. ' +
      'Sub-path /storage/{path} provides app-scoped file storage. ' +
      'Sub-path /db/{collection} provides app-scoped SQLite collections (Mongo-style filters + full-text search). ' +
      "Sub-path /agents[/{personaId}] provides the app's own tool-less persona agents. " +
      'Protocol state and commands are NOT under apps/ — they belong to a running window ' +
      '(yaar://windows/{windowId}/{state,commands}/{key}).',
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        // The app-level actions are derived from the table that dispatches them
        // (`appActions`); the storage sub-path's own actions are appended because this
        // one registration is the composite door onto both — the registry has no middle
        // wildcard, so `yaar://apps/{id}/storage/…` cannot register its own schema.
        action: {
          type: 'string',
          enum: [...appActions.names, 'write', COPY_ACTION, 'grep'],
          description:
            `On the app itself: ${appActions.names.join(', ')}. ` +
            'On a /storage/ sub-path: write, copy, grep. On a /db/ sub-path see ' +
            'describe(yaar://apps/{id}/db/{collection}).',
        },
        count: { type: 'number', description: 'Badge count (0 to clear, for set_badge)' },
        content: { type: 'string', description: 'File content (for storage write)' },
        // The action enum has always advertised `copy` here and never said what to
        // copy *from* — the first casualty of the copy shape living in four files.
        from: COPY_FROM_SCHEMA,
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Content encoding (default: utf-8)',
        },
      },
    },

    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      const rejected = rejectInstanceSubPath(resolved.sourceUri);
      if (rejected) return rejected;

      // Db sub-paths get the db API describe
      if (parseAppDbPath(resolved.sourceUri)) {
        return okJson({ uri: resolved.sourceUri, ...DB_DESCRIBE });
      }

      // Storage sub-paths describe the path on disk
      const storageResult = await describeStorage(resolved.sourceUri);
      if (storageResult) return storageResult;

      const personaResult = describePersonas(resolved.sourceUri);
      if (personaResult) return personaResult;

      const protocolResult = await describeAppProtocol(resolved.sourceUri);
      if (protocolResult) return protocolResult;

      const docsResult = await describeAppDocs(resolved.sourceUri);
      if (docsResult) return docsResult;

      return rejectUnhandledSubPath(resolved.sourceUri) ?? describeApplication(resolved);
    },

    async read(resolved: ResolvedUri, options?: ReadOptions): Promise<VerbResult> {
      const rejected = rejectInstanceSubPath(resolved.sourceUri);
      if (rejected) return rejected;

      const dbResult = await handleDbVerb('read', resolved);
      if (dbResult) return dbResult;

      const storageResult = await readStorage(resolved, options);
      if (storageResult) return storageResult;

      const personaResult = await readPersonas(resolved);
      if (personaResult) return personaResult;

      const protocolResult = await readAppProtocol(resolved.sourceUri);
      if (protocolResult) return protocolResult;

      const docsResult = await readAppDocs(resolved.sourceUri);
      if (docsResult) return docsResult;

      return rejectUnhandledSubPath(resolved.sourceUri) ?? readApplication(resolved);
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      const rejected = rejectInstanceSubPath(resolved.sourceUri);
      if (rejected) return rejected;

      const dbResult = await handleDbVerb('list', resolved);
      if (dbResult) return dbResult;

      const storageResult = await listStorage(resolved);
      if (storageResult) return storageResult;

      const personaResult = await listPersonas(resolved);
      if (personaResult) return personaResult;

      const protocolResult = await listAppProtocol(resolved.sourceUri);
      if (protocolResult) return protocolResult;

      const docsResult = await listAppDocs(resolved.sourceUri);
      if (docsResult) return docsResult;

      return rejectUnhandledSubPath(resolved.sourceUri) ?? listApplication();
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const rejected = rejectInstanceSubPath(resolved.sourceUri);
      if (rejected) return rejected;

      const dbResult = await handleDbVerb('invoke', resolved, payload);
      if (dbResult) return dbResult;

      const storageResult = await invokeStorage(resolved, payload);
      if (storageResult) return storageResult;

      const personaResult = await invokePersonas(resolved, payload);
      if (personaResult) return personaResult;

      const protocolResult = rejectProtocolMutation(resolved.sourceUri, 'invoke');
      if (protocolResult) return protocolResult;

      const docsResult = rejectDocsMutation(resolved.sourceUri, 'invoke');
      if (docsResult) return docsResult;

      return rejectUnhandledSubPath(resolved.sourceUri) ?? invokeApplication(resolved, payload);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const rejected = rejectInstanceSubPath(resolved.sourceUri);
      if (rejected) return rejected;

      const dbResult = await handleDbVerb('delete', resolved);
      if (dbResult) return dbResult;

      const storageResult = await deleteStorage(resolved);
      if (storageResult) return storageResult;

      const personaResult = await deletePersonas(resolved);
      if (personaResult) return personaResult;

      const protocolResult = rejectProtocolMutation(resolved.sourceUri, 'delete');
      if (protocolResult) return protocolResult;

      const docsResult = rejectDocsMutation(resolved.sourceUri, 'delete');
      if (docsResult) return docsResult;

      return rejectUnhandledSubPath(resolved.sourceUri) ?? deleteApplication(resolved);
    },
  });
}
