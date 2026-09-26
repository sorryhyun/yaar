/**
 * `describe` for a storage path — shared by the two doors onto the same tree.
 *
 * `yaar://storage/…` and `yaar://apps/{id}/storage/…` are two spellings of one
 * directory tree, so the only thing a describe can honestly say about either is what
 * is on disk at that path. That is exactly what this answers: whether the path exists,
 * whether it is a file or a folder, and what the verbs will do with it.
 *
 * Before this, neither door distinguished anything. `describeStorage` returned one
 * fixed blurb about the app-storage *feature* for every parseable path — file, folder,
 * or nonexistent alike — and `yaar://storage/*` had no custom describe at all, so it
 * fell through to the auto-generated pattern blob. Two URIs naming a real file and a
 * typo produced byte-identical successes.
 */

import { stat } from 'fs/promises';
import { extname } from 'path';
import { archiveFormatOf } from '@yaar/lib/archive';
import { okJson, error, type VerbResult } from '../lib/verb-result.js';
import { mimeFromPath } from './utils.js';
import { resolvePath, storageList } from '../storage/storage-manager.js';

/** Verbs a directory answers to. `read` is included because it falls through to list. */
const DIRECTORY_VERBS = ['describe', 'read', 'list', 'invoke', 'delete'] as const;
/** Verbs a file answers to. `list` is not one — a file is not a collection. */
const FILE_VERBS = ['describe', 'read', 'invoke', 'delete'] as const;
/** Verbs a folder inside an archive answers to. The archive is read-only from inside. */
const ARCHIVE_FOLDER_VERBS = ['describe', 'read', 'list'] as const;
const ARCHIVE_FILE_VERBS = ['describe', 'read'] as const;

/** Sum the direct children's sizes. Shallow on purpose — `list` is shallow too. */
function totalSizeOf(entries: Array<{ isDirectory: boolean; size?: number }>): number {
  return entries.reduce((sum, e) => sum + (e.isDirectory ? 0 : (e.size ?? 0)), 0);
}

/** Does a parent segment of this path name an archive? */
function isInsideArchiveName(path: string): boolean {
  return path
    .split('/')
    .slice(0, -1)
    .some((segment) => archiveFormatOf(segment) !== null);
}

/**
 * Describe one path under `STORAGE_DIR`.
 *
 * @param uri   The URI to echo back — whichever spelling the caller used.
 * @param path  That URI's path under `STORAGE_DIR` (`apps/notes/x.png`, `shared/a.webp`).
 */
export async function describeStoragePath(uri: string, path: string): Promise<VerbResult> {
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  const resolved = resolvePath(cleaned);
  if (!resolved) return error(`Invalid storage path in ${uri}.`);

  let info;
  try {
    info = await stat(resolved.absolutePath);
  } catch {
    // `mounts/` is virtual — it has no directory of its own, and `storageList`
    // synthesizes it from the mount table. Everything else that does not stat is
    // simply not there.
    if (cleaned === 'mounts') return describeDirectory(uri, cleaned);
    // …except a path inside an archive, which is on disk only as the archive. `storageList`
    // is what knows the archive's shape, so it answers for the path.
    if (isInsideArchiveName(cleaned)) {
      const listed = await storageList(cleaned);
      if (listed.success) {
        return okJson({
          uri,
          kind: 'directory',
          insideArchive: true,
          entries: listed.entries?.length ?? 0,
          totalSize: totalSizeOf(listed.entries ?? []),
          verbs: [...ARCHIVE_FOLDER_VERBS],
        });
      }
      if (listed.error?.includes('is a file')) {
        return okJson({
          uri,
          kind: 'file',
          insideArchive: true,
          mimeType: mimeFromPath(cleaned),
          verbs: [...ARCHIVE_FILE_VERBS],
        });
      }
    }
    return error(
      `No resource at ${uri}. Use list on the parent folder to see what is actually there.`,
    );
  }

  if (info.isDirectory()) return describeDirectory(uri, cleaned);

  const isPdf = extname(cleaned).toLowerCase() === '.pdf';
  const base = {
    uri,
    kind: 'file' as const,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    mimeType: mimeFromPath(cleaned),
    verbs: [...FILE_VERBS],
  };

  const format = archiveFormatOf(cleaned);
  if (format) {
    return okJson({
      ...base,
      kind: 'archive',
      format,
      verbs: [...DIRECTORY_VERBS],
      hint:
        `Reads as a read-only folder: list it, or read an entry as ${uri}/{entry}. To unpack ` +
        `it, invoke a new folder's URI with { action: "extract", from: "${uri}" }.`,
    });
  }

  if (!isPdf) return okJson(base);

  // A PDF is the one file type whose read has options worth naming up front: reading
  // it plain returns metadata and a "open it in a window" steer, and an agent that
  // wants the content has to know which of the two opt-ins it needs.
  const { getPdfPageCount } = await import('../features/pdf.js');
  let pages: number | undefined;
  try {
    pages = await getPdfPageCount(resolved.absolutePath);
  } catch {
    // poppler missing or the file is malformed — the rest of the answer still holds.
  }
  return okJson({
    ...base,
    ...(pages != null ? { pages } : {}),
    readOptions: {
      pdfText:
        'true for the whole text layer, or a range like "1-3". Cheapest way to read a text-based PDF.',
      pdfPages:
        'Page range to rasterize to images, e.g. "1-3" — for scanned/visual PDFs or when layout matters.',
    },
    hint:
      'Reading with neither option returns metadata only. To show the PDF to the user, open ' +
      `an iframe window with content "${uri}" — the browser renders it natively.`,
  });
}

async function describeDirectory(uri: string, cleaned: string): Promise<VerbResult> {
  const listed = await storageList(cleaned);
  if (!listed.success) return error(listed.error ?? `Could not read ${uri}.`);
  const entries = listed.entries ?? [];
  return okJson({
    uri,
    kind: 'directory',
    entries: entries.length,
    totalSize: totalSizeOf(entries),
    verbs: [...DIRECTORY_VERBS],
  });
}
