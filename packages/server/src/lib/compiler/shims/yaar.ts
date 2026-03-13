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

// ── Default export: the raw global ───────────────────────────────

export const yaar = y;
export default y;
