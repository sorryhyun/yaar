/**
 * io.ts — every path in and out of the app: shared storage, the app's own
 * storage, and HTTP. Nothing else in the app touches yaar:// directly.
 */
import { appStorage, httpFetch, invoke, list, storage } from '@bundled/yaar';

export interface StorageEntry {
  name: string;
  /** path relative to the storage root, e.g. "files/models/duck.glb" */
  path: string;
  isDirectory: boolean;
  /** display-only detail, e.g. "18.0 KB" */
  hint?: string;
}

export const MEDIA_DIR = 'media/studio-3d';
export const SCENES_DIR = 'scenes';

/** Strip a yaar://storage/ prefix, leaving a root-relative path. */
export function toStoragePath(uriOrPath: string): string {
  let p = uriOrPath.trim();
  p = p.replace(/^yaar:\/\/storage\//i, '');
  p = p.replace(/^\/+/, '');
  return p;
}

export function toStorageUri(path: string): string {
  return `yaar://storage/${toStoragePath(path)}`;
}

export function baseName(path: string): string {
  const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? clean : clean.slice(i + 1);
}

export function dirName(path: string): string {
  const clean = toStoragePath(path).replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? '' : clean.slice(0, i);
}

/* ------------------------------------------------------------- listing -- */

/**
 * A raw child as returned by `list('yaar://storage/...')`.
 *
 * The verb API does NOT set `isDirectory` and does NOT suffix directory URIs
 * with a slash. A directory child comes back as
 *   { uri, name, description: 'directory' }
 * and a file as
 *   { uri, name, description: '18436 bytes', mimeType: 'text/plain' }
 * so the directory flag has to be recovered from `description`/`mimeType`.
 *
 * `name` is also unreliable for nested listings (the server trims a character
 * off it — "mounts/toolresults" arrives as name "oolresults"), so the display
 * name is always derived from the URI instead.
 */
interface RawEntry {
  uri?: string;
  path?: string;
  name?: string;
  isDirectory?: boolean;
  isDir?: boolean;
  directory?: boolean;
  type?: string;
  kind?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

const DIR_WORDS = new Set(['directory', 'dir', 'folder']);

function isDirWord(v: unknown): boolean {
  return typeof v === 'string' && DIR_WORDS.has(v.trim().toLowerCase());
}

function looksLikeDirectory(e: RawEntry): boolean {
  if (e.isDirectory === true || e.isDir === true || e.directory === true) return true;
  if (isDirWord(e.type) || isDirWord(e.kind)) return true;
  if (isDirWord(e.description)) return true;
  if ((e.uri ?? e.path ?? '').endsWith('/')) return true;
  return false;
}

/** Human hint shown on the right of a row: "18.0 KB", "folder", … */
function entryHint(e: RawEntry, isDirectory: boolean): string {
  if (isDirectory) return '';
  const desc = typeof e.description === 'string' ? e.description.trim() : '';
  const bytes = /^(\d+)\s*bytes?$/i.exec(desc);
  if (bytes) return formatBytes(Number(bytes[1]));
  if (typeof e.size === 'number') return formatBytes(e.size);
  return desc;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function joinDir(dir: string, name: string): string {
  if (!dir) return name;
  if (name === dir || name.startsWith(`${dir}/`)) return name;
  return `${dir}/${name}`;
}

function normalizeEntry(raw: unknown, dir: string): StorageEntry | null {
  if (typeof raw === 'string') {
    const path = toStoragePath(raw.includes('://') ? raw : joinDir(dir, raw));
    if (!path) return null;
    return { name: baseName(path), path, isDirectory: raw.endsWith('/'), hint: '' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as RawEntry;
  const source = e.uri ?? e.path ?? e.name;
  if (!source) return null;
  const path = toStoragePath(source.includes('://') ? source : joinDir(dir, source));
  if (!path) return null;
  const isDirectory = looksLikeDirectory(e);
  return {
    name: baseName(path) || path,
    path,
    isDirectory,
    hint: entryHint(e, isDirectory),
  };
}

export async function listStorage(dir = ''): Promise<StorageEntry[]> {
  const clean = toStoragePath(dir).replace(/\/+$/, '');
  const res = await list<unknown>(`yaar://storage/${clean ? `${clean}/` : ''}`);
  let items: unknown[] = [];
  if (Array.isArray(res)) items = res;
  else if (res && typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    for (const key of ['children', 'entries', 'items', 'files', 'resources']) {
      if (Array.isArray(obj[key])) {
        items = obj[key] as unknown[];
        break;
      }
    }
  }
  const out: StorageEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const entry = normalizeEntry(item, clean);
    if (!entry || entry.path === clean || seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/* --------------------------------------------------------------- bytes -- */

function base64ToBuffer(b64: string): ArrayBuffer {
  const clean = b64.includes(',') && b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Read any storage file as raw bytes.
 *
 * Note: the `read` verb returns a human-formatted *text view* and refuses
 * binary types outright, so model files must come through the storage SDK's
 * arraybuffer path (or, failing that, the served URL).
 */
export async function readStorageBuffer(uriOrPath: string): Promise<ArrayBuffer> {
  const path = toStoragePath(uriOrPath);
  try {
    const data = await storage.read(path, { as: 'arraybuffer' });
    if (data instanceof ArrayBuffer && data.byteLength > 0) return data;
    if (data) return coerceToBuffer(data, path);
  } catch {
    /* fall through to the served URL */
  }
  const res = await fetch(storage.url(path));
  if (!res.ok) throw new Error(`Could not read "${path}" (HTTP ${res.status}).`);
  return await res.arrayBuffer();
}

function coerceToBuffer(data: unknown, path: string): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (typeof data === 'string') {
    // Binary files come back base64-encoded; text files come back as text.
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(data) && data.length > 64 && !/\s{2}/.test(data.slice(0, 64))) {
      try {
        return base64ToBuffer(data);
      } catch {
        /* fall through to text */
      }
    }
    return new TextEncoder().encode(data).buffer as ArrayBuffer;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const inner = obj.data ?? obj.content ?? obj.body;
    if (typeof inner === 'string') {
      if (obj.encoding === 'base64') return base64ToBuffer(inner);
      return coerceToBuffer(inner, path);
    }
    if (inner instanceof ArrayBuffer || ArrayBuffer.isView(inner)) return coerceToBuffer(inner, path);
    return new TextEncoder().encode(JSON.stringify(data)).buffer as ArrayBuffer;
  }
  throw new Error(`Could not read "${path}" as bytes.`);
}

/** Fetch a model over HTTP through the YAAR proxy. */
export async function fetchUrlBuffer(url: string): Promise<ArrayBuffer> {
  const res = await httpFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.arrayBuffer();
}

/* --------------------------------------------------------------- write -- */

function bufferToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Write a data: URL to shared storage (used for the PNG render). */
export async function writeDataUrl(path: string, dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const target = toStoragePath(path);
  await invoke(`yaar://storage/${target}`, {
    action: 'write',
    content: base64,
    encoding: 'base64',
  });
  return toStorageUri(target);
}

export async function writeBinary(path: string, bytes: Uint8Array): Promise<string> {
  const target = toStoragePath(path);
  await invoke(`yaar://storage/${target}`, {
    action: 'write',
    content: bufferToBase64(bytes),
    encoding: 'base64',
  });
  return toStorageUri(target);
}

/* ----------------------------------------------------- app-own storage -- */

export async function saveSceneJson(name: string, json: string): Promise<string> {
  const file = `${SCENES_DIR}/${sanitizeFileName(name)}.scene.json`;
  await appStorage.save(file, json);
  return file;
}

export async function listScenes(): Promise<string[]> {
  try {
    const entries = await appStorage.list(SCENES_DIR);
    return entries
      .filter((e) => !e.isDirectory && e.path.endsWith('.scene.json'))
      .map((e) => e.path);
  } catch {
    return [];
  }
}

export async function readSceneJson(path: string): Promise<string> {
  return await appStorage.read(path);
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/\.[^.]*$/, '')
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'scene'
  );
}

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
