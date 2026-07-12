// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Importable SDK for @bundled/yaar.
 *
 * Thin wrapper around the `window.yaar` global (injected by the verb SDK script).
 * The verb proxy returns a JSON envelope; callVerb() unwraps it, so verb
 * functions already return parsed data. The typed helpers just pass through.
 *
 * Usage:
 *   import { read, invoke, list, storage } from '@bundled/yaar';
 *   const settings = await read<Settings>('yaar://config/settings');
 */

// Solid.js primitives — imported from solid-js directly (the Bun plugin resolves to the browser build)
import { createSignal, getOwner, onCleanup } from 'solid-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const y = (window as any).yaar;

// ── Helpers ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asText(data: any): string {
  return typeof data === 'string' ? data : data != null ? JSON.stringify(data) : '';
}

// ── Verb functions ───────────────────────────────────────────────

export async function read<T = unknown>(uri: string): Promise<T> {
  return y.read(uri);
}

export async function invoke<T = unknown>(
  uri: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  return y.invoke(uri, payload);
}

export async function list<T = unknown>(uri: string): Promise<T> {
  return y.list(uri);
}

export async function describe<T = unknown>(uri: string): Promise<T> {
  return y.describe(uri);
}

export async function del(uri: string): Promise<unknown> {
  return y.delete(uri);
}

export async function subscribe(uri: string, callback: (uri: string) => void): Promise<() => void> {
  return y.subscribe(uri, callback);
}

// ── App-scoped storage ──────────────────────────────────────────

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
    return asText(await y.read(appStorageUri(path)));
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
        };
      }
      return entry;
    });
  },
  async remove(path: string): Promise<void> {
    await y.delete(appStorageUri(path));
  },
};

// ── App-scoped database (SQLite-backed collections) ─────────────

function appDbUri(path: string): string {
  const clean = path.replace(/^\//, '');
  return clean ? `yaar://apps/self/db/${clean}` : 'yaar://apps/self/db';
}

/**
 * Handle for one collection in the app's SQLite database.
 *
 * Filters are Mongo-style: exact match `{ status: 'active' }`, operators
 * `{ age: { $gt: 18 } }` ($gt/$gte/$lt/$lte/$ne/$in/$exists), array contains
 * `{ tags: 'intro' }`. Requires `yaar://apps/self/db/` in app.json permissions.
 */
class CollectionHandle {
  constructor(name) {
    this.name = name;
  }

  /** Insert a document. Returns the generated _id. */
  async insert(doc) {
    const result = await y.invoke(appDbUri(this.name), { action: 'insert', doc });
    return result._id;
  }

  /** Insert many documents in one transaction. Returns generated ids. */
  async insertMany(docs) {
    const result = await y.invoke(appDbUri(this.name), { action: 'insertMany', docs });
    return result.ids;
  }

  /** Fetch one document by _id, or null if it doesn't exist. */
  async get(id) {
    try {
      return await y.read(appDbUri(`${this.name}/${id}`));
    } catch {
      return null;
    }
  }

  /** Query documents. Options: { sort: { field: 1 | -1 }, limit, offset }. */
  async find(filter, options) {
    return y.invoke(appDbUri(this.name), { action: 'find', filter, ...(options ?? {}) });
  }

  /** Full-text search across all document fields, best matches first. */
  async search(query, limit) {
    return y.invoke(appDbUri(this.name), {
      action: 'search',
      query,
      ...(limit != null ? { limit } : {}),
    });
  }

  /** Shallow-merge patch into the stored document. */
  async update(id, patch) {
    await y.invoke(appDbUri(`${this.name}/${id}`), { action: 'update', patch });
  }

  /** Delete one document by _id. */
  async remove(id) {
    await y.delete(appDbUri(`${this.name}/${id}`));
  }

  /** Delete all documents matching a (non-empty) filter. Returns deleted count. */
  async removeWhere(filter) {
    const result = await y.invoke(appDbUri(this.name), { action: 'removeWhere', filter });
    return result.deleted;
  }

  /** Count documents matching the filter (all documents when omitted). */
  async count(filter) {
    const result = await y.invoke(appDbUri(this.name), { action: 'count', filter });
    return result.count;
  }
}

export const appDb = {
  /** Get a collection handle (lazy — no network call until used). */
  collection(name) {
    return new CollectionHandle(name);
  },

  /** List collection names in this app's database. */
  async collections() {
    const result = await y.list(appDbUri(''));
    if (!Array.isArray(result)) return [];
    return result.map((entry) => (typeof entry === 'string' ? entry : entry.name));
  },

  /** Drop a collection and all its documents. */
  async drop(name) {
    await y.delete(appDbUri(name));
  },

  /**
   * Reactive Solid.js binding for a collection query.
   *
   * Returns `[docs, { insert, update, remove, refresh, dispose }]` where
   * `docs()` is a signal holding the current query results. Mutations made
   * through the returned helpers refresh the signal; changes made elsewhere
   * (another window, the agent) arrive via a verb subscription when the app
   * has read permission on `yaar://apps/self/db/`.
   */
  createReactiveCollection(name, options) {
    const handle = new CollectionHandle(name);
    const [docs, setDocs] = createSignal([]);
    let disposed = false;

    const refresh = async () => {
      try {
        const results = await handle.find(options?.filter, options);
        if (!disposed) setDocs(() => results);
      } catch (e) {
        console.error(`[yaar] appDb.createReactiveCollection("${name}"): refresh failed`, e);
      }
    };
    void refresh();

    // Best-effort external-change subscription — mutations from other windows
    // or the agent trigger a refetch. Failures are fine; local mutations
    // still refresh explicitly.
    let unsubscribe = null;
    try {
      Promise.resolve(y.subscribe(appDbUri(name), () => void refresh()))
        .then((unsub) => {
          if (disposed) unsub?.();
          else unsubscribe = unsub;
        })
        .catch(() => {});
    } catch {
      // subscribe unavailable — polling-free local mode
    }

    const dispose = () => {
      disposed = true;
      unsubscribe?.();
    };
    if (getOwner()) onCleanup(dispose);

    const after = async (promise) => {
      const result = await promise;
      await refresh();
      return result;
    };

    return [
      docs,
      {
        insert: (doc) => after(handle.insert(doc)),
        update: (id, patch) => after(handle.update(id, patch)),
        remove: (id) => after(handle.remove(id)),
        refresh,
        dispose,
      },
    ];
  },
};

// ── Sub-object re-exports ────────────────────────────────────────

export const storage = y.storage;
export const app = y.app;
export const notifications = y.notifications;
export const windows = y.windows;

// ── App Protocol descriptor builders ─────────────────────────────

/**
 * Identity at runtime — the descriptor is passed to `app.register()` untouched.
 * All the work happens in the type declarations (`bundled-types/index.d.ts`),
 * which infer the handler's parameter type from the `params` JSON Schema.
 *
 * Keep the call shape `defineCommand({ ... })`: the build-time protocol
 * extractor recognises a bare identifier wrapping the descriptor literal, and
 * anything fancier (a computed callee, a spread descriptor) will make it skip
 * the command.
 */
export const defineCommand = <T>(descriptor: T): T => descriptor;

// ── Utilities ───────────────────────────────────────────────────

/** Returns a promise that resolves after `ms` milliseconds. */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Extract a human-readable message from any thrown value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Throw from a command handler to signal failure to the agent.
 * The message is delivered as-is — no stack trace, no noise.
 */
export class AppCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppCommandError';
  }
}

/**
 * Show a toast notification using the built-in `y-toast` CSS classes.
 * Auto-dismisses after `ms` (default 3000).
 */
export function showToast(
  msg: string,
  type: 'info' | 'success' | 'error' = 'info',
  ms = 3000,
): void {
  const el = document.createElement('div');
  el.className = `y-toast y-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('y-toast-visible'));
  setTimeout(() => {
    el.classList.remove('y-toast-visible');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ── Async helpers ─────────────────────────────────────────────────

/**
 * Run an async function with loading/error state management.
 * Sets loading to true, runs fn, catches errors via onError, and clears loading in finally.
 */
export async function withLoading<T>(
  setLoading: (v: boolean) => void,
  fn: () => Promise<T>,
  onError?: (msg: string) => void,
): Promise<T | undefined> {
  setLoading(true);
  try {
    return await fn();
  } catch (e) {
    if (onError) onError(errMsg(e));
    else console.error(e);
    return undefined;
  } finally {
    setLoading(false);
  }
}

// ── Keyboard shortcuts ───────────────────────────────────────────

/**
 * Register a keyboard shortcut. Returns a cleanup function.
 *
 * Combo format: modifier keys joined with `+`, e.g. `"ctrl+s"`, `"alt+arrowup"`, `"escape"`.
 * Recognized modifiers: `ctrl`, `meta`, `alt`, `shift`. The non-modifier part is matched
 * against `KeyboardEvent.key` (case-insensitive).
 *
 * `ctrl` matches both Ctrl and Cmd (Meta) for cross-platform shortcuts.
 */
export function onShortcut(combo: string, handler: (e: KeyboardEvent) => void): () => void {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);

  const listener = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== key) return;
    const needCtrl = mods.has('ctrl');
    const needMeta = mods.has('meta');
    const needAlt = mods.has('alt');
    const needShift = mods.has('shift');
    // ctrl matches both ctrlKey and metaKey for cross-platform
    if (needCtrl && !e.ctrlKey && !e.metaKey) return;
    if (needMeta && !e.metaKey) return;
    if (needAlt && !e.altKey) return;
    if (needShift && !e.shiftKey) return;
    // Ensure no unexpected modifiers are pressed (unless required)
    if (!needCtrl && !needMeta && (e.ctrlKey || e.metaKey)) return;
    if (!needAlt && e.altKey) return;
    if (!needShift && e.shiftKey) return;
    e.preventDefault();
    handler(e);
  };

  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}

// ── Persisted signal ──────────────────────────────────────────────

/**
 * Create a Solid.js signal that auto-persists to appStorage.
 * Loads the saved value on creation (async — the signal starts with `fallback`
 * and updates once the stored value is read). Saves automatically on every set.
 * A set that lands before the initial load resolves wins over the stored value.
 *
 * A failed save is reported (logged, and toasted at most once per 5s) rather
 * than dropped: the signal keeps the new value, but it is no longer persisted.
 * Pass `label` to name the data in that toast, or `onError` to replace it.
 */
export function createPersistedSignal<T>(
  key: string,
  fallback: T,
  options?: { label?: string; onError?: (message: string, error: unknown) => void },
): [() => T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = createSignal<T>(fallback);
  let written = false;
  appStorage.readJsonOr<T>(key, fallback).then((stored) => {
    if (!written) setValue(() => stored as any);
  });
  const set = (v: T | ((prev: T) => T)) => {
    written = true;
    const next = setValue(v as any);
    void appStorage.trySave(key, JSON.stringify(next), {
      label: options?.label,
      onError: options?.onError,
    });
  };
  return [value, set];
}

// ── Default export: the raw global ───────────────────────────────

export const yaar = y;
export default y;
