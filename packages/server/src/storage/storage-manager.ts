/**
 * Storage manager for persistent file storage.
 *
 * Provides CRUD operations for the storage/ directory with path validation.
 */

import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'fs/promises';
import { join, normalize, relative, dirname, extname } from 'path';
import { pdfToImages, getPdfPageCount } from '../lib/pdf/index.js';
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
  StorageImageContent,
} from './types.js';

/**
 * Validate and normalize a path within the storage directory.
 * Returns null if the path is outside the storage directory.
 */
function validatePath(filePath: string): string | null {
  const normalizedPath = normalize(join(STORAGE_DIR, filePath));

  // Ensure the path is within the storage directory
  const relativePath = relative(STORAGE_DIR, normalizedPath);
  if (relativePath.startsWith('..') || relativePath.includes('..')) {
    return null;
  }

  return normalizedPath;
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

const MAX_PDF_PREVIEW_PAGES = 3;

/**
 * Convert a PDF file to images (PNG format via poppler).
 * Returns at most MAX_PDF_PREVIEW_PAGES images.
 */
async function convertPdfToImages(filePath: string): Promise<{ images: StorageImageContent[]; totalPages: number }> {
  const totalPages = await getPdfPageCount(filePath);
  const pdfPages = await pdfToImages(filePath, 1.5, MAX_PDF_PREVIEW_PAGES);

  const images = pdfPages.map(page => ({
    type: 'image' as const,
    data: page.data.toString('base64'),
    mimeType: page.mimeType,
    pageNumber: page.pageNumber,
  }));

  return { images, totalPages };
}

/**
 * Read a file from storage.
 */
export async function storageRead(filePath: string): Promise<StorageReadResult> {
  const validatedPath = validatePath(filePath);
  if (!validatedPath) {
    return { success: false, error: 'Invalid path: path traversal detected' };
  }

  try {
    // Handle PDF files by converting to images
    if (isPdfFile(validatedPath)) {
      const { images, totalPages } = await convertPdfToImages(validatedPath);
      const exceeded = totalPages > MAX_PDF_PREVIEW_PAGES;
      const content = exceeded
        ? `PDF preview (first ${MAX_PDF_PREVIEW_PAGES} of ${totalPages} pages). It exceeds ${MAX_PDF_PREVIEW_PAGES} pages! Total: ${totalPages} pages.`
        : `PDF with ${totalPages} page(s)`;
      return {
        success: true,
        content,
        images,
        totalPages,
      };
    }

    // Regular text file
    const content = await readFile(validatedPath, 'utf-8');
    return { success: true, content };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Write a file to storage.
 */
export async function storageWrite(
  filePath: string,
  content: string | Buffer
): Promise<StorageWriteResult> {
  const validatedPath = validatePath(filePath);
  if (!validatedPath) {
    return { success: false, path: filePath, error: 'Invalid path: path traversal detected' };
  }

  try {
    await ensureStorageDir();

    // Ensure parent directories exist
    const parentDir = join(validatedPath, '..');
    await mkdir(parentDir, { recursive: true });

    if (Buffer.isBuffer(content)) {
      await writeFile(validatedPath, content);
    } else {
      await writeFile(validatedPath, content, 'utf-8');
    }
    return { success: true, path: filePath };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, path: filePath, error };
  }
}

/**
 * List files and directories in storage.
 */
export async function storageList(dirPath: string = ''): Promise<StorageListResult> {
  const validatedPath = validatePath(dirPath);
  if (!validatedPath) {
    return { success: false, error: 'Invalid path: path traversal detected' };
  }

  try {
    await ensureStorageDir();
    const entries: StorageEntry[] = [];

    let dirEntries: string[];
    try {
      dirEntries = await readdir(validatedPath);
    } catch {
      // Directory doesn't exist, return empty list
      return { success: true, entries: [] };
    }

    for (const entry of dirEntries) {
      const entryPath = join(validatedPath, entry);
      const stats = await stat(entryPath);

      entries.push({
        path: join(dirPath, entry),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
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
  const validatedPath = validatePath(filePath);
  if (!validatedPath) {
    return { success: false, path: filePath, error: 'Invalid path: path traversal detected' };
  }

  try {
    await unlink(validatedPath);
    return { success: true, path: filePath };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, path: filePath, error };
  }
}

// --- Config directory helpers ---

const CONFIG_DIR = getConfigDir();

/**
 * Read a file from the config directory.
 */
export async function configRead(filePath: string): Promise<StorageReadResult> {
  const normalizedPath = normalize(join(CONFIG_DIR, filePath));
  const rel = relative(CONFIG_DIR, normalizedPath);
  if (rel.startsWith('..') || rel.includes('..')) {
    return { success: false, error: 'Invalid path: path traversal detected' };
  }

  try {
    const content = await readFile(normalizedPath, 'utf-8');
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
    await writeFile(normalizedPath, content, 'utf-8');
    return { success: true, path: filePath };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, path: filePath, error };
  }
}
