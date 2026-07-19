/**
 * Binary-safe primitives shared by the two storage handlers.
 *
 * Both `yaar://storage/…` and `yaar://apps/{id}/storage/…` reach the same tree —
 * the second is a subdirectory of the first, distinguished only by URI spelling —
 * so anything that moves *bytes* between them belongs here rather than in either
 * handler.
 *
 * Two things live in this file:
 *
 * `decodeWriteContent` — the `encoding: 'base64'` branch of a write. The app-scoped
 * handler had it; the flat one passed `content` through as a string, so a PNG
 * written to `yaar://storage/…` landed on disk as a text file full of base64, with
 * no error at any layer. Silently corrupt output is worse than a rejected write.
 *
 * `copyStorageBytes` — the copy primitive. Without it, moving a file between the
 * two trees means reading it out as base64 and writing it back, which for an agent
 * means routing the whole payload through a model context. Copying server-side is
 * one cheap call and the bytes never leave the process.
 */

import { parseFileUri } from '@yaar/shared';
import { resolvePath, storageWrite } from '../storage/storage-manager.js';
import { validateRelativePath } from './utils.js';
import { appStoragePath, parseAppStoragePath } from './apps/paths.js';

/**
 * Map either spelling of a storage URI to its path under `STORAGE_DIR`.
 *
 * `yaar://apps/notes/storage/x.png` and `yaar://storage/apps/notes/x.png` both
 * resolve to `apps/notes/x.png`. Returns null for a URI that names something other
 * than storage, or one whose path traverses.
 */
export function storagePathForUri(uri: string): string | null {
  const appScoped = parseAppStoragePath(uri);
  if (appScoped) return appStoragePath(appScoped.appId, appScoped.path);

  const flat = parseFileUri(uri);
  if (!flat || validateRelativePath(flat.path)) return null;
  return flat.path;
}

/**
 * Decode a write payload's `content` into what should hit the disk.
 *
 * Returns an error string rather than throwing: `Buffer.from(x, 'base64')` does not
 * fail on malformed input, it silently drops the bad characters, so the only way to
 * catch a truncated or mis-encoded payload is to check that it round-trips.
 */
export function decodeWriteContent(
  payload: Record<string, unknown>,
): { content: string | Buffer } | { error: string } {
  if (typeof payload.content !== 'string') {
    return { error: '"content" (string) is required for write.' };
  }
  if (payload.encoding !== 'base64') return { content: payload.content };

  const buf = Buffer.from(payload.content, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== payload.content.replace(/=+$/, '')) {
    return { error: '"content" is not valid base64.' };
  }
  return { content: buf };
}

/**
 * Copy the bytes at `fromUri` to `destPath` (a path under `STORAGE_DIR`).
 *
 * Reads through `Bun.file().arrayBuffer()` rather than `storageRead`, which is a
 * *presentation* read — it renders PDFs to images and stringifies text — and would
 * corrupt anything it does not recognize.
 *
 * This function performs no access check. Whether the caller may read `fromUri` is
 * decided by whatever rules already bind it (the full tree, for the monitor agent;
 * the declared permission list, at `POST /api/verb`).
 */
export async function copyStorageBytes(
  fromUri: string,
  destPath: string,
): Promise<{ bytes: number } | { error: string }> {
  const sourcePath = storagePathForUri(fromUri);
  if (!sourcePath) {
    return { error: `"from" must be a storage URI naming a file: ${fromUri}` };
  }
  if (!sourcePath.length) return { error: 'Cannot copy the storage root.' };

  const resolved = resolvePath(sourcePath);
  if (!resolved) return { error: `Invalid storage path: ${sourcePath}` };

  const file = Bun.file(resolved.absolutePath);
  if (!(await file.exists())) return { error: `File not found: ${fromUri}` };

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await storageWrite(destPath, bytes);
  if (!result.success) return { error: result.error! };
  return { bytes: bytes.length };
}
