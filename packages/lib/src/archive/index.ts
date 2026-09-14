/**
 * zip, tar and tar.gz: list, read one entry, and build — with every limit the caller's.
 *
 * zip is hand-written against `node:zlib` (see zip-read.ts for why); tar goes through
 * `Bun.Archive` with the bounds it lacks (tar.ts). Nothing here writes an archive's entries to
 * disk: a caller unpacking one reads entries and places them itself, so where they land, and
 * what happens to a name that would climb out, is decided in one visible place.
 */

import { openTar } from './tar.js';
import { openZip } from './zip-read.js';
import type { ArchiveFormat, ArchiveLimits, ArchiveReader } from './types.js';

export {
  archiveFormatOf,
  safeEntryPath,
  ArchiveError,
  type ArchiveEntry,
  type ArchiveFormat,
  type ArchiveLimits,
  type ArchiveReader,
} from './types.js';
export { writeZip, type ByteSink, type ZipInputFile, type ZipWriteOptions } from './zip-write.js';
export { buildTar, type TarInputFile } from './tar.js';

/**
 * Open an archive file for listing and reading.
 *
 * `format` picks zip or tar. A tar whose bytes are gzip is read as tar.gz whichever of the two
 * tar formats is named, since the extension is only a promise.
 */
export async function openArchive(
  filePath: string,
  format: ArchiveFormat,
  limits: ArchiveLimits,
): Promise<ArchiveReader> {
  const reader =
    format === 'zip' ? await openZip(filePath, limits) : await openTar(filePath, limits);
  return { format, ...reader };
}
