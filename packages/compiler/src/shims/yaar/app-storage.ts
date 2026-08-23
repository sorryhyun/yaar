// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * App-scoped storage — wraps the `yaar://apps/self/storage/` verbs.
 */

import { y, asText } from './verbs.js';
import { errMsg, showToast } from './ui.js';

function appStorageUri(path: string): string {
  const clean = path.replace(/^\//, '');
  return clean ? `yaar://apps/self/storage/${clean}` : 'yaar://apps/self/storage/';
}

/**
 * A failing autosave usually fails again on every tick, so `trySave` toasts a
 * given path at most once per window. Every failure is logged regardless. A
 * success clears the entry, so a later failure is toasted again.
 */
const SAVE_FAILURE_TOAST_INTERVAL_MS = 5000;
const lastSaveFailureToast = new Map<string, number>();

function toastSaveFailure(path: string, label: string, error: unknown): void {
  const now = Date.now();
  const last = lastSaveFailureToast.get(path);
  if (last != null && now - last < SAVE_FAILURE_TOAST_INTERVAL_MS) return;
  lastSaveFailureToast.set(path, now);
  showToast(`Couldn't save ${label}: ${errMsg(error)}`, 'error');
}

export interface YaarAppStorageEntry {
  path: string;
  isDirectory: boolean;
  uri: string;
  mimeType?: string;
  /** Bytes. Absent for directories, and for a server too old to report it. */
  size?: number;
  /** ISO timestamp of the last write. */
  modifiedAt?: string;
}

export const appStorage = {
  async save(
    path: string,
    content: string,
    options?: { encoding?: 'utf-8' | 'base64' },
  ): Promise<void> {
    const payload: Record<string, unknown> = { action: 'write', content };
    if (options?.encoding) payload.encoding = options.encoding;
    await y.invoke(appStorageUri(path), payload);
  },
  /**
   * `save()` that reports failure instead of throwing. Returns whether the write
   * landed, so callers can hold back a "Saved" toast or a dirty-flag clear.
   *
   * A failure is always logged. It is also toasted, unless `onError` is given —
   * then that runs instead, for apps with their own error surface.
   */
  async trySave(
    path: string,
    content: string,
    options?: {
      encoding?: 'utf-8' | 'base64';
      /** Name shown in the failure toast. Defaults to `path`. */
      label?: string;
      /** Replaces the failure toast. */
      onError?: (message: string, error: unknown) => void;
    },
  ): Promise<boolean> {
    try {
      await appStorage.save(path, content, { encoding: options?.encoding });
      lastSaveFailureToast.delete(path);
      return true;
    } catch (e) {
      console.error(`[yaar] appStorage.trySave: failed to save "${path}"`, e);
      if (options?.onError) options.onError(errMsg(e), e);
      else toastSaveFailure(path, options?.label ?? path, e);
      return false;
    }
  },
  async read(path: string): Promise<string> {
    // Through the raw storage door (an HTTP GET of the file), not the verb layer. A verb
    // read of a text file whose content happens to parse as JSON hands back the parsed
    // value, and re-serializing that flattens the file to one minified line — so every
    // read of a valid .json file lied about its formatting, and an app that wrote the
    // result back (an edit round trip) flattened the file on disk for real. `as: 'text'`
    // keeps this door from doing its own content-type parse.
    return String(await y.storage.read(appStorageUri(path), { as: 'text' }));
  },
  async readJson<T = unknown>(path: string): Promise<T> {
    return y.read(appStorageUri(path));
  },
  /** Read JSON with a fallback value returned when the file doesn't exist or is unparseable. */
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    try {
      return (await y.read(appStorageUri(path))) as T;
    } catch {
      return fallback;
    }
  },
  async readBinary(
    path: string,
  ): Promise<{ data: string; mimeType: string; encoding: 'base64' | 'text' }> {
    const result = await y.read(appStorageUri(path));
    // When images are present, callVerb returns { data, images } with base64 data
    if (result && typeof result === 'object' && result.images?.length) {
      const img = result.images[0];
      return {
        data: img.data,
        mimeType: img.mimeType ?? 'application/octet-stream',
        encoding: 'base64',
      };
    }
    // Non-image reads come back as text — flag it so callers don't atob() plain text
    return { data: asText(result), mimeType: 'application/octet-stream', encoding: 'text' };
  },
  /** Read file contents as a Blob. Decodes base64 for binary (image) reads; wraps text as-is. */
  async readBlob(path: string): Promise<Blob> {
    const { data, mimeType, encoding } = await appStorage.readBinary(path);
    if (encoding === 'base64') {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return new Blob([bytes], { type: mimeType });
    }
    return new Blob([data], { type: mimeType });
  },
  async list(dirPath?: string): Promise<YaarAppStorageEntry[]> {
    const result = await y.list(appStorageUri(dirPath ?? ''));
    if (!Array.isArray(result)) return [];
    // Convert resource_link format to storage entry shape for backward compat
    return result.map((entry: any): YaarAppStorageEntry => {
      if (entry.uri && entry.name != null && !entry.path) {
        return {
          path: entry.name,
          isDirectory: entry.description === 'directory',
          uri: entry.uri,
          mimeType: entry.mimeType,
          ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
          ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
        };
      }
      return entry;
    });
  },
  async remove(path: string): Promise<void> {
    await y.delete(appStorageUri(path));
  },
};
