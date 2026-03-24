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

// ── Aliases (backwards-compat) ───────────────────────────────────

export const readJson = read;
export const readText = async (uri: string): Promise<string> => asText(await y.read(uri));
export const invokeJson = invoke;
export const invokeText = async (uri: string, payload?: Record<string, unknown>): Promise<string> =>
  asText(await y.invoke(uri, payload));
export const listJson = list;
export const listText = async (uri: string): Promise<string> => asText(await y.list(uri));
export const describeJson = describe;
export const deleteText = async (uri: string): Promise<string> => asText(await y.delete(uri));

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
    await y.invoke(appStorageUri(path), payload);
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
  async readBinary(path: string): Promise<{ data: string; mimeType: string }> {
    const result = await y.read(appStorageUri(path));
    // When images are present, callVerb returns { data, images }
    if (result && typeof result === 'object' && result.images?.length) {
      const img = result.images[0];
      return { data: img.data, mimeType: img.mimeType ?? 'application/octet-stream' };
    }
    return { data: asText(result), mimeType: 'application/octet-stream' };
  },
  /** Read binary data and return as a Blob. Handles the base64 → binary conversion. */
  async readBlob(path: string): Promise<Blob> {
    const { data, mimeType } = await appStorage.readBinary(path);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: mimeType });
  },
  async list(dirPath?: string): Promise<unknown[]> {
    const result = await y.list(appStorageUri(dirPath ?? ''));
    return Array.isArray(result) ? result : [];
  },
  async remove(path: string): Promise<void> {
    await y.delete(appStorageUri(path));
  },
};

// ── Sub-object re-exports ────────────────────────────────────────

export const storage = y.storage;
export const app = y.app;
export const notifications = y.notifications;
export const windows = y.windows;

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

// ── Utilities ───────────────────────────────────────────────────

/** Returns a promise that resolves after `ms` milliseconds. */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Extract a human-readable message from any thrown value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

// ── Default export: the raw global ───────────────────────────────

export const yaar = y;
export default y;
