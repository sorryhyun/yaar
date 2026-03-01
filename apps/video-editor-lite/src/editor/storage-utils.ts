export const STORAGE_VIDEO_FILE_RE = /\.(mp4|m4v|webm|mov|avi|mkv|ogv|ogg)$/i;
export const DEFAULT_STORAGE_LIST_PATH = 'mounts/lecture-materials';
export const STORAGE_SCAN_LIMIT = 200;
export const STORAGE_URL_PREFIX = '/api/storage/';

export type StorageEntry = { path: string; isDirectory: boolean };
export type YaarStorageApi = {
  list: (dirPath?: string) => Promise<StorageEntry[]>;
  url?: (path: string) => string;
};

export function getStorageApi(): YaarStorageApi | null {
  const maybeStorage = (window as { yaar?: { storage?: unknown } }).yaar?.storage;
  if (!maybeStorage || typeof (maybeStorage as YaarStorageApi).list !== 'function') {
    return null;
  }
  return maybeStorage as YaarStorageApi;
}

export function normalizeStoragePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith(STORAGE_URL_PREFIX)) {
    return trimmed.slice(STORAGE_URL_PREFIX.length);
  }
  return trimmed.replace(/^\/+/, '');
}

export function encodeStoragePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function toStorageUrl(storagePath: string): string {
  const normalizedPath = normalizeStoragePath(storagePath);
  const storageApi = getStorageApi();
  if (storageApi?.url) {
    return storageApi.url(normalizedPath);
  }
  return `${STORAGE_URL_PREFIX}${encodeStoragePath(normalizedPath)}`;
}

export async function collectStorageVideoPaths(
  storageApi: YaarStorageApi,
  dirPath = '',
  visited = new Set<string>(),
  collected: string[] = [],
): Promise<string[]> {
  if (collected.length >= STORAGE_SCAN_LIMIT) {
    return collected;
  }

  const visitKey = dirPath || '/';
  if (visited.has(visitKey)) {
    return collected;
  }
  visited.add(visitKey);

  const entries = await storageApi.list(dirPath);

  for (const entry of entries) {
    if (collected.length >= STORAGE_SCAN_LIMIT) {
      break;
    }

    if (entry.isDirectory) {
      await collectStorageVideoPaths(storageApi, entry.path, visited, collected);
      continue;
    }

    const path = normalizeStoragePath(entry.path);
    if (STORAGE_VIDEO_FILE_RE.test(path)) {
      collected.push(path);
    }
  }

  return collected;
}
