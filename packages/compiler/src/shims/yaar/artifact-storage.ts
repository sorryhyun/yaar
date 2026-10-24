// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Where `appStorage` keeps files when the page runs as a published claude.ai Artifact.
 *
 * There is no YAAR backend there: every storage request comes back as the viewer's own HTML
 * page, which an app saw as `Unexpected token '<'` on its first save. So the same paths are
 * kept in one IndexedDB store in the viewer's browser instead. That store belongs to one
 * viewer in one browser, and can come back empty (a private window, cleared site data): it
 * keeps an app's work across a refresh, not anywhere another viewer or YAAR can see it.
 */

/**
 * True when the page runs as a published claude.ai Artifact (Artifact Publisher's output)
 * instead of inside YAAR. The claude.ai viewer defines `window.claude` before any page
 * script runs; YAAR never does. Storage goes to this browser (below) and `downloadBlob` to
 * the viewer's downloads; verb and agent calls have nothing to answer them.
 */
export function isPublishedArtifact(): boolean {
  return typeof globalThis.window?.claude?.use === 'function';
}

const DB_NAME = 'yaar-app-storage';
const STORE = 'files';

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
      req = globalThis.indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(unavailable(e));
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(unavailable(req.error));
  });
  // A failed open is retried on the next call rather than cached: a blocked upgrade clears.
  opening.catch(() => (opening = null));
  return opening;
}

async function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  const db = await open();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
  });
}

function notFound(path: string): Error {
  return new Error(`File not found: ${path}`);
}

export async function localWrite(path: string, bytes: Uint8Array): Promise<void> {
  const key = clean(path);
  const file: StoredFile = {
    path: key,
    data: bytes.slice().buffer,
    type: mimeOf(key),
    modifiedAt: new Date().toISOString(),
  };
  await run('readwrite', (s) => s.put(file));
}

/** Resolves with the file's size after the append. */
export async function localAppend(path: string, bytes: Uint8Array): Promise<number> {
  const key = clean(path);
  const prev = await run<StoredFile | undefined>('readonly', (s) => s.get(key));
  const before = prev ? new Uint8Array(prev.data) : new Uint8Array(0);
  const joined = new Uint8Array(before.length + bytes.length);
  joined.set(before, 0);
  joined.set(bytes, before.length);
  await localWrite(key, joined);
  return joined.length;
}

/** The stored file as a Blob, or null when nothing is stored at `path`. */
export async function localReadOr(path: string): Promise<Blob | null> {
  const file = await run<StoredFile | undefined>('readonly', (s) => s.get(clean(path)));
  return file ? new Blob([file.data], { type: file.type }) : null;
}

export async function localRead(path: string): Promise<Blob> {
  const blob = await localReadOr(path);
  if (!blob) throw notFound(path);
  return blob;
}

/**
 * The direct children of `dir`, in the server listing's shape: `path` is relative to the
 * app's storage root, and a directory is any prefix a stored path runs through.
 */
export async function localList(dir: string): Promise<
  {
    path: string;
    isDirectory: boolean;
    uri: string;
    mimeType?: string;
    size?: number;
    modifiedAt?: string;
  }[]
> {
  const prefix = clean(dir) ? `${clean(dir)}/` : '';
  const all = await run<StoredFile[]>('readonly', (s) => s.getAll());
  const dirs = new Set<string>();
  const out = [];
  for (const f of all) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      dirs.add(prefix + rest.slice(0, slash));
      continue;
    }
    out.push({
      path: f.path,
      isDirectory: false,
      uri: `yaar://apps/self/storage/${f.path}`,
      mimeType: f.type,
      size: f.data.byteLength,
      modifiedAt: f.modifiedAt,
    });
  }
  for (const d of dirs) {
    out.push({ path: d, isDirectory: true, uri: `yaar://apps/self/storage/${d}/` });
  }
  return out;
}

export async function localRemove(path: string): Promise<void> {
  const key = clean(path);
  if (!(await run<StoredFile | undefined>('readonly', (s) => s.get(key)))) throw notFound(path);
  await run('readwrite', (s) => s.delete(key));
}
