/**
 * Iframe-scoped token management.
 *
 * Tokens are generated when creating iframe windows and injected into the iframe SDK.
 * The server uses these tokens to identify iframe-originated requests and restrict
 * them to PUBLIC_ENDPOINTS only.
 */

import { join } from 'node:path';
import { isPreviewAppId, PREVIEW_APP_PREFIX } from '@yaar/shared';
import type { PermissionEntry } from './access.js';
import { getStorageDir } from '../config.js';
import { clearJar, jarKey } from '../features/http/cookie-jar.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The app's own namespace, granted to every app at mint time.
 *
 * A permission list exists to say what an app may reach *beyond itself*. These three
 * URIs are the app itself — `self` is resolved against the token's own appId
 * (`resolveSelf` in access.ts), so an entry here can never name another app no matter
 * what the iframe asks for. Declaring them in app.json was therefore a ritual that
 * could only be got wrong: an app that forgot `yaar://apps/self/db/` got a 403 from
 * `appDb` for a database only it can see.
 *
 * None of the three is the real gate on what it unlocks:
 * - `storage/` and `db/` are per-app subtrees on disk (`storage/apps/{appId}/`);
 *   reaching another app's needs that app's id in the URI, which `resolveSelf` never
 *   produces and the permission check still refuses.
 * - `agents/` is guarded twice over by the resource itself — `resolveScope` requires
 *   the URI's appId to equal the appId the *context* says the caller is, and spawning
 *   at all requires `"personas": { "max": N }` in the manifest, which `getAppMeta`
 *   honours outright for a bundled app and only as far as the user's install-time
 *   grant for an installed one. Watching them still needs `"streams": ["agents"]`,
 *   which answers to the same rule.
 *
 * Cross-app access is untouched: `yaar://apps/other/db/` in an app.json still means
 * what it meant, and still has to be written out.
 */
const SELF_GRANTS = [
  'yaar://apps/self/storage/',
  'yaar://apps/self/db/',
  'yaar://apps/self/agents/',
];

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
  /**
   * Streamable capabilities the app declared in app.json `streams` (e.g. `agents`).
   *
   * Bundled-only (getAppMeta gates it), and checked by the `/api/verb/subscribe`
   * gate before opening a `mode:'stream'` subscription to a sensitive source like
   * `yaar://agents/{id}/stream`. See requireStream() in access.ts.
   */
  streams?: string[];
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
  /** Streamable capabilities from app.json `streams`. See TokenEntry.streams. */
  streams?: string[];
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
  { appId, permissions, monitorId, systemApp, bundles, streams }: IframeTokenOptions = {},
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
    streams,
    createdAt: Date.now(),
    timer,
  });
  return token;
}

/**
 * Gated SDKs a devtools *preview* may use, read from the project's own app.json.
 *
 * A preview runs under a `preview--{projectId}` principal, which no `getAppMeta`
 * can resolve — the project is not installed yet, that is the point. So `bundles`
 * came back undefined and every gated door 403'd the preview, while the *deployed*
 * app sailed through: an app declaring `yaar-web` could only be tested after it
 * shipped. `openPreview` already forwards the project's `permissions`; this is the
 * same manifest field it could not forward, because `bundles` must not be
 * caller-supplied (any app could then mint itself `yaar-dev`). Reading it off disk
 * keeps it the project's declared identity rather than the request's claim.
 *
 * The compiler already honours this exact list when it builds the preview (see
 * `handleDevRoutes`), so a bundle that reaches the iframe is a bundle that was
 * declared. The preview principal is neither bundled nor system, so the sharper
 * guards — `canWriteApp`, `controls`, `streams` — still refuse it.
 */
export async function previewBundles(
  appId: string | undefined,
  storageRoot: string = getStorageDir(),
): Promise<string[] | undefined> {
  if (!isPreviewAppId(appId)) return undefined;
  const projectId = appId!.slice(PREVIEW_APP_PREFIX.length);
  // Reject anything that could climb out of the projects directory. Project ids are
  // timestamps in practice, but this string reaches a path join.
  if (!projectId || !/^[\w.-]+$/.test(projectId) || projectId.includes('..')) return undefined;
  try {
    const manifest = await Bun.file(
      join(storageRoot, 'apps', 'devtools', 'projects', projectId, 'app.json'),
    ).json();
    const bundles = (manifest as { bundles?: unknown }).bundles;
    return Array.isArray(bundles) ? bundles.filter((b) => typeof b === 'string') : undefined;
  } catch {
    return undefined; // no project, no app.json, or malformed — no bundles
  }
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

  // Auto-grant the app's own namespace (see SELF_GRANTS).
  if (appId) {
    for (const grant of SELF_GRANTS) {
      const held = permissions.some((p) => {
        const uri = typeof p === 'string' ? p : p.uri;
        return uri === grant || uri.startsWith(grant);
      });
      if (!held) permissions = [...permissions, grant];
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

  // systemApp, bundles and streams come from the app's own manifest, never from the
  // caller — they are the app's declared identity, not a property of the request
  // that mints the token.
  return generateIframeToken(windowId, sessionId, {
    appId,
    permissions,
    monitorId,
    systemApp: appMeta?.systemApp,
    bundles: appMeta?.bundles ?? (await previewBundles(appId)),
    streams: appMeta?.streams,
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
