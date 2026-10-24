// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Where storage keeps files when the page runs outside YAAR (a published claude.ai Artifact,
 * or its HTML loaded by an agent's headless browser).
 *
 * There is no YAAR backend there: every storage request comes back as the viewer's own HTML
 * page, which an app saw as `Unexpected token '<'` on its first save. So the same paths are
 * kept in IndexedDB in the viewer's browser instead: `appStorage` in one store, the rest of
 * `storage` (the commons and other root paths) in another. That data belongs to one viewer
 * in one browser, and can come back empty (a private window, cleared site data): it keeps an
 * app's work across a refresh, not anywhere another viewer or YAAR can see it.
 */

import { getAppId } from './app-identity.js';

/**
 * True when the page runs in the claude.ai Artifact viewer (Artifact Publisher's output).
 * The viewer defines `window.claude` before any page script runs; YAAR never does.
 * `downloadBlob` saves through it.
 */
export function isPublishedArtifact(): boolean {
  return typeof globalThis.window?.claude?.use === 'function';
}

/**
 * True when no YAAR desktop hosts this page: the claude.ai viewer, or a top window holding
 * no iframe token (an agent's headless browser running the published HTML). Storage then
 * goes to this browser (below); verb and agent calls have nothing to answer them.
 *
 * Restates `OUTSIDE_YAAR` in shared's iframe-scripts/prelude.ts, which the fetch proxy and
 * `window.yaarApp` use; keep the two the same.
 */
export function outsideYaar(): boolean {
  if (isPublishedArtifact()) return true;
  const w = globalThis.window;
  if (!w || w.parent !== w || w.__YAAR_TOKEN__) return false;
  try {
    return !new URLSearchParams(w.location.search).get('__yaar_token');
  } catch {
    return true;
  }
}

const DB_NAME = 'yaar-app-storage';
/** `appStorage`'s files, keyed by app-relative path. */
const APP_STORE = 'files';
/** Every other `storage` path, keyed by storage-root-relative path (`shared/x.flac`). */
const ROOT_STORE = 'storage';

interface StoredFile {
  path: string;
  data: ArrayBuffer;
  type: string;
  modifiedAt: string;
}

const MIME: Record<string, string> = {
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

function mimeOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

function clean(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function unavailable(cause: unknown): Error {
  const err = new Error(
    'This browser is not keeping files for this page (a private window, or blocked site ' +
      `data): ${cause instanceof Error ? cause.message : String(cause ?? 'IndexedDB unavailable')}`,
  );
  err.code = 'storage_unavailable';
  return err;
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = globalThis.indexedDB.open(DB_NAME, 2);
    } catch (e) {
      reject(unavailable(e));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [APP_STORE, ROOT_STORE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(unavailable(req.error));
  });
  // A failed open is retried on the next call rather than cached: a blocked upgrade clears.
  opening.catch(() => (opening = null));
  return opening;
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  const db = await open();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = op(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
  });
}

function notFound(path: string): Error {
  return new Error(`File not found: ${path}`);
}

export interface LocalEntry {
  path: string;
  isDirectory: boolean;
  uri?: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
}

/** One IndexedDB store, addressed by paths relative to whatever root it stands in for. */
function localFiles(store: string, uriOf: (path: string, isDirectory: boolean) => string | null) {
  const get = (key: string) => run<StoredFile | undefined>(store, 'readonly', (s) => s.get(key));

  async function write(path: string, bytes: Uint8Array): Promise<void> {
    const key = clean(path);
    const file: StoredFile = {
      path: key,
      data: bytes.slice().buffer,
      type: mimeOf(key),
      modifiedAt: new Date().toISOString(),
    };
    await run(store, 'readwrite', (s) => s.put(file));
  }

  /** The stored file as a Blob, or null when nothing is stored at `path`. */
  async function readOr(path: string): Promise<Blob | null> {
    const file = await get(clean(path));
    return file ? new Blob([file.data], { type: file.type }) : null;
  }

  return {
    write,
    readOr,
    async read(path: string): Promise<Blob> {
      const blob = await readOr(path);
      if (!blob) throw notFound(path);
      return blob;
    },
    /** Resolves with the file's size after the append. */
    async append(path: string, bytes: Uint8Array): Promise<number> {
      const key = clean(path);
      const prev = await get(key);
      const before = prev ? new Uint8Array(prev.data) : new Uint8Array(0);
      const joined = new Uint8Array(before.length + bytes.length);
      joined.set(before, 0);
      joined.set(bytes, before.length);
      await write(key, joined);
      return joined.length;
    },
    /**
     * The direct children of `dir`, in the server listing's shape: `path` is relative to
     * this store's root, and a directory is any prefix a stored path runs through.
     */
    async list(dir: string): Promise<LocalEntry[]> {
      const prefix = clean(dir) ? `${clean(dir)}/` : '';
      const all = await run<StoredFile[]>(store, 'readonly', (s) => s.getAll());
      const dirs = new Set<string>();
      const out: LocalEntry[] = [];
      for (const f of all) {
        if (!f.path.startsWith(prefix)) continue;
        const rest = f.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash >= 0) {
          dirs.add(prefix + rest.slice(0, slash));
          continue;
        }
        const entry: LocalEntry = {
          path: f.path,
          isDirectory: false,
          mimeType: f.type,
          size: f.data.byteLength,
          modifiedAt: f.modifiedAt,
        };
        const uri = uriOf(f.path, false);
        if (uri) entry.uri = uri;
        out.push(entry);
      }
      for (const d of dirs) {
        const entry: LocalEntry = { path: d, isDirectory: true };
        const uri = uriOf(d, true);
        if (uri) entry.uri = uri;
        out.push(entry);
      }
      return out;
    },
    async remove(path: string): Promise<void> {
      const key = clean(path);
      if (!(await get(key))) throw notFound(path);
      await run(store, 'readwrite', (s) => s.delete(key));
    },
  };
}

/** `appStorage` outside YAAR: paths relative to the app's own tree. */
export const appLocal = localFiles(
  APP_STORE,
  (p, dir) => `yaar://apps/self/storage/${p}${dir ? '/' : ''}`,
);

const rootLocal = localFiles(ROOT_STORE, () => null);

export async function toBytes(data: string | Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * `storage` (the SDK's root door) that keeps working outside YAAR. Inside YAAR every call
 * goes to `real()`, the injected storage SDK. Outside it, a path into this app's own tree
 * (`apps/self/…`, `apps/<appId>/…`, any spelling `storage.path` folds) reads and writes the
 * same files `appStorage` does, and every other path goes to a store of its own.
 *
 * `url()` stays the server's: it is synchronous and an `<img src>` cannot read IndexedDB.
 */
export function storageWithLocalFallback(real: () => any) {
  /** Which store a reference lands in, or throws the SDK's own refusal for a non-path. */
  function locate(
    ref: unknown,
    op: string,
  ): { files: typeof appLocal; key: string; prefix: string } {
    const p = real().path(ref);
    if (p === null) {
      throw new Error(
        `storage.${op}: "${String(ref)}" is not a storage path. Expected a path like ` +
          '"shared/x.png" or "apps/self/x.png".',
      );
    }
    const own = /^apps\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (own && (own[1] === 'self' || own[1] === getAppId())) {
      return { files: appLocal, key: own[2] ?? '', prefix: `apps/${own[1]}/` };
    }
    return { files: rootLocal, key: p, prefix: '' };
  }

  return {
    path: (ref: unknown) => real().path(ref),
    url: (path: string) => real().url(path),
    async save(path: string, data: string | Blob | ArrayBuffer | Uint8Array) {
      if (!outsideYaar()) return real().save(path, data);
      const { files, key } = locate(path, 'save');
      await files.write(key, await toBytes(data));
      return { ok: true };
    },
    async append(path: string, data: string | Blob | ArrayBuffer | Uint8Array) {
      if (!outsideYaar()) return real().append(path, data);
      const { files, key } = locate(path, 'append');
      return { ok: true, size: await files.append(key, await toBytes(data)) };
    },
    async read(path: string, options?: { as?: string }) {
      if (!outsideYaar()) return real().read(path, options);
      const { files, key } = locate(path, 'read');
      const blob = await files.read(key);
      const mode = options?.as ?? 'auto';
      if (mode === 'blob') return blob;
      if (mode === 'arraybuffer') return blob.arrayBuffer();
      if (mode === 'json') return JSON.parse(await blob.text());
      if (mode === 'text') return blob.text();
      if (blob.type.includes('json')) return JSON.parse(await blob.text());
      if (blob.type.startsWith('text/')) return blob.text();
      return blob;
    },
    async list(dirPath?: string) {
      if (!outsideYaar()) return real().list(dirPath);
      if (!dirPath) return rootLocal.list('');
      const { files, key, prefix } = locate(dirPath, 'list');
      // The server lists root-relative paths; the app store keeps app-relative ones.
      return (await files.list(key)).map((e) => ({ ...e, path: prefix + e.path }));
    },
    async remove(path: string) {
      if (!outsideYaar()) return real().remove(path);
      const { files, key } = locate(path, 'remove');
      await files.remove(key);
      return { ok: true };
    },
  };
}
