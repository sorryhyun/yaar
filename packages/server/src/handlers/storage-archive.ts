/**
 * `extract` and `compress` as verb results, shared by both doors onto the storage tree.
 *
 * Both take `copy`'s shape: the target URI is what gets written (the folder to unpack into, the
 * archive to create) and `from` is what gets read. So the gate `POST /api/verb` runs on a copy's
 * source covers these through the same extraction (storage-copy.ts), and this module, like the
 * handlers that call it, authorizes nothing itself.
 */

import type { VerbResult } from './uri-registry.js';
import { error, okJson } from './utils.js';
import { storagePathForUri } from './storage-bytes.js';
import {
  COMPRESS_ACTION,
  EXTRACT_ACTION,
  payloadSources,
  sourcesRequired,
} from './storage-copy.js';
import { storageCompress, storageExtract } from '../storage/archive-ops.js';

/**
 * Run an `extract` or `compress` payload against `targetPath` (a path under `STORAGE_DIR`).
 * Null when the payload names neither action, so the caller's own dispatch carries on.
 */
export async function invokeArchiveAction(
  payload: Record<string, unknown>,
  targetPath: string,
  targetUri: string,
): Promise<VerbResult | null> {
  const action = payload.action;
  if (action !== EXTRACT_ACTION && action !== COMPRESS_ACTION) return null;

  const sources = payloadSources(payload);
  if (sources === null) return error(sourcesRequired(action));
  const sourcePaths: string[] = [];
  for (const uri of sources) {
    const path = storagePathForUri(uri);
    if (path === null) return error(`"from" must be a yaar:// storage URI: ${uri}`);
    sourcePaths.push(path);
  }

  if (action === EXTRACT_ACTION) {
    const result = await storageExtract(sourcePaths[0], targetPath);
    if (!result.success) return error(result.error);
    return okJson({
      extracted: sources[0],
      to: targetUri,
      files: result.files,
      bytes: result.bytes,
      ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
      ...(result.rejected.length > 0
        ? {
            rejected: result.rejected,
            rejectedReason:
              'these entry names climb out of the archive (a ".." or an absolute path) and were not written',
          }
        : {}),
    });
  }

  const result = await storageCompress(sourcePaths, targetPath);
  if (!result.success) return error(result.error);
  return okJson({
    compressed: sources,
    to: targetUri,
    format: result.format,
    files: result.files,
    bytes: result.bytes,
  });
}
