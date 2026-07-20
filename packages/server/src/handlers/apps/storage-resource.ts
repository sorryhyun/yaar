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
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
  storageGrep,
} from '../../storage/storage-manager.js';
import { subscriptionRegistry } from '../../http/subscriptions.js';
import { appStoragePath, parseAppStoragePath } from './paths.js';
import { copyStorageBytes, decodeWriteContent } from '../storage-bytes.js';

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
    description:
      'App-scoped file storage. Invoke with action "write" (add "encoding": "base64" for ' +
      'binary), "copy" (with "from": a yaar:// storage URI — moves bytes server-side), or "grep".',
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
  // Unknown binary falls through to the resource block below. It must NOT go out as an
  // `image` content item: Codex turns every MCP image block into an `input_image` data URL
  // (`convert_mcp_content_to_items`), and a non-image MIME there is either rejected by the
  // API or fed to the model as garbage. `storageRead` already returns a "Binary file (…) —
  // use /api/storage/… to serve it directly" line, which is the useful answer anyway.

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

  const prefixedPath = appStoragePath(storagePath.appId, storagePath.path);

  // `copy` is how a file crosses between this app's storage and the shared tree
  // without its bytes passing through whoever asked for the move.
  if (payload.action === 'copy') {
    if (typeof payload.from !== 'string')
      return error('"from" (a yaar:// storage URI) is required for copy.');
    const copied = await copyStorageBytes(payload.from, prefixedPath);
    if ('error' in copied) return error(copied.error);
    subscriptionRegistry.notifyChange(resolved.sourceUri);
    return ok(`Copied ${payload.from} → ${resolved.sourceUri} (${copied.bytes} bytes)`);
  }

  if (payload.action !== 'write') return error(`Unknown storage action "${payload.action}".`);

  const decoded = decodeWriteContent(payload);
  if ('error' in decoded) return error(decoded.error);
  const result = await storageWrite(prefixedPath, decoded.content);
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
