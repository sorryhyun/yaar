// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Importable SDK for @bundled/yaar.
 *
 * Thin wrapper around the `window.yaar` global (injected by the verb SDK script).
 * Provides auto-parsed helpers so apps don't need to manually extract text and
 * JSON from `YaarVerbResult` objects.
 *
 * Usage:
 *   import { readJson, config, storage } from '@bundled/yaar';
 *   const settings = await readJson<Settings>('yaar://config/settings');
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const y = (window as any).yaar;

// ── Helpers ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function text(result: any): string {
  return result?.content?.[0]?.text ?? '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function json<T>(result: any): T {
  const t = text(result);
  return t ? JSON.parse(t) : undefined;
}

// ── Auto-parsed verb helpers ─────────────────────────────────────

export async function readJson<T = unknown>(uri: string): Promise<T> {
  return json<T>(await y.read(uri));
}

export async function readText(uri: string): Promise<string> {
  return text(await y.read(uri));
}

export async function invokeJson<T = unknown>(
  uri: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  return json<T>(await y.invoke(uri, payload));
}

export async function invokeText(uri: string, payload?: Record<string, unknown>): Promise<string> {
  return text(await y.invoke(uri, payload));
}

export async function listJson<T = unknown>(uri: string): Promise<T> {
  return json<T>(await y.list(uri));
}

export async function listText(uri: string): Promise<string> {
  return text(await y.list(uri));
}

export async function deleteText(uri: string): Promise<string> {
  return text(await y.delete(uri));
}

// ── App-scoped storage ──────────────────────────────────────────

function appStorageUri(path: string): string {
  const clean = path.replace(/^\//, '');
  return clean ? `yaar://apps/self/storage/${clean}` : 'yaar://apps/self/storage/';
}

export const appStorage = {
  async save(
    path: string,
    content: string,
    options?: { encoding?: 'utf-8' | 'base64' },
  ): Promise<void> {
    const payload: Record<string, unknown> = { action: 'write', content };
    if (options?.encoding) payload.encoding = options.encoding;
    const result = await y.invoke(appStorageUri(path), payload);
    if (result?.isError) throw new Error(text(result) || 'Save failed');
  },
  async read(path: string): Promise<string> {
    const result = await y.read(appStorageUri(path));
    if (result?.isError) throw new Error(text(result) || 'Read failed');
    return text(result);
  },
  async readJson<T = unknown>(path: string): Promise<T> {
    const raw = await appStorage.read(path);
    return JSON.parse(raw);
  },
  async readBinary(path: string): Promise<{ data: string; mimeType: string }> {
    const result = await y.read(appStorageUri(path));
    if (result?.isError) throw new Error(text(result) || 'Read failed');
    const items = result?.content ?? [];
    const img = items.find((c: any) => c?.type === 'image' && c.data);
    if (img) return { data: img.data, mimeType: img.mimeType ?? 'application/octet-stream' };
    // Fallback: text content is the base64 data itself
    return { data: text(result), mimeType: 'application/octet-stream' };
  },
  async list(dirPath?: string): Promise<unknown[]> {
    const result = await y.list(appStorageUri(dirPath ?? ''));
    if (result?.isError) return [];
    return json(result) ?? [];
  },
  async remove(path: string): Promise<void> {
    const result = await y.delete(appStorageUri(path));
    if (result?.isError) throw new Error(text(result) || 'Remove failed');
  },
};

// ── Sub-object re-exports ────────────────────────────────────────

export const storage = y.storage;
export const app = y.app;
export const notifications = y.notifications;
export const windows = y.windows;

// ── Raw verb passthrough ─────────────────────────────────────────

export const invoke = y.invoke.bind(y);
export const read = y.read.bind(y);
export const list = y.list.bind(y);
export const describe = y.describe.bind(y);
export const del = y.delete.bind(y);
export const subscribe = y.subscribe.bind(y);

// ── Dev tools (compile, typecheck, deploy) ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function devHeaders(): Record<string, string> {
  const t = (window as any).__YAAR_TOKEN__ || '';
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['X-Iframe-Token'] = t;
  return h;
}

async function devPost<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/dev/${action}`, {
    method: 'POST',
    headers: devHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export const dev = {
  compile(path: string, opts?: { title?: string }) {
    return devPost<{ success: boolean; previewUrl?: string; errors?: string[] }>('compile', {
      path,
      ...opts,
    });
  },
  typecheck(path: string) {
    return devPost<{ success: boolean; diagnostics: string[] }>('typecheck', { path });
  },
  deploy(
    path: string,
    opts: {
      appId: string;
      name?: string;
      icon?: string;
      description?: string;
      permissions?: string[];
    },
  ) {
    return devPost<{
      success: boolean;
      appId?: string;
      name?: string;
      icon?: string;
      error?: string;
    }>('deploy', { path, ...opts });
  },
  async bundledLibraries(): Promise<string[]> {
    const res = await fetch('/api/dev/bundled-libraries', { headers: devHeaders() });
    return res.json();
  },
};

// ── Timing utilities ────────────────────────────────────────────

/** Returns a promise that resolves after `ms` milliseconds. */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Default export: the raw global ───────────────────────────────

export const yaar = y;
export default y;
