/**
 * `yaar://apps/{appId}/storage/...` — app-scoped file storage.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts` (the
 * registry has no middle wildcard). Each entry point returns `null` for a non-storage
 * URI so the composite can fall through to the app itself.
 *
 * On disk: storage/apps/{appId}/{path}
 */

import { hasLineFilter, applyReadOptions, type ReadOptions } from '../../lib/read-options.js';
import {
  ok,
  okJson,
  okMissing,
  okResource,
  okLinks,
  okWithImages,
  error,
  notFoundError,
  prependNote,
  type VerbResult,
} from '../../lib/verb-result.js';
import { mimeFromPath } from '../utils.js';
import type { ResolvedUri } from '../uri-resolve.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
  storageGrep,
} from '../../storage/storage-manager.js';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import { appStoragePath, parseAppStoragePath } from './paths.js';
import { copyStorageBytes, decodeWriteContent } from '../storage-bytes.js';
import {
  COMPRESS_ACTION,
  COPY_ACTION,
  COPY_FROM_REQUIRED,
  EXTRACT_ACTION,
  copyFrom,
} from '../storage-copy.js';
import { defineActions } from '../define-actions.js';
import { STORAGE_ACTION_DOCS } from '../storage-actions.js';
import { invokeArchiveAction } from '../storage-archive.js';
import { describeStoragePath } from '../storage-describe.js';

/**
 * List an app-storage directory as resource links.
 *
 * `read` on a bare `/storage` root and `list` on any storage path produced this
 * same block verbatim; the only thing that ever differed was the local variable
 * names.
 */
async function storageListLinks(
  appId: string,
  prefixedPath: string,
  opts?: { missingIsEmpty?: boolean },
): Promise<VerbResult> {
  const result = await storageList(prefixedPath);
  // An app's storage namespace exists from the moment the app does — the directory
  // is only created on the first write. So `list('yaar://apps/{id}/storage/')` on an
  // app that has never written anything is an empty collection, not a missing one.
  // A *named subfolder* that isn't there is genuinely missing, and says so.
  if (!result.success && result.notFound && opts?.missingIsEmpty) return okLinks([]);
  if (!result.success) return error(result.error!);
  return okLinks(
    (result.entries ?? []).map((e) => {
      const relPath = e.path.replace(`apps/${appId}/`, '');
      return {
        uri: `yaar://apps/${appId}/storage/${relPath}`,
        name: relPath || e.path,
        description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
        mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
        // Also as data, not only inside `description`: a caller auditing asset sizes
        // or picking the most recently touched entry was left parsing "1234 bytes"
        // out of prose, and had no route to the timestamp at all.
        ...(e.isDirectory ? {} : { size: e.size ?? 0 }),
        ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
      };
    }),
  );
}

/**
 * Describe a storage sub-path. Null when the URI is not one.
 *
 * The bare `…/storage` root gets the namespace manual — the verbs an app has over its
 * own files, which is what a caller landing there is actually asking. Everything under
 * it is a path on disk, and `describeStoragePath` answers for the path.
 */
export async function describeStorage(uri: string): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(uri);
  if (!storagePath) return null;

  if (!storagePath.path) {
    const listed = await storageList(appStoragePath(storagePath.appId, ''));
    return okJson({
      uri,
      kind: 'directory',
      description:
        'App-scoped file storage. An archive reads as a read-only folder. Invoke a path ' +
        'under it with one of these actions.',
      invokeActions: appStorageActions.docs,
      // A namespace root that nothing has written to yet lists as empty, not missing.
      entries: listed.entries?.length ?? 0,
      verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    });
  }

  return describeStoragePath(uri, appStoragePath(storagePath.appId, storagePath.path));
}

/** Read a storage file (or list the bare `/storage` root). Null when not a storage URI. */
export async function readStorage(
  resolved: ResolvedUri,
  options?: ReadOptions,
): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;

  const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);
  if (!storagePath.path) {
    return storageListLinks(storagePath.appId, prefixedPath, { missingIsEmpty: true });
  }
  const result = await storageRead(prefixedPath);
  if (!result.success) {
    // An archive reads as the folder it stands for. (A plain directory still answers with
    // the error below: this door never fell through to list for one, and the SDK's
    // `appStorage.read` relies on that.)
    if (result.isArchive) {
      return storageListLinks(storagePath.appId, prefixedPath).then((r) =>
        prependNote(
          r,
          'This is an archive — used list instead. Read an entry by its path under the archive.',
        ),
      );
    }
    // An app reading its own optional config declares that absence is fine by passing
    // `missingOk`; answer it with `null` rather than a failure it would only catch.
    if (result.notFound && options?.missingOk) return okMissing();
    return result.notFound ? notFoundError(result.error!) : error(result.error!);
  }
  // PDF metadata (view-first default): no pages ingested — return the summary as text.
  if (result.pdfMeta) {
    return ok(
      `${result.content}\n\nOpen it in a viewer window with renderer "iframe" and ` +
        `content "${resolved.sourceUri}" rather than reading the bytes.`,
    );
  }
  if (result.images?.length) {
    return okWithImages(result.content!, result.images);
  }
  // Unknown binary falls through to the resource block below. It must NOT go out as an
  // `image` content item: Codex turns every MCP image block into an `input_image` data URL
  // (`convert_mcp_content_to_items`), and a non-image MIME there is either rejected by the
  // API or fed to the model as garbage. `storageRead` already returns a "Binary file (…) —
  // use /api/storage/… to serve it directly" line, which is the useful answer anyway.

  // Numbered only when a filter asked for it: an unfiltered read is also the SDK's
  // `appStorage.read`, which wants the stored text back byte for byte.
  if (hasLineFilter(options)) {
    const text = applyReadOptions(result.content!, storagePath.path, options);
    return {
      ...okResource(resolved.sourceUri, text, mimeFromPath(storagePath.path)),
      readFiltered: true,
    };
  }
  return okResource(resolved.sourceUri, result.content!, mimeFromPath(storagePath.path));
}

/** List a storage directory. Null when not a storage URI. */
export async function listStorage(resolved: ResolvedUri): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;
  return storageListLinks(storagePath.appId, appStoragePath(storagePath.appId, storagePath.path), {
    missingIsEmpty: !storagePath.path,
  });
}

interface AppStorageCtx {
  appId: string;
  /** The URI invoked — what subscribers are notified on. */
  uri: string;
  /** Path relative to the app's storage root; `''` for the root itself. */
  path: string;
  /** The same path under `STORAGE_DIR` (`apps/{appId}/…`). */
  prefixedPath: string;
  payload: Record<string, unknown>;
}

/** Every action but `grep` writes a file, so needs a path to write. */
function onFile(run: (ctx: AppStorageCtx) => Promise<VerbResult>) {
  return (ctx: AppStorageCtx) =>
    ctx.path ? run(ctx) : Promise.resolve(error('Provide a file path under /storage/.'));
}

/** Notify subscribers of `uri` when `result` succeeded, and pass it through. */
function notified(uri: string, result: VerbResult): VerbResult {
  if (!result.isError) subscriptionRegistry.notifyChange(uri);
  return result;
}

/**
 * The actions on `yaar://apps/{id}/storage/…`, and the one list of them: the composite
 * `yaar://apps/*` schema enum (register.ts) and the root's `describe` prose both come off
 * this table, so neither can offer an action with no case here.
 */
export const appStorageActions = defineActions<AppStorageCtx>(
  {
    write: {
      description: STORAGE_ACTION_DOCS.write,
      run: onFile(async ({ appId, path, uri, prefixedPath, payload }) => {
        const decoded = decodeWriteContent(payload);
        if ('error' in decoded) return error(decoded.error);
        const result = await storageWrite(prefixedPath, decoded.content);
        if (!result.success) return error(result.error!);
        return notified(uri, ok(`Written to yaar://apps/${appId}/storage/${path}`));
      }),
    },
    // `copy` is how a file crosses between this app's storage and the shared tree
    // without its bytes passing through whoever asked for the move. The source is
    // authorized at the door, against this same field — handlers/storage-copy.ts.
    [COPY_ACTION]: {
      description: STORAGE_ACTION_DOCS.copy,
      run: onFile(async ({ uri, prefixedPath, payload }) => {
        const from = copyFrom(payload);
        if (from === null) return error(COPY_FROM_REQUIRED);
        const copied = await copyStorageBytes(from, prefixedPath);
        if ('error' in copied) return error(copied.error);
        return notified(uri, ok(`Copied ${from} → ${uri} (${copied.bytes} bytes)`));
      }),
    },
    grep: {
      description: STORAGE_ACTION_DOCS.grep,
      run: async ({ prefixedPath, payload }) => {
        if (typeof payload.pattern !== 'string')
          return error('"pattern" (string) is required for grep.');
        const result = await storageGrep(
          prefixedPath,
          payload.pattern,
          payload.glob as string | undefined,
        );
        if (!result.success) return error(result.error!);
        return okJson({
          matches: result.matches,
          truncated: result.truncated,
          scannedFiles: result.scannedFiles,
        });
      },
    },
    // `extract` / `compress` take copy's shape, and its gate: this URI is written, `from` is read.
    [EXTRACT_ACTION]: {
      description: STORAGE_ACTION_DOCS.extract,
      run: onFile(async ({ uri, prefixedPath, payload }) =>
        notified(uri, await invokeArchiveAction(EXTRACT_ACTION, payload, prefixedPath, uri)),
      ),
    },
    [COMPRESS_ACTION]: {
      description: STORAGE_ACTION_DOCS.compress,
      run: onFile(async ({ uri, prefixedPath, payload }) =>
        notified(uri, await invokeArchiveAction(COMPRESS_ACTION, payload, prefixedPath, uri)),
      ),
    },
  },
  {
    unknown: (action, names) =>
      error(`Unknown storage action "${action}". Supported: ${names.join(', ')}.`),
  },
);

/** Invoke an action on a storage path. Null when not a storage URI. */
export async function invokeStorage(
  resolved: ResolvedUri,
  payload?: Record<string, unknown>,
): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;

  if (!payload?.action) return error('Payload must include "action".');

  return appStorageActions.dispatch(String(payload.action), {
    appId: storagePath.appId,
    uri: resolved.sourceUri,
    path: storagePath.path,
    prefixedPath: appStoragePath(storagePath.appId, storagePath.path),
    payload,
  });
}

/**
 * Delete a storage file, a directory, or the app's whole storage namespace.
 * Null when not a storage URI.
 *
 * An empty path — `yaar://apps/{appId}/storage/` — names the namespace root, and
 * deleting it removes the app's subtree along with `storage/apps/{appId}/` itself.
 * That used to be refused ("Provide a file path to delete"), which quietly made
 * a whole class of namespace unreclaimable: devtools' throwaway `preview--{id}`
 * identities belong to no installed app, so nothing lists them and no GC sweeps
 * them, and `deleteProject`'s cleanup call — the only thing that ever tried —
 * hit this guard and swallowed the error. The permission check upstream is per
 * app-namespace and unchanged: a caller allowed to delete the root could already
 * delete every file under it one at a time, so this adds atomicity, not reach.
 */
export async function deleteStorage(resolved: ResolvedUri): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;

  const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);
  const result = await storageDelete(prefixedPath);
  if (!result.success) return error(result.error!);
  subscriptionRegistry.notifyChange(resolved.sourceUri);
  return ok(`Deleted yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
}
