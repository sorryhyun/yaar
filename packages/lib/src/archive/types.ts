/**
 * The vocabulary the zip and tar halves share: what an entry is, which limits a caller owes,
 * and the one rule that decides whether an entry name may leave the archive.
 */

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';

/** The format a file name promises, or null when it names none of the three. */
export function archiveFormatOf(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

export interface ArchiveEntry {
  /** Relative and `/`-separated, with no leading or trailing slash — see {@link safeEntryPath}. */
  path: string;
  isDirectory: boolean;
  /** Uncompressed size in bytes, as the archive declares it; 0 for a directory. */
  size: number;
  modifiedAt?: Date;
  /**
   * Why the entry is listed but cannot be read: encrypted, a compression method this reader
   * does not implement, a symlink. Absent for a readable entry.
   */
  unreadable?: string;
}

export interface ArchiveLimits {
  /** Largest single entry inflated into memory. A larger one is listed, and refused on read. */
  maxEntryBytes: number;
  /** Most entries an archive may hold before it is refused outright. */
  maxEntries: number;
  /**
   * Largest tar held in memory, measured after gunzip. Tar has no index, so reading one entry
   * means holding the whole archive — and this is also the gunzip output cap that keeps a small
   * `.tar.gz` from inflating without bound.
   */
  maxTarBytes: number;
}

export interface ArchiveReader {
  format: ArchiveFormat;
  /** Every entry whose name passed {@link safeEntryPath}. Later duplicates replace earlier ones. */
  entries: ArchiveEntry[];
  /** Entry names refused by {@link safeEntryPath}, spelled as the archive spelled them. */
  rejected: string[];
  /** One entry's bytes, verified. Throws {@link ArchiveError} for anything it will not return. */
  read(path: string): Promise<Uint8Array>;
}

/** A refusal or a malformed archive: a message meant for whoever asked, not a crash. */
export class ArchiveError extends Error {
  override name = 'ArchiveError';
}

/**
 * An entry name as a relative path that stays inside wherever the archive is unpacked, or null
 * when it would not.
 *
 * Refused rather than repaired. `Bun.Archive.extract` rewrites `../x` to `x` and `/etc/x` to
 * `etc/x`, which keeps the bytes inside the destination but files them under a name the archive
 * never used. Refusing the entry, and reporting it, is the honest version of the same safety.
 */
export function safeEntryPath(name: string): string | null {
  const unified = name.replaceAll('\\', '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.includes('\0')) return null;
  const parts: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join('/') : null;
}
