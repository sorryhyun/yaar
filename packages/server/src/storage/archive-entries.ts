/**
 * Paths that reach *into* an archive — `files/data.zip/docs/readme.md`.
 *
 * `storageRead` and `storageList` call in here when a path does not exist on disk as named, so an
 * archive behaves as a read-only folder through every door that already speaks storage: both verb
 * handlers and the app agent's `storage:*` built-ins, none of which had to learn a new shape. An
 * archive's root answers `read` the way a directory does (`isDirectory`), which is the recovery
 * each of those doors already takes.
 *
 * A leaf on purpose. Suites stub `storage-manager.ts` by hand (see text-extensions.ts), so this
 * module takes the path resolver as a parameter instead of importing it.
 */

import { stat } from 'fs/promises';
import { archiveFormatOf, type ArchiveFormat, type ArchiveReader } from '@yaar/lib/archive';
import type { ResolvedPath } from './mounts.js';
import type { StorageEntry } from './types.js';

const MiB = 1024 * 1024;

/** What every archive storage opens is held to — see `ArchiveLimits` for what each field bounds. */
export const ARCHIVE_LIMITS = {
  maxEntryBytes: 512 * MiB,
  maxEntries: 100_000,
  maxTarBytes: 512 * MiB,
};

/**
 * Largest entry a `read` takes out of an archive. A read's consumer is a model context or an
 * iframe; an entry bigger than this is there to be extracted, not read.
 */
export const MAX_ARCHIVE_READ_BYTES = 16 * MiB;

export interface ArchiveLocation {
  /** Storage path of the archive file itself. */
  archivePath: string;
  absolutePath: string;
  format: ArchiveFormat;
  /** The archive file's mtime — what a folder inside it, which has none of its own, reports. */
  modifiedAt: string;
  /** Path inside the archive; '' for its root. */
  innerPath: string;
}

/**
 * The archive a storage path is, or is inside — null when it is neither.
 *
 * Free for an ordinary path: the disk is consulted only for a segment whose name ends in an
 * archive extension, and a directory that happens to be named `x.zip` is walked past.
 */
export async function locateArchive(
  path: string,
  resolve: (p: string) => ResolvedPath | null,
): Promise<ArchiveLocation | null> {
  const segments = path.split('/').filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    const format = archiveFormatOf(segments[i - 1]);
    if (!format) continue;
    const archivePath = segments.slice(0, i).join('/');
    const resolved = resolve(archivePath);
    if (!resolved) return null;
    const info = await stat(resolved.absolutePath).catch(() => null);
    if (!info) return null;
    if (!info.isFile()) continue;
    return {
      archivePath,
      absolutePath: resolved.absolutePath,
      format,
      modifiedAt: info.mtime.toISOString(),
      innerPath: segments.slice(i).join('/'),
    };
  }
  return null;
}

/**
 * The children of one folder inside an archive, as storage entries spelled under the archive's
 * own path (`data.zip/docs/readme.md`). Null when `innerPath` is not a folder in it.
 *
 * Shallow, like `storageList`. A folder is implied by the paths beneath it as well as by an
 * explicit directory entry — a tar read through `Bun.Archive` has no directory entries at all.
 */
export function archiveChildren(
  reader: ArchiveReader,
  location: ArchiveLocation,
): StorageEntry[] | null {
  const inner = location.innerPath;
  const prefix = inner ? `${inner}/` : '';
  const children = new Map<string, StorageEntry>();
  let found = inner === '';
  for (const entry of reader.entries) {
    if (entry.path === inner) {
      if (!entry.isDirectory) return null;
      found = true;
      continue;
    }
    if (!entry.path.startsWith(prefix)) continue;
    found = true;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const isDirectory = slash !== -1 || entry.isDirectory;
    // A name that is both a file and a folder is a malformed archive; show the folder, the one
    // with something beneath it.
    if (children.get(name)?.isDirectory) continue;
    const modified = entry.modifiedAt?.getTime();
    children.set(name, {
      path: `${location.archivePath}/${prefix}${name}`,
      isDirectory,
      size: isDirectory ? 0 : entry.size,
      modifiedAt:
        !isDirectory && modified !== undefined && !Number.isNaN(modified)
          ? new Date(modified).toISOString()
          : location.modifiedAt,
    });
  }
  if (!found) return null;
  return [...children.values()].sort((a, b) =>
    a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.path.localeCompare(b.path),
  );
}
