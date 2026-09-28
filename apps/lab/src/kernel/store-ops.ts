import { appStorage, base64ToBytes, dataUrlToBlob, storage } from '@bundled/yaar';
import { resolvePath, type ResolvedPath } from './paths';

/**
 * The `store` helper's five operations, each routed to either this app's private
 * storage or the shared tree by resolvePath. Called only from bridge.ts.
 *
 * Every operation resolves through the same rules and reports failure the same way:
 * the message names the path it actually resolved to, and when that was app storage
 * it points at the URI form that reaches the shared tree instead.
 */

interface StoreEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

/** Report a backend failure against the resolved path rather than the raw string. */
function fail(op: string, t: ResolvedPath, err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  const hint = t.shared
    ? ''
    : ` Paths are this app's private storage by default — use 'yaar://storage/${t.path}' for shared storage.`;
  throw new Error(`store.${op} failed for '${t.display}' (${detail}).${hint}`);
}

/**
 * Normalise one listing entry. The shared backend has returned bare name strings in
 * some versions and entry objects in others; assuming either one crashed the whole
 * call (`n.endsWith is not a function`), so accept both.
 */
function toEntry(raw: unknown): StoreEntry {
  if (typeof raw === 'string') {
    const isDirectory = raw.endsWith('/');
    return { path: isDirectory ? raw.slice(0, -1) : raw, isDirectory };
  }
  const o = (raw || {}) as Record<string, unknown>;
  const name = String(o.path ?? o.name ?? '');
  const trailing = name.endsWith('/');
  const entry: StoreEntry = {
    path: trailing ? name.slice(0, -1) : name,
    isDirectory: typeof o.isDirectory === 'boolean' ? o.isDirectory : trailing,
  };
  if (typeof o.size === 'number') entry.size = o.size;
  if (typeof o.modifiedAt === 'string') entry.modifiedAt = o.modifiedAt;
  return entry;
}

export async function storeRead(raw: string): Promise<string> {
  const t = resolvePath(raw, 'read');
  try {
    if (!t.shared) return await appStorage.read(t.path);
    const v = await storage.read(t.path, { as: 'text' });
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch (e) {
    fail('read', t, e);
  }
}

/**
 * What a cell can hand `store.write` once the kernel has normalised it: text, or bytes
 * (the kernel turns every ArrayBuffer and typed array into a Uint8Array before the
 * bridge, and a Blob crosses as itself).
 */
export type WriteContent = string | Uint8Array | Blob;

/** `store.write`'s `encoding` option; `'base64'` means `content` is base64 text to decode. */
export type WriteEncoding = 'utf-8' | 'base64';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The bytes to write, or `null` for a text write. Three spellings reach bytes: a
 * Uint8Array or Blob, a base64 `data:` URL (so `store.write(p, await plot.toPNG())` is
 * an image rather than a text file full of base64), and a bare base64 string under
 * `encoding: 'base64'` — the one that used to land on disk as base64 characters.
 */
async function toBytes(
  content: WriteContent,
  encoding?: WriteEncoding,
): Promise<Uint8Array | null> {
  if (content instanceof Uint8Array) return content;
  if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
  if (/^data:[^;,]*;base64,/.test(content)) {
    return new Uint8Array(await dataUrlToBlob(content).arrayBuffer());
  }
  if (encoding !== 'base64') return null;
  try {
    return base64ToBytes(content);
  } catch {
    throw new Error("encoding 'base64' was given but the data is not valid base64");
  }
}

export async function storeWrite(
  raw: string,
  content: WriteContent,
  encoding?: WriteEncoding,
): Promise<{ path: string; resolved: string; bytes: number }> {
  const t = resolvePath(raw, 'write');
  try {
    const bytes = await toBytes(content, encoding);
    if (bytes) {
      if (t.shared) await storage.save(t.path, bytes);
      else await appStorage.save(t.path, bytesToBase64(bytes), { encoding: 'base64' });
      return { path: t.raw, resolved: t.display, bytes: bytes.byteLength };
    }
    const text = String(content);
    if (t.shared) await storage.save(t.path, text);
    else await appStorage.save(t.path, text);
    return { path: t.raw, resolved: t.display, bytes: text.length };
  } catch (e) {
    fail('write', t, e);
  }
}

export async function storeList(raw: string): Promise<StoreEntry[]> {
  const t = resolvePath(raw || '', 'list', { allowRoot: true });
  try {
    const entries = t.shared ? await storage.list(t.path) : await appStorage.list(t.path);
    return ((entries || []) as unknown[]).map(toEntry);
  } catch (e) {
    fail('list', t, e);
  }
}

export async function storeRemove(raw: string): Promise<{ ok: boolean; resolved: string }> {
  const t = resolvePath(raw, 'remove');
  try {
    if (t.shared) await storage.remove(t.path);
    else await appStorage.remove(t.path);
    return { ok: true, resolved: t.display };
  } catch (e) {
    fail('remove', t, e);
  }
}

export async function storeExists(raw: string): Promise<boolean> {
  // Resolve outside the try: a malformed path is a caller error and must still throw,
  // rather than being reported as "the file is not there".
  resolvePath(raw, 'exists');
  try {
    await storeRead(raw);
    return true;
  } catch {
    return false;
  }
}
