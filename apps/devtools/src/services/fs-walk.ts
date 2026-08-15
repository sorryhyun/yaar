export {};
import { appStorage } from '@bundled/yaar';
import type { FileEntry } from '../core/types';

// appStorage.list() is shallow — only returns direct children — so this walks
// subdirectories itself to build the flat list.
//
// `dist/` is skipped entirely. It is compiler output — the largest entry in every
// project (an inlined bundle runs past 100KB), never edited by hand, and excluded
// from version history — so listing it only crowded out the source files the list
// exists to show.
const GENERATED_DIRS = new Set(['dist']);

export async function listAllFiles(storagePath: string, prefix: string): Promise<FileEntry[]> {
  let entries: Awaited<ReturnType<typeof appStorage.list>>;
  try {
    entries = await appStorage.list(storagePath);
  } catch {
    return [];
  }

  const result: FileEntry[] = [];
  for (const entry of entries) {
    const relativePath = entry.path.startsWith(prefix + '/')
      ? entry.path.slice(prefix.length + 1)
      : entry.path.startsWith(prefix)
        ? entry.path.slice(prefix.length)
        : entry.path;

    const cleanPath = relativePath.replace(/\/$/, '');

    if (entry.isDirectory && GENERATED_DIRS.has(cleanPath)) continue;

    result.push({
      path: cleanPath,
      isDirectory: entry.isDirectory,
      // The listing already knows how big each file is and when it was last written.
      // Reading them here is what lets binary files carry a size (they cannot be
      // measured as text) and what gives the project a real modification time.
      ...(entry.isDirectory || entry.size === undefined ? {} : { bytes: entry.size }),
      ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
    });

    if (entry.isDirectory) {
      const subPath = entry.path.replace(/\/$/, '');
      const children = await listAllFiles(subPath, prefix);
      result.push(...children);
    }
  }
  return result;
}
