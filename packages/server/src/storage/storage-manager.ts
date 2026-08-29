/**
 * Storage manager for persistent file storage.
 *
 * Provides CRUD operations for the storage/ directory with path validation.
 */

import { mkdir, readdir, unlink, rename, rm, stat, realpath } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, normalize, relative, dirname, extname } from 'path';
import { pdfToImages, pdfToText, getPdfPageCount } from '../lib/pdf/index.js';
import { toWebPForModel } from '../lib/image.js';
import {
  STORAGE_DIR,
  getConfigDir,
} from '../config.js';
export { getConfigDir };
import type {
  StorageEntry,
  StorageReadResult,
  StorageWriteResult,
  StorageListResult,
  StorageDeleteResult,
  StorageGrepMatch,
  StorageGrepResult,
  StorageImageContent,
} from './types.js';
import { resolveMountPath, loadMounts, type ResolvedPath } from './mounts.js';
// A leaf, shared with window content inlining — see text-extensions.ts for why not here.
import { isTextFile } from './text-extensions.js';

/**
 * Resolve a storage-relative path to an absolute path, checking mounts first.
 * Returns null if the path escapes the storage directory.
 */
export function resolvePath(filePath: string): ResolvedPath | null {
  const cleanedPath = normalizeSeparators(filePath);
  return resolveMountPath(cleanedPath) ?? resolveInStorageDir(cleanedPath);
}

/**
 * Async variant of resolvePath that resolves symlinks before containment check.
 */
export async function resolvePathAsync(filePath: string): Promise<ResolvedPath | null> {
  const cleanedPath = normalizeSeparators(filePath);
  const mountResult = resolveMountPath(cleanedPath);
  if (mountResult) return mountResult;

  const resolved = resolveInStorageDir(cleanedPath);
  if (!resolved) return null;
  const normalizedPath = resolved.absolutePath;

  try {
    const realPath = await realpath(normalizedPath);
    const realBase = await realpath(STORAGE_DIR);
    const realRel = relative(realBase, realPath);
    if (realRel.startsWith('..') || realRel.includes('..')) {
      return null;
    }
    return { absolutePath: realPath, readOnly: false };
  } catch {
    // File doesn't exist yet — fall back to sync check
    return { absolutePath: normalizedPath, readOnly: false };
  }
}

/** Backslashes from Windows paths / URL-decoded %5C. */
function normalizeSeparators(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/** The non-mount default: under STORAGE_DIR, and null when the path climbs out of it. */
function resolveInStorageDir(cleanedPath: string): ResolvedPath | null {
  const normalizedPath = normalize(join(STORAGE_DIR, cleanedPath));
  const relativePath = relative(STORAGE_DIR, normalizedPath);
  if (relativePath.startsWith('..') || relativePath.includes('..')) {
    return null;
  }
  return { absolutePath: normalizedPath, readOnly: false };
}

/**
 * Ensure the storage directory exists.
 */
export async function ensureStorageDir(): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
}

/**
 * Check if a file is a PDF based on extension.
 */
function isPdfFile(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.pdf';
}

/** Image extensions → MIME types for base64 image content blocks */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function imageFileMime(filePath: string): string | null {
  return IMAGE_MIME[extname(filePath).toLowerCase()] ?? null;
}

/** Cap on how many pages a single rasterize request may return, to bound token cost. */
const MAX_PDF_RASTER_PAGES = 20;

/**
 * Parse a 1-based inclusive page range like "1-3", "5", or "2-". Clamped to [1, totalPages].
 * `maxPages` caps the span (images are expensive; text is cheap so callers pass Infinity).
 */
function parsePdfPageRange(
  spec: string,
  totalPages: number,
  maxPages: number = MAX_PDF_RASTER_PAGES,
): { firstPage: number; lastPage: number } {
  const m = spec.trim().match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
  const first = m?.[1] ? parseInt(m[1], 10) : 1;
  const openEnded = m?.[2] === '-' && !m?.[3];
  const last = m?.[3] ? parseInt(m[3], 10) : openEnded ? totalPages : first;
  const firstPage = Math.max(1, Math.min(first, totalPages || first));
  const lastPage = Math.max(
    firstPage,
    Math.min(last, totalPages || last, firstPage + maxPages - 1),
  );
  return { firstPage, lastPage };
}

/**
 * Rasterize a PDF page range to PNG images (via poppler) for when the agent must actually
 * read the document's content. Callers only reach here on an explicit `pages` opt-in.
 */
async function convertPdfToImages(
  filePath: string,
  pages: string,
  raw?: boolean,
): Promise<{ images: StorageImageContent[]; totalPages: number; firstPage: number; lastPage: number }> {
  const totalPages = await getPdfPageCount(filePath);
  const { firstPage, lastPage } = parsePdfPageRange(pages, totalPages);
  const pdfPages = await pdfToImages(filePath, 1.5, { firstPage, lastPage }, { raw });

  const images = pdfPages.map((page) => ({
    type: 'image' as const,
    data: page.data.toString('base64'),
    mimeType: page.mimeType,
    pageNumber: page.pageNumber,
  }));

  return { images, totalPages, firstPage, lastPage };
}

/** Extract a PDF's text layer. Returns the text plus whether any was found. */
async function extractPdfText(
  filePath: string,
  spec: boolean | string,
): Promise<{ text: string; totalPages: number; firstPage: number; lastPage: number }> {
  const totalPages = await getPdfPageCount(filePath);
  const wantsRange = typeof spec === 'string' && spec.trim() !== '' && spec.trim() !== 'all';
  // `true` (or "all"/"") means the whole document; a range string scopes it. When the page
  // count is unknown (0), extract the whole document rather than passing a bogus 1..0 range.
  const range =
    wantsRange && totalPages > 0
      ? parsePdfPageRange(spec as string, totalPages, Infinity)
      : totalPages > 0
        ? { firstPage: 1, lastPage: totalPages }
        : undefined;
  const text = await pdfToText(filePath, range);
  return { text, totalPages, firstPage: range?.firstPage ?? 1, lastPage: range?.lastPage ?? totalPages };
}

/** Options controlling how {@link storageRead} handles special file types. */
export interface StorageReadOptions {
  /**
   * Extract a PDF's text layer instead of just metadata. `true` (or "all") reads the whole
   * document; a range string like "1-3" scopes it. Cheapest way to read a text-based PDF.
   */
  pdfText?: boolean | string;
  /** PDF page range to rasterize to images (e.g. "1-3"), for visual/scanned PDFs. */
  pdfPages?: string;
  /**
   * Return image bytes exactly as they are on disk (and PDF pages as poppler's PNG),
   * skipping the WebP re-encode this read normally applies.
   *
   * The re-encode is lossy and sized for a vision model. Ask for `rawImage` when the
   * pixels themselves are the point — a fidelity comparison, or a caller that is going
   * to write the bytes back out somewhere.
   */
  rawImage?: boolean;
}

/**
 * Read a file from storage.
 */
export async function storageRead(
  filePath: string,
  opts?: StorageReadOptions,
): Promise<StorageReadResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, error: 'Invalid path: path traversal detected. Storage tools only access files under storage/. Use relative paths without "..".' };
  }
  const validatedPath = resolved.absolutePath;

  try {
    // Check existence and type before extension-based dispatch
    let fileStat;
    try {
      fileStat = await stat(validatedPath);
    } catch {
      return { success: false, notFound: true, error: `File not found: ${filePath}` };
    }
    if (fileStat.isDirectory()) {
      return {
        success: false,
        isDirectory: true,
        error: `"${filePath}" is a directory. Use list instead.`,
      };
    }

    // PDFs. View-first: by default return metadata only and let the caller steer the agent
    // to open the file in a viewer window (native, zero bytes ingested). Rasterizing pages to
    // images is an explicit opt-in via `pdfPages`, for when the agent must read the content.
    if (isPdfFile(validatedPath)) {
      // Text layer — cheapest way to read a text-based PDF (all pages, real characters).
      if (opts?.pdfText) {
        const { text, totalPages, firstPage, lastPage } = await extractPdfText(
          validatedPath,
          opts.pdfText,
        );
        if (text.trim()) {
          return {
            success: true,
            content: `PDF text, pages ${firstPage}-${lastPage} of ${totalPages}:\n\n${text}`,
            totalPages,
          };
        }
        // Empty text layer → almost certainly a scanned/image-only PDF.
        return {
          success: true,
          content:
            `PDF has no extractable text layer (pages ${firstPage}-${lastPage} of ${totalPages}) — ` +
            `it is likely scanned. Re-read with pdfPages to rasterize pages to images instead.`,
          totalPages,
        };
      }
      // Rasterize pages to images — for visual/scanned PDFs, or when layout matters.
      if (opts?.pdfPages) {
        const { images, totalPages, firstPage, lastPage } = await convertPdfToImages(
          validatedPath,
          opts.pdfPages,
          opts.rawImage,
        );
        return {
          success: true,
          content: `PDF pages ${firstPage}-${lastPage} of ${totalPages} (rasterized to images).`,
          images,
          totalPages,
        };
      }
      const totalPages = await getPdfPageCount(validatedPath);
      return {
        success: true,
        content: `PDF document with ${totalPages} page(s), ${fileStat.size} bytes.`,
        totalPages,
        pdfMeta: true,
      };
    }

    // Image files — return as base64 image content.
    //
    // Re-encoded to WebP on the way out (unless `rawImage`): this is a presentation
    // read whose consumer is a vision model, and a PNG dropped into storage by another
    // app or by the user otherwise enters the context at its full lossless size every
    // single time it is read. The file on disk is not touched — see `toWebPForModel`
    // for what it declines to convert (WebP already, GIF because of animation) and when
    // it hands the original back.
    const mime = imageFileMime(validatedPath);
    if (mime) {
      const buf = Buffer.from(await Bun.file(validatedPath).arrayBuffer());
      const encoded = opts?.rawImage ? { data: buf, mimeType: mime } : await toWebPForModel(buf, mime);
      const image: StorageImageContent = {
        type: 'image',
        data: encoded.data.toString('base64'),
        mimeType: encoded.mimeType,
      };
      const note =
        encoded.mimeType === mime
          ? `Image file (${mime})`
          : `Image file (${mime}, re-encoded to ${encoded.mimeType} for this read; the stored file is unchanged)`;
      return { success: true, content: note, images: [image] };
    }

    // Reject unknown binary files — don't read as UTF-8
    if (!isTextFile(validatedPath)) {
      const ext = extname(validatedPath) || '(no extension)';
      return {
        success: true,
        content: `Binary file (${ext}) — cannot be read as text. Use /api/storage/${filePath} to serve it directly.`,
      };
    }

    // Text file
    const content = await Bun.file(validatedPath).text();
    return { success: true, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: sanitizeStorageError(msg, filePath) };
  }
}

/** Strip absolute storage paths from error messages. */
function sanitizeStorageError(msg: string, _filePath: string): string {
  if (msg.includes(STORAGE_DIR)) {
    return msg.replaceAll(STORAGE_DIR + '/', '').replaceAll(STORAGE_DIR, '');
  }
  return msg;
}

/**
 * Write a file to storage.
 */
export async function storageWrite(
  filePath: string,
  content: string | Buffer
): Promise<StorageWriteResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, path: filePath, error: 'Invalid path: path traversal detected' };
  }
  if (resolved.readOnly) {
    return { success: false, path: filePath, error: 'Mount is read-only' };
  }
  const validatedPath = resolved.absolutePath;

  try {
    await ensureStorageDir();

    // Ensure parent directories exist
    const parentDir = join(validatedPath, '..');
    await mkdir(parentDir, { recursive: true });

    await Bun.write(validatedPath, content);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, path: filePath, error: sanitizeStorageError(msg, filePath) };
  }
}

/**
 * A `storageWrite` whose bytes arrive over time instead of all at once.
 *
 * The reason this exists is `yaar://http`'s `saveTo`: a download's whole point is that the
 * body never has to fit in memory, and `storageWrite(path, Buffer.concat(everything))`
 * defeats that before the first byte reaches disk.
 *
 * Bytes land in a sibling `.part-*` file and are renamed into place by {@link
 * StorageWriteStream.commit}. So a transfer that dies halfway leaves nothing at the
 * destination — no half a PDF that `read` will happily hand to a model — which is the
 * all-or-nothing outcome the buffered write gave for free and a naive stream would lose.
 */
export interface StorageWriteStream {
  /** Append a chunk, flushing it through to the partial file. */
  write(chunk: Uint8Array): Promise<void>;
  /** Close the partial file and move it to the destination. */
  commit(): Promise<StorageWriteResult & { bytes: number }>;
  /** Close and discard the partial file, leaving the destination untouched. */
  abort(): Promise<void>;
}

export type StorageWriteStreamResult =
  | { success: true; stream: StorageWriteStream }
  | { success: false; error: string };

/**
 * Open a streaming write to a storage path.
 *
 * Validates the destination exactly as {@link storageWrite} does — traversal, read-only
 * mounts — and creates the parent directories, so calling this is already a commitment to
 * writing there. Callers that must not leave a directory behind on a request that never
 * produces bytes (a denied domain, a 404) should open the stream on the first chunk rather
 * than up front.
 */
export async function storageWriteStream(filePath: string): Promise<StorageWriteStreamResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, error: 'Invalid path: path traversal detected' };
  }
  if (resolved.readOnly) {
    return { success: false, error: 'Mount is read-only' };
  }
  const validatedPath = resolved.absolutePath;
  const partialPath = `${validatedPath}.part-${randomUUID().slice(0, 8)}`;

  let writer: ReturnType<ReturnType<typeof Bun.file>['writer']>;
  try {
    await ensureStorageDir();
    await mkdir(dirname(validatedPath), { recursive: true });
    writer = Bun.file(partialPath).writer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: sanitizeStorageError(msg, filePath) };
  }

  let bytes = 0;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await writer.end();
  };

  return {
    success: true,
    stream: {
      async write(chunk: Uint8Array): Promise<void> {
        writer.write(chunk);
        bytes += chunk.length;
        await writer.flush();
      },
      async commit(): Promise<StorageWriteResult & { bytes: number }> {
        try {
          await close();
          await rename(partialPath, validatedPath);
          return { success: true, path: filePath, bytes };
        } catch (err) {
          await unlink(partialPath).catch(() => {});
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return { success: false, path: filePath, error: sanitizeStorageError(msg, filePath), bytes };
        }
      },
      async abort(): Promise<void> {
        try {
          await close();
        } catch {
          // Closing a sink we are about to delete cannot fail in a way that matters.
        }
        await unlink(partialPath).catch(() => {});
      },
    },
  };
}

/**
 * List files and directories in storage.
 */
export async function storageList(dirPath: string = ''): Promise<StorageListResult> {
  const cleaned = dirPath.replace(/^\/+|\/+$/g, '');

  // Virtual: listing "mounts" directory → return mount aliases as dirs
  if (cleaned === 'mounts') {
    const mounts = await loadMounts();
    const entries: StorageEntry[] = mounts.map((m) => ({
      path: `mounts/${m.alias}`,
      isDirectory: true,
      size: 0,
      modifiedAt: m.createdAt,
    }));
    return { success: true, entries };
  }

  const resolved = resolvePath(cleaned);
  if (!resolved) {
    return { success: false, error: 'Invalid path: path traversal detected. Storage tools only access files under storage/. Use relative paths without "..".' };
  }

  try {
    await ensureStorageDir();
    const entries: StorageEntry[] = [];

    let dirEntries: string[];
    try {
      const info = await stat(resolved.absolutePath);
      if (!info.isDirectory()) {
        return { success: false, error: `"${cleaned}" is a file, not a folder. Use read instead.` };
      }
      dirEntries = await readdir(resolved.absolutePath);
    } catch {
      // A directory that does not exist is not an empty one. Reporting it as
      // `{ success: true, entries: [] }` made `list('yaar://storage/nope/')`
      // indistinguishable from a folder with nothing in it — the same false success as
      // a status fabricated for an MCP server nobody configured.
      //
      // The storage root is the exception: `ensureStorageDir()` above just created it,
      // and a namespace root is a collection that exists whether or not anything has
      // been written into it yet. Callers that own such a root under a subpath (an app's
      // `storage/apps/{id}/`) opt into the same reading by checking `notFound`.
      if (!cleaned) return { success: true, entries: [] };
      return { success: false, notFound: true, error: `Directory not found: ${cleaned}` };
    }

    for (const entry of dirEntries) {
      const entryPath = join(resolved.absolutePath, entry);
      const stats = await stat(entryPath);

      entries.push({
        path: join(cleaned, entry).replaceAll('\\', '/'),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

    // Inject virtual "mounts" directory at root when mounts exist
    if (cleaned === '' && !entries.some((e) => e.path === 'mounts')) {
      const mounts = await loadMounts();
      if (mounts.length > 0) {
        entries.push({
          path: 'mounts',
          isDirectory: true,
          size: 0,
          modifiedAt: new Date().toISOString(),
        });
      }
    }

    // Sort: directories first, then by name
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });

    return { success: true, entries };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Delete a file from storage.
 */
export async function storageDelete(filePath: string): Promise<StorageDeleteResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, path: filePath, error: 'Invalid path: path traversal detected' };
  }
  if (resolved.readOnly) {
    return { success: false, path: filePath, error: 'Mount is read-only' };
  }
  const validatedPath = resolved.absolutePath;

  try {
    const stats = await stat(validatedPath);
    if (stats.isDirectory()) {
      await rm(validatedPath, { recursive: true, force: true });
    } else {
      await unlink(validatedPath);
    }
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, path: filePath, error: sanitizeStorageError(msg, filePath) };
  }
}

/**
 * Recursively collect all file paths under a directory.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        const nested = await collectFiles(fullPath);
        results.push(...nested);
      } else {
        results.push(fullPath);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return results;
}

const MAX_GREP_MATCHES = 100;

/**
 * Read a caller's glob the way every caller writes one.
 *
 * `Bun.Glob`'s `*` does not cross a `/` (standard glob semantics), and the
 * matcher is applied to the path *relative to the scope root*. So a bare
 * `*.md` — the spelling both this verb's schema and the Search app's own tool
 * schema use as their example — could only ever match a file sitting directly
 * in the scope root, and silently dropped every nested one. A search over a
 * tree of markdown returned `{ matches: [], truncated: false }`, which reads
 * exactly like "this string does not occur here".
 *
 * A pattern with no separator is therefore a *basename* pattern, as it is in
 * ripgrep and `git grep`: it matches that name at any depth. `**\/` still
 * matches a zero-directory prefix, so root-level files keep matching too.
 * A glob that names a separator meant a path and is left alone.
 */
function normalizeGlob(glob: string): string {
  return glob.includes('/') ? glob : `**/${glob}`;
}

/**
 * Search for a regex pattern across text files in a storage directory.
 */
export async function storageGrep(
  dirPath: string,
  pattern: string,
  glob?: string,
): Promise<StorageGrepResult> {
  const resolved = resolvePath(dirPath);
  if (!resolved) {
    return { success: false, error: 'Invalid path: path traversal detected.' };
  }
  const basePath = resolved.absolutePath;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid regex';
    return { success: false, error: `Invalid pattern: ${msg}` };
  }

  let dirStat;
  try {
    dirStat = await stat(basePath);
  } catch {
    return { success: false, error: `Directory not found: ${dirPath}` };
  }
  if (!dirStat.isDirectory()) {
    return { success: false, error: `"${dirPath}" is not a directory.` };
  }

  const allFiles = await collectFiles(basePath);

  const globMatcher = glob ? new Bun.Glob(normalizeGlob(glob)) : null;

  const matches: StorageGrepMatch[] = [];
  let truncated = false;
  let scannedFiles = 0;

  for (const filePath of allFiles) {
    if (!isTextFile(filePath)) continue;

    const relativePath = relative(basePath, filePath).replaceAll('\\', '/');
    if (globMatcher && !globMatcher.match(relativePath)) continue;
    scannedFiles++;

    try {
      const content = await Bun.file(filePath).text();
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({
            file: relativePath,
            line: i + 1,
            content: lines[i],
          });
          if (matches.length >= MAX_GREP_MATCHES) {
            truncated = true;
            break;
          }
        }
      }
    } catch {
      // Skip unreadable files
    }

    if (truncated) break;
  }

  return { success: true, matches, truncated, scannedFiles };
}

// --- Config directory helpers ---

const CONFIG_DIR = getConfigDir();

/**
 * Modification time (ms) of a config file, or `null` if it doesn't exist.
 * Lets callers cache parsed config in memory and re-read only when the file
 * actually changes (including external hand-edits) — far cheaper than a full
 * read + parse on every access.
 */
export async function configStatMtime(filePath: string): Promise<number | null> {
  const normalizedPath = normalize(join(CONFIG_DIR, filePath));
  const rel = relative(CONFIG_DIR, normalizedPath);
  if (rel.startsWith('..') || rel.includes('..')) return null;
  try {
    return (await stat(normalizedPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read a file from the config directory.
 */
export async function configRead(filePath: string): Promise<StorageReadResult> {
  const normalizedPath = normalize(join(CONFIG_DIR, filePath));
  const rel = relative(CONFIG_DIR, normalizedPath);
  if (rel.startsWith('..') || rel.includes('..')) {
    return { success: false, error: 'Invalid path: path traversal detected. Storage tools only access files under storage/. Use relative paths without "..".' };
  }

  try {
    const content = await Bun.file(normalizedPath).text();
    return { success: true, content };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Write a file to the config directory.
 */
export async function configWrite(
  filePath: string,
  content: string
): Promise<StorageWriteResult> {
  const normalizedPath = normalize(join(CONFIG_DIR, filePath));
  const rel = relative(CONFIG_DIR, normalizedPath);
  if (rel.startsWith('..') || rel.includes('..')) {
    return { success: false, path: filePath, error: 'Invalid path: path traversal detected' };
  }

  try {
    await mkdir(dirname(normalizedPath), { recursive: true });
    await Bun.write(normalizedPath, content);
    return { success: true, path: filePath };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, path: filePath, error };
  }
}
