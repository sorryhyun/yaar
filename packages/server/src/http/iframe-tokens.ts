/**
 * Iframe-scoped token management.
 *
 * Tokens are generated when creating iframe windows and injected into the iframe SDK.
 * The server uses these tokens to identify iframe-originated requests and restrict
 * them to PUBLIC_ENDPOINTS only.
 */

import type { PermissionEntry } from './access.js';
import { clearJar, jarKey } from '../features/http/cookie-jar.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TokenEntry {
  windowId: string;
  sessionId: string;
  appId?: string;
  /**
   * The monitor this iframe's window lives on, pinned at mint time.
   *
   * Everything the iframe does through POST /api/verb acts on this monitor. Deriving
   * it later from the windowId cannot be trusted: window IDs are only unique within a
   * monitor, so the same app open on two monitors makes a raw-ID lookup ambiguous, and
   * an ambiguous lookup yields no monitor at all — which is how an app-created window
   * ended up with an unscoped key. The monitor is known when the window is created;
   * record it then.
   */
  monitorId?: string;
  permissions?: PermissionEntry[];
  /** Bundled `kind: "system"` app — may reach yaar://session/* (see http/access.ts). */
  systemApp?: boolean;
  /**
   * Gated SDKs the app declared in app.json `bundles` (yaar-dev / yaar-web / yaar-ml).
   *
   * The compiler refuses to bundle those SDKs without the declaration, but that only
   * constrains the app's *source*. The HTTP doors they open (`/api/dev/*`,
   * `/api/browser`, `/api/bridge`, `/api/ml-*`) are reachable by any `fetch()`, so
   * they check this list themselves — see requireBundle() in access.ts.
   */
  bundles?: string[];
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const tokens = new Map<string, TokenEntry>();

/** Identity carried by an iframe token, beyond the window and session it belongs to. */
export interface IframeTokenOptions {
  appId?: string;
  permissions?: PermissionEntry[];
  /** Monitor the window lives on. See TokenEntry.monitorId. */
  monitorId?: string;
  systemApp?: boolean;
  /** Gated SDKs from app.json `bundles`. See TokenEntry.bundles. */
  bundles?: string[];
  /**
   * The `yaar://` URI of the document this iframe was told to render, if it is
   * one storage serves. Auto-granted `read`. See generateAppIframeToken.
   */
  documentUri?: string;
}

/**
 * Generate a short-lived token tied to a windowId.
 * The token is injected into the iframe SDK so requests can self-identify.
 */
export function generateIframeToken(
  windowId: string,
  sessionId: string,
  { appId, permissions, monitorId, systemApp, bundles }: IframeTokenOptions = {},
): string {
  const token = crypto.randomUUID();
  const timer = setTimeout(() => {
    const entry = tokens.get(token);
    if (entry) clearJar(jarKey(entry.sessionId, entry.appId));
    tokens.delete(token);
  }, TOKEN_TTL_MS);
  tokens.set(token, {
    windowId,
    sessionId,
    appId,
    monitorId,
    permissions,
    systemApp,
    bundles,
    createdAt: Date.now(),
    timer,
  });
  return token;
}

/**
 * Generate an iframe token with automatic app metadata resolution.
 * Consolidates the repeated pattern of: getAppMeta -> extract permissions -> generateIframeToken.
 */
export async function generateAppIframeToken(
  windowId: string,
  sessionId: string,
  { appId, permissions: explicitPermissions, monitorId, documentUri }: IframeTokenOptions = {},
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

  // An iframe may always read the document it was told to render. The window's
  // content URL is chosen by the server, not the iframe, and the browser fetches
  // it under this very token — so without this the gate can deny a window the one
  // file it exists to display. It did: devtools previews are served out of
  // *devtools'* storage (`/api/storage/apps/devtools/projects/{id}/dist/…`) while
  // the preview window runs under a `preview--{id}` principal of its own, which
  // holds no permission there. Every preview 403'd on its own document.
  //
  // Narrow on purpose: this exact file, `read` only. It grants no prefix, so it
  // cannot become a foothold in the storage namespace that happens to host it.
  if (
    documentUri &&
    !permissions.some((p) => (typeof p === 'string' ? p : p.uri) === documentUri)
  ) {
    permissions = [...permissions, { uri: documentUri, verbs: ['read'] }];
  }

  // systemApp and bundles come from the app's own manifest, never from the caller —
  // they are the app's declared identity, not a property of the request that mints
  // the token.
  return generateIframeToken(windowId, sessionId, {
    appId,
    permissions,
    monitorId,
    systemApp: appMeta?.systemApp,
    bundles: appMeta?.bundles,
  });
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
