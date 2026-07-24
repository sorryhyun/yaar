export {};
import { appStorage } from '@bundled/yaar';
import type { FileEntry } from '../core/types';

// Recursively list all files and directories under a storage path.
// appStorage.list() is shallow — only returns direct children.
// This function walks subdirectories and returns a flat list of all entries
// with paths relative to the given prefix.
export async function listAllFiles(storagePath: string, prefix: string): Promise<FileEntry[]> {
  let entries: FileEntry[];
  try {
    entries = await appStorage.list(storagePath);
  } catch {
    return [];
  }

  const result: FileEntry[] = [];
  for (const entry of entries) {
    // Strip the storage prefix to get a display-relative path
    const relativePath = entry.path.startsWith(prefix + '/')
      ? entry.path.slice(prefix.length + 1)
      : entry.path.startsWith(prefix)
        ? entry.path.slice(prefix.length)
        : entry.path;

    // Normalize: remove trailing slash from directory paths
    const cleanPath = relativePath.replace(/\/$/, '');

    result.push({ path: cleanPath, isDirectory: entry.isDirectory });

    // Recurse into subdirectories
    if (entry.isDirectory) {
      const subPath = entry.path.replace(/\/$/, '');
      const children = await listAllFiles(subPath, prefix);
      result.push(...children);
    }
  }
  return result;
}
