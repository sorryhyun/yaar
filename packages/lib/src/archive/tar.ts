/**
 * tar and tar.gz through `Bun.Archive`, with the bounds it does not apply itself.
 *
 * `Bun.Archive` holds a whole archive in memory and undoes gzip on its own — and keeps undoing it:
 * a `.tar.gz` gzipped again reads back as a plain tar, so a small file could expand in layers with
 * nothing capping any of them. So gzip is undone here first, by `gunzipSync` with
 * `maxOutputLength`, and what comes out must not be gzip again. What reaches `Bun.Archive` is an
 * uncompressed tar no larger than `maxTarBytes`.
 *
 * Measured on Bun 1.4.2: xz, bzip2 and zstd tars are "Unrecognized archive format"; `files()`
 * returns regular files only (no directories, no symlinks) under the names the archive spelled,
 * `../` included, which is what {@link safeEntryPath} is for; and entry timestamps are not written,
 * so a tar built here stamps every entry with the time it was built.
 */

import { gunzipSync } from 'node:zlib';
import {
  ArchiveError,
  safeEntryPath,
  type ArchiveEntry,
  type ArchiveLimits,
  type ArchiveReader,
} from './types.js';

const isGzip = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

export async function openTar(
  filePath: string,
  limits: ArchiveLimits,
): Promise<Omit<ArchiveReader, 'format'>> {
  const file = Bun.file(filePath);
  if (file.size > limits.maxTarBytes) {
    throw new ArchiveError(
      `archive is ${file.size} bytes; a tar is read whole, and only up to ${limits.maxTarBytes}`,
    );
  }
  let bytes: Uint8Array = await file.bytes();
  // Sniffed rather than trusted to the extension: `Bun.Archive` would inflate a gzipped `.tar`
  // just the same, and without the cap.
  if (isGzip(bytes)) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: limits.maxTarBytes });
    } catch (err) {
      throw new ArchiveError(
        (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
          ? `archive inflates past ${limits.maxTarBytes} bytes`
          : 'archive is not valid gzip',
      );
    }
    if (isGzip(bytes)) {
      throw new ArchiveError('archive is gzip inside gzip; unpack the outer layer first');
    }
  }

  let files: Map<string, File>;
  try {
    files = await new Bun.Archive(bytes).files();
  } catch {
    throw new ArchiveError('not a tar archive');
  }
  if (files.size > limits.maxEntries) {
    throw new ArchiveError(
      `tar holds ${files.size} entries, more than the ${limits.maxEntries} allowed`,
    );
  }

  const byPath = new Map<string, File>();
  const rejected: string[] = [];
  for (const [name, entry] of files) {
    const path = safeEntryPath(name);
    if (path === null) rejected.push(name);
    else byPath.set(path, entry);
  }
  const entries: ArchiveEntry[] = [...byPath].map(([path, entry]) => ({
    path,
    isDirectory: false,
    size: entry.size,
    modifiedAt: new Date(entry.lastModified),
  }));

  return {
    entries,
    rejected,
    async read(path: string): Promise<Uint8Array> {
      const entry = byPath.get(path);
      if (!entry) throw new ArchiveError(`no entry "${path}" in the archive`);
      if (entry.size > limits.maxEntryBytes) {
        throw new ArchiveError(
          `"${path}" is ${entry.size} bytes, more than the ${limits.maxEntryBytes} one entry may be`,
        );
      }
      return entry.bytes();
    },
  };
}

export interface TarInputFile {
  /** Entry name: relative and `/`-separated. */
  name: string;
  absolutePath: string;
}

/**
 * Build a tar (or tar.gz) of `files` in memory.
 *
 * Refused above `maxBytes` of input: `Bun.Archive` needs every entry's bytes up front, and
 * measured about 3.8× the input at peak while writing. A large archive belongs in a zip, which
 * `writeZip` streams.
 */
export async function buildTar(
  files: TarInputFile[],
  options: { gzip: boolean; maxBytes: number },
): Promise<Uint8Array> {
  const total = files.reduce((sum, f) => sum + Bun.file(f.absolutePath).size, 0);
  if (total > options.maxBytes) {
    throw new ArchiveError(
      `${total} bytes is more than a tar is built from (${options.maxBytes}): tar is built in ` +
        'memory, so use .zip, which streams',
    );
  }
  const contents: Record<string, Uint8Array> = {};
  // Bytes, not `Bun.file()` handles: a lazy file as an entry value is archived as zero bytes,
  // with no error.
  for (const f of files) contents[f.name] = await Bun.file(f.absolutePath).bytes();
  return new Bun.Archive(contents, options.gzip ? { compress: 'gzip' } : undefined).bytes();
}
