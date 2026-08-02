import { appStorage, storage } from '@bundled/yaar';
import { dataUrlToBlob } from '../lib/data-url';
import { resolvePath } from './paths';

/**
 * The `store` helper's five operations, each routed to either this app's private
 * storage or the shared tree by resolvePath. Called only from bridge.ts.
 */

export async function storeRead(raw: string): Promise<string> {
  const { shared, path } = resolvePath(raw);
  if (!shared) return await appStorage.read(path);
  const v = await storage.read(path, { as: 'text' });
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export async function storeWrite(raw: string, content: string): Promise<{ path: string; bytes: number }> {
  const { shared, path } = resolvePath(raw);
  const text = String(content);
  // A base64 data URL is written as real bytes, so `store.write(p, await plot.toPNG())`
  // produces a usable image rather than a text file full of base64.
  if (/^data:[^;,]*;base64,/.test(text)) {
    const b64 = text.slice(text.indexOf(',') + 1);
    if (shared) {
      const blob = dataUrlToBlob(text);
      await storage.save(path, blob);
      return { path: raw, bytes: blob.size };
    }
    await appStorage.save(path, b64, { encoding: 'base64' });
    return { path: raw, bytes: Math.floor((b64.length * 3) / 4) };
  }
  if (shared) await storage.save(path, text);
  else await appStorage.save(path, text);
  return { path: raw, bytes: text.length };
}

export async function storeList(raw: string): Promise<unknown[]> {
  const { shared, path } = resolvePath(raw || 'x');
  const dir = raw ? path : '';
  if (shared) {
    const names = await storage.list(dir);
    return (names || []).map((n) => ({ path: n, isDirectory: n.endsWith('/') }));
  }
  const entries = await appStorage.list(dir);
  return (entries || []).map((e) => ({
    path: e.path,
    isDirectory: e.isDirectory,
    size: e.size,
    modifiedAt: e.modifiedAt,
  }));
}

export async function storeRemove(raw: string): Promise<{ ok: boolean }> {
  const { shared, path } = resolvePath(raw);
  if (shared) await storage.remove(path);
  else await appStorage.remove(path);
  return { ok: true };
}

export async function storeExists(raw: string): Promise<boolean> {
  try {
    await storeRead(raw);
    return true;
  } catch {
    return false;
  }
}
