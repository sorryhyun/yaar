/**
 * `yaar://apps/{appId}/storage/...` — app-scoped file storage.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts` (the
 * registry has no middle wildcard). Each entry point returns `null` for a non-storage
 * URI so the composite can fall through to the app itself.
 *
 * On disk: storage/apps/{appId}/{path}
 */

import type { VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { ok, okJson, okResource, okLinks, okWithImages, error, mimeFromPath } from '../utils.js';
import {
  resolvePath,
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
  storageGrep,
} from '../../storage/storage-manager.js';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import { appStoragePath, parseAppStoragePath } from './paths.js';

/**
 * List an app-storage directory as resource links.
 *
 * `read` on a bare `/storage` root and `list` on any storage path produced this
 * same block verbatim; the only thing that ever differed was the local variable
 * names.
 */
async function storageListLinks(appId: string, prefixedPath: string): Promise<VerbResult> {
  const result = await storageList(prefixedPath);
  if (!result.success) return error(result.error!);
  return okLinks(
    (result.entries ?? []).map((e) => {
      const relPath = e.path.replace(`apps/${appId}/`, '');
      return {
        uri: `yaar://apps/${appId}/storage/${relPath}`,
        name: relPath || e.path,
        description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
        mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
      };
    }),
  );
}

/** Generic describe for any storage sub-path. Null when the URI is not one. */
export function describeStorage(uri: string): VerbResult | null {
  if (!parseAppStoragePath(uri)) return null;
  return okJson({
    uri,
    description: 'App-scoped file storage.',
    verbs: ['read', 'list', 'invoke', 'delete'],
  });
}

/** Read a storage file (or list the bare `/storage` root). Null when not a storage URI. */
export async function readStorage(resolved: ResolvedUri): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;

  const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);
  if (!storagePath.path) {
    // Bare storage root → redirect to list
    return storageListLinks(storagePath.appId, prefixedPath);
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

/** List a storage directory. Null when not a storage URI. */
export async function listStorage(resolved: ResolvedUri): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;
  return storageListLinks(storagePath.appId, appStoragePath(storagePath.appId, storagePath.path));
}

/** Write / grep a storage path. Null when not a storage URI. */
export async function invokeStorage(
  resolved: ResolvedUri,
  payload?: Record<string, unknown>,
): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;

  if (!payload?.action) return error('Payload must include "action".');

  if (payload.action === 'grep') {
    if (typeof payload.pattern !== 'string')
      return error('"pattern" (string) is required for grep.');
    const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);
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

  const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);
  const content =
    payload.encoding === 'base64' ? Buffer.from(payload.content, 'base64') : payload.content;
  const result = await storageWrite(prefixedPath, content);
  if (!result.success) return error(result.error!);
  subscriptionRegistry.notifyChange(resolved.sourceUri);
  return ok(`Written to yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
}

/** Delete a storage file. Null when not a storage URI. */
export async function deleteStorage(resolved: ResolvedUri): Promise<VerbResult | null> {
  const storagePath = parseAppStoragePath(resolved.sourceUri);
  if (!storagePath) return null;

  if (!storagePath.path) return error('Provide a file path to delete.');
  const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);
  const result = await storageDelete(prefixedPath);
  if (!result.success) return error(result.error!);
  subscriptionRegistry.notifyChange(resolved.sourceUri);
  return ok(`Deleted yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
}
