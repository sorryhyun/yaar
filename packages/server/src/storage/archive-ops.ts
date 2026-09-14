/**
 * `extract` and `compress`: the two storage operations that unmake or make an archive.
 *
 * Both move bytes server-side for the reason `copy` does (handlers/storage-bytes.ts) — an agent
 * packing a folder must not route the folder through its context — and both are all-or-nothing:
 * an extract unpacks beside its destination and renames into place, and a zip is written through
 * `storageWriteStream`, whose partial file never takes the destination's name until it commits.
 */

import { lstat, mkdir, readdir, rename, rm, rmdir, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, dirname, join, relative, sep } from 'path';
import {
  archiveFormatOf,
  buildTar,
  openArchive,
  writeZip,
  type ArchiveFormat,
  type ZipInputFile,
} from '@yaar/lib/archive';
import { errMessage } from '@yaar/lib/errors';
import { STORAGE_DIR } from '../config.js';
import { resolvePath, storageWrite, storageWriteStream } from './storage-manager.js';
import { ARCHIVE_LIMITS } from './archive-entries.js';

/**
 * Most bytes one extract may write. The per-entry and entry-count limits bound memory; this bounds
 * the disk, which an honest zip of a few megabytes of zeros could otherwise fill.
 */
const MAX_EXTRACT_BYTES = 8 * 1024 * 1024 * 1024;

/** Already compressed: deflating these again costs CPU and saves nothing, so a zip stores them. */
const STORE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.7z', '.avif', '.br', '.bz2', '.docx', '.flac', '.gif', '.gz', '.heic', '.jpeg', '.jpg',
  '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.opus', '.parquet', '.pdf', '.png', '.pptx',
  '.rar', '.tgz', '.webm', '.webp', '.woff', '.woff2', '.xlsx', '.xz', '.zip', '.zst',
]);

const ARCHIVE_EXTENSIONS = '.zip, .tar, .tar.gz or .tgz';

/** An error message with the storage root taken out, as every storage error reads. */
function storageMessage(err: unknown): string {
  return errMessage(err).replaceAll(`${STORAGE_DIR}/`, '').replaceAll(STORAGE_DIR, '');
}

export type ExtractResult =
  | {
      success: true;
      files: number;
      bytes: number;
      /** Entries listed but not written: encrypted, an unsupported method, a symlink. */
      skipped: Array<{ path: string; reason: string }>;
      /** Entry names that would land outside the destination, as the archive spelled them. */
      rejected: string[];
    }
  | { success: false; error: string };

/** Unpack the archive at `archivePath` into `destPath`, which must not exist or be empty. */
export async function storageExtract(archivePath: string, destPath: string): Promise<ExtractResult> {
  const format = archiveFormatOf(archivePath);
  if (!format) {
    return { success: false, error: `"${archivePath}" is not a ${ARCHIVE_EXTENSIONS} archive.` };
  }
  if (!destPath.replace(/^\/+|\/+$/g, '')) {
    return { success: false, error: 'Cannot extract onto the storage root. Name a new folder.' };
  }
  const source = resolvePath(archivePath);
  const dest = resolvePath(destPath);
  if (!source || !dest) return { success: false, error: 'Invalid path: path traversal detected' };
  if (dest.readOnly) return { success: false, error: 'Mount is read-only' };

  const sourceInfo = await stat(source.absolutePath).catch(() => null);
  if (!sourceInfo?.isFile()) return { success: false, error: `Archive not found: ${archivePath}` };

  // Never merged into what is already there: an entry silently replacing an existing file is the
  // one outcome an unpack must not have.
  const existing = await lstat(dest.absolutePath).catch(() => null);
  if (existing && !(existing.isDirectory() && (await readdir(dest.absolutePath)).length === 0)) {
    return {
      success: false,
      error: `"${destPath}" already exists. Extract into a new or empty folder — extract never overwrites.`,
    };
  }

  let reader;
  try {
    reader = await openArchive(source.absolutePath, format, ARCHIVE_LIMITS);
  } catch (err) {
    return { success: false, error: `${archivePath}: ${storageMessage(err)}` };
  }

  const skipped: Array<{ path: string; reason: string }> = [];
  const writable = reader.entries.filter((entry) => {
    if (entry.unreadable) skipped.push({ path: entry.path, reason: entry.unreadable });
    return !entry.unreadable;
  });
  const declared = writable.reduce((sum, entry) => sum + entry.size, 0);
  if (declared > MAX_EXTRACT_BYTES) {
    return {
      success: false,
      error: `${archivePath} unpacks to ${declared} bytes, more than the ${MAX_EXTRACT_BYTES} one extract may write.`,
    };
  }

  const staging = `${dest.absolutePath}.extract-${randomUUID().slice(0, 8)}`;
  let files = 0;
  let bytes = 0;
  try {
    await mkdir(staging, { recursive: true });
    for (const entry of writable) {
      // `entry.path` passed `safeEntryPath`: relative, no `..`, so this join stays in `staging`.
      const target = join(staging, entry.path);
      if (entry.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const data = await reader.read(entry.path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, data);
      files += 1;
      bytes += data.length;
    }
    if (existing) await rmdir(dest.absolutePath);
    await rename(staging, dest.absolutePath);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    return {
      success: false,
      error: `${archivePath}: ${storageMessage(err).replaceAll(staging, dest.absolutePath)}`,
    };
  }
  return { success: true, files, bytes, skipped, rejected: reader.rejected };
}

export type CompressResult =
  | { success: true; format: ArchiveFormat; files: number; bytes: number }
  | { success: false; error: string };

/**
 * Pack `sourcePaths` — files or folders — into the archive `destPath` names.
 *
 * The destination's extension picks the format. A folder lands under its own name, a file under
 * its name, and two sources that would put the same name in the archive are refused rather than
 * one silently shadowing the other. Symlinks are skipped, never followed.
 */
export async function storageCompress(
  sourcePaths: string[],
  destPath: string,
): Promise<CompressResult> {
  const format = archiveFormatOf(destPath);
  if (!format) {
    return {
      success: false,
      error: `Name the archive with a ${ARCHIVE_EXTENSIONS} extension — the extension picks the format.`,
    };
  }
  const dest = resolvePath(destPath);
  if (!dest) return { success: false, error: 'Invalid path: path traversal detected' };
  if (dest.readOnly) return { success: false, error: 'Mount is read-only' };

  const inputs: ZipInputFile[] = [];
  const names = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const source = resolvePath(sourcePath);
    if (!source) return { success: false, error: 'Invalid path: path traversal detected' };
    const info = await lstat(source.absolutePath).catch(() => null);
    if (!info) return { success: false, error: `Not found: ${sourcePath}` };

    const base = basename(sourcePath.replace(/\/+$/, ''));
    let collected: ZipInputFile[];
    try {
      collected = info.isDirectory()
        ? await collectFiles(source.absolutePath, base)
        : info.isFile()
          ? [{ name: base, absolutePath: source.absolutePath, modifiedAt: info.mtime }]
          : [];
    } catch (err) {
      return { success: false, error: storageMessage(err) };
    }

    for (const input of collected) {
      // The archive being written, when it sits inside a source — including its partial file.
      if (
        input.absolutePath === dest.absolutePath ||
        input.absolutePath.startsWith(`${dest.absolutePath}.part-`)
      ) {
        continue;
      }
      if (names.has(input.name)) {
        return {
          success: false,
          error: `Two sources both put "${input.name}" in the archive. Compress them separately, or rename one.`,
        };
      }
      names.add(input.name);
      inputs.push(input);
    }
    if (inputs.length > ARCHIVE_LIMITS.maxEntries) {
      return {
        success: false,
        error: `More than ${ARCHIVE_LIMITS.maxEntries} files to compress; split them across archives.`,
      };
    }
  }
  if (inputs.length === 0) {
    return { success: false, error: 'Nothing to compress: the sources hold no files.' };
  }

  if (format === 'zip') {
    const opened = await storageWriteStream(destPath);
    if (!opened.success) return { success: false, error: opened.error };
    try {
      const written = await writeZip(inputs, (chunk) => opened.stream.write(chunk), {
        storeExtensions: STORE_EXTENSIONS,
      });
      const committed = await opened.stream.commit();
      if (!committed.success) return { success: false, error: committed.error ?? 'Commit failed.' };
      return { success: true, format, files: written.entries, bytes: committed.bytes };
    } catch (err) {
      await opened.stream.abort();
      return { success: false, error: storageMessage(err) };
    }
  }

  try {
    const archive = await buildTar(inputs, {
      gzip: format === 'tar.gz',
      maxBytes: ARCHIVE_LIMITS.maxTarBytes,
    });
    const written = await storageWrite(
      destPath,
      Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength),
    );
    if (!written.success) return { success: false, error: written.error ?? 'Write failed.' };
    return { success: true, format, files: inputs.length, bytes: archive.byteLength };
  } catch (err) {
    return { success: false, error: storageMessage(err) };
  }
}

/** Every regular file under `root`, named `{prefix}/{relative path}`, in a stable order. */
async function collectFiles(root: string, prefix: string): Promise<ZipInputFile[]> {
  const files: ZipInputFile[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name);
      const info = await lstat(full);
      // Skipped, not followed: following a symlink packs whatever it points at, in storage or not.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(full);
      } else if (info.isFile()) {
        const rel = relative(root, full).split(sep).join('/');
        files.push({
          name: prefix ? `${prefix}/${rel}` : rel,
          absolutePath: full,
          modifiedAt: info.mtime,
        });
        if (files.length > ARCHIVE_LIMITS.maxEntries) return;
      }
    }
  };
  await visit(root);
  return files;
}
