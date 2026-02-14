/**
 * Centralized API client for remote mode support.
 *
 * In local mode (default), all requests go to the same origin.
 * In remote mode, requests are directed to a remote server with token auth.
 */

const STORAGE_KEY = 'yaar-remote-connection';

export interface RemoteConnection {
  serverUrl: string;
  token: string;
}

/** Get saved remote connection from localStorage. */
export function getRemoteConnection(): RemoteConnection | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed?.serverUrl && parsed?.token) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Save remote connection to localStorage. */
export function setRemoteConnection(conn: RemoteConnection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
}

/** Clear saved remote connection. */
export function clearRemoteConnection(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Parse connection from URL hash fragment (#remote=<token>). */
export function parseHashConnection(): RemoteConnection | null {
  const hash = window.location.hash;
  const match = hash.match(/^#remote=(.+)$/);
  if (!match) return null;

  const token = match[1];
  // When using hash connection, the current page URL IS the server
  // (user navigated to http://server:port/#remote=token)
  const serverUrl = window.location.origin;
  return { serverUrl, token };
}

/** Check if we're in remote mode. */
export function isRemoteMode(): boolean {
  return getRemoteConnection() !== null;
}

/**
 * Fetch wrapper that adds remote auth when needed.
 * In local mode, behaves like regular fetch.
 * In remote mode, prepends server URL and adds Authorization header.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const conn = getRemoteConnection();
  if (!conn) return fetch(path, init);

  const url = `${conn.serverUrl}${path}`;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${conn.token}`);
  return fetch(url, { ...init, headers });
}

/**
 * Build WebSocket URL with optional session ID.
 * In local mode, uses current host.
 * In remote mode, uses remote server URL with token param.
 */
export function buildWsUrl(sessionId?: string | null): string {
  const conn = getRemoteConnection();

  let base: string;
  if (conn) {
    // Remote mode: convert http(s) to ws(s)
    const serverUrl = conn.serverUrl.replace(/^http/, 'ws');
    base = `${serverUrl}/ws`;
  } else {
    // Local mode: derive from current page
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${protocol}//${window.location.host}/ws`;
  }

  const url = new URL(base);
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (conn) url.searchParams.set('token', conn.token);
  return url.toString();
}

/**
 * Resolve asset URLs for remote mode.
 * - Absolute URLs (http://, https://, data:, blob:) pass through.
 * - Relative paths (/api/...) get prepended with server URL + token.
 */
export function resolveAssetUrl(path: string): string {
  if (!path) return path;
  // Pass through absolute URLs and data/blob URLs
  if (/^(https?:|data:|blob:)/i.test(path)) return path;

  const conn = getRemoteConnection();
  if (!conn) return path;

  // Relative path -- prepend server URL and add token
  const url = new URL(path, conn.serverUrl);
  url.searchParams.set('token', conn.token);
  return url.toString();
}
