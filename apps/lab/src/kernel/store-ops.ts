import { appStorage, storage } from '@bundled/yaar';
import { dataUrlToBlob } from '../lib/data-url';
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

export async function storeWrite(
  raw: string,
  content: string,
): Promise<{ path: string; resolved: string; bytes: number }> {
  const t = resolvePath(raw, 'write');
  const text = String(content);
  try {
    // A base64 data URL is written as real bytes, so `store.write(p, await plot.toPNG())`
    // produces a usable image rather than a text file full of base64.
    if (/^data:[^;,]*;base64,/.test(text)) {
      const b64 = text.slice(text.indexOf(',') + 1);
      if (t.shared) {
        const blob = dataUrlToBlob(text);
        await storage.save(t.path, blob);
        return { path: t.raw, resolved: t.display, bytes: blob.size };
      }
      await appStorage.save(t.path, b64, { encoding: 'base64' });
      return { path: t.raw, resolved: t.display, bytes: Math.floor((b64.length * 3) / 4) };
    }
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
