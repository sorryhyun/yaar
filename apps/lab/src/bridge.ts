import { appStorage, storage, httpFetch } from '@bundled/yaar';
import { chartToPNG } from './chart';
import { saveChart, dataUrlToBlob } from './media';
import type { ChartSpec } from './types';

/**
 * Path rules for the kernel's `store` helper.
 *
 *   "notebooks/x.json"                  -> this app's private storage (default)
 *   "app:foo.csv"                       -> this app's private storage, explicit
 *   "media/lab/chart.png"               -> the shared media tree
 *   "yaar://storage/media/lab/x.png"    -> the shared tree, absolute
 *   "yaar://apps/self/storage/x.json"   -> this app's private storage, absolute
 */
export function resolvePath(raw: string): { shared: boolean; path: string } {
  let p = String(raw || '').trim();
  if (!p) throw new Error('store: empty path');
  if (p.startsWith('yaar://apps/self/storage/')) {
    return { shared: false, path: p.slice('yaar://apps/self/storage/'.length) };
  }
  if (p.startsWith('yaar://storage/')) {
    return { shared: true, path: p.slice('yaar://storage/'.length) };
  }
  if (p.startsWith('app:')) return { shared: false, path: p.slice(4) };
  if (p.startsWith('shared:')) return { shared: true, path: p.slice(7) };
  if (p.startsWith('media/')) return { shared: true, path: p };
  if (p.startsWith('/')) p = p.slice(1);
  return { shared: false, path: p };
}

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

async function doFetch(url: string, init: RequestInit | null): Promise<unknown> {
  const res = await httpFetch(url, init || undefined);
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, ok: res.ok, headers, body };
}

/** Dispatch one bridge call coming from the worker. */
export async function handleBridgeCall(method: string, args: unknown[]): Promise<unknown> {
  const a = args || [];
  switch (method) {
    case 'store.read':
      return await storeRead(a[0] as string);
    case 'store.write':
      return await storeWrite(a[0] as string, a[1] as string);
    case 'store.list':
      return await storeList(a[0] as string);
    case 'store.remove':
      return await storeRemove(a[0] as string);
    case 'store.exists':
      return await storeExists(a[0] as string);
    case 'http.fetch':
      return await doFetch(a[0] as string, a[1] as RequestInit | null);
    case 'chart.png':
      return await chartToPNG(a[0] as ChartSpec, (a[1] as Record<string, number>) || undefined);
    case 'chart.save':
      return await saveChart(a[0] as ChartSpec, (a[1] as string) || undefined, (a[2] as Record<string, number>) || undefined);
    default:
      throw new Error('unknown bridge method: ' + method);
  }
}
