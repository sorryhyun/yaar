/**
 * Iframe-scoped token management.
 *
 * Tokens are generated when creating iframe windows and injected into the iframe SDK.
 * The server uses these tokens to identify iframe-originated requests and restrict
 * them to PUBLIC_ENDPOINTS only.
 */

import type { PermissionEntry } from './routes/verb.js';
import { clearJar, jarKey } from '../features/http/cookie-jar.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TokenEntry {
  windowId: string;
  sessionId: string;
  appId?: string;
  permissions?: PermissionEntry[];
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const tokens = new Map<string, TokenEntry>();

/**
 * Generate a short-lived token tied to a windowId.
 * The token is injected into the iframe SDK so requests can self-identify.
 */
export function generateIframeToken(
  windowId: string,
  sessionId: string,
  appId?: string,
  permissions?: PermissionEntry[],
): string {
  const token = crypto.randomUUID();
  const timer = setTimeout(() => {
    const entry = tokens.get(token);
    if (entry) clearJar(jarKey(entry.sessionId, entry.appId));
    tokens.delete(token);
  }, TOKEN_TTL_MS);
  tokens.set(token, { windowId, sessionId, appId, permissions, createdAt: Date.now(), timer });
  return token;
}

/**
 * Generate an iframe token with automatic app metadata resolution.
 * Consolidates the repeated pattern of: getAppMeta -> extract permissions -> generateIframeToken.
 */
export async function generateAppIframeToken(
  windowId: string,
  sessionId: string,
  appId?: string,
  explicitPermissions?: PermissionEntry[],
): Promise<string> {
  const { getAppMeta } = await import('../features/apps/discovery.js');
  const appMeta = appId ? await getAppMeta(appId) : null;
  let permissions = explicitPermissions ?? appMeta?.permissions ?? [];

  // Auto-grant app-scoped storage access — every app can read/write its own storage
  if (appId) {
    const selfStorageUri = 'yaar://apps/self/storage/';
    const hasStoragePerm = permissions.some((p) => {
      const uri = typeof p === 'string' ? p : p.uri;
      return uri === selfStorageUri || uri.startsWith(selfStorageUri);
    });
    if (!hasStoragePerm) {
      permissions = [...permissions, selfStorageUri];
    }
  }

  return generateIframeToken(windowId, sessionId, appId, permissions);
}

/**
 * Validate an iframe token.
 * Returns the associated token entry if valid, null if expired/invalid.
 */
export function validateIframeToken(token: string): TokenEntry | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    clearTimeout(entry.timer);
    clearJar(jarKey(entry.sessionId, entry.appId));
    tokens.delete(token);
    return null;
  }
  return entry;
}

/**
 * Revoke a token (e.g., when a window is closed).
 */
export function revokeIframeToken(token: string): void {
  const entry = tokens.get(token);
  if (entry) {
    clearTimeout(entry.timer);
    clearJar(jarKey(entry.sessionId, entry.appId));
    tokens.delete(token);
  }
}
