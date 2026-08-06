/**
 * Iframe-scoped token management.
 *
 * Tokens are generated when creating iframe windows and injected into the iframe SDK.
 * The server uses these tokens to identify iframe-originated requests and restrict
 * them to PUBLIC_ENDPOINTS only.
 *
 * ── A token is identity, not authority ──
 *
 * What a token carries is *who this iframe is*: its window, its session, its monitor,
 * and what its own manifest declares (`permissions`, `systemApp`, `bundles`, `streams`).
 * What a caller granted **to this window** at runtime — a file an agent named to it, the
 * document it was told to render, permissions a privileged caller added on top — is not
 * here. It lives on `WindowStateRegistry` (see its `delegatedGrants`) and is read per
 * request at the access gate.
 *
 * The reason is that a token is not durable and a window is: every reconnect re-mints one
 * per open iframe window, per connection, from identity alone. Authority baked in at mint
 * time therefore vanishes on the first page refresh — which is exactly what made devtools
 * previews 403 on their own document after a reload. Identity is re-mintable at will;
 * authority survives remount and dies with the window.
 *
 * ── Several live tokens per window is the design ──
 *
 * Two tabs on one session each hold their own token for the same window, and a re-mint
 * deliberately does not revoke its predecessor — the other tab is still showing that
 * window. What must not happen is a token outliving the window it is a credential for,
 * which is what `revokeTokensForWindow` (wired into the close pipeline in
 * `LiveSession`) is for. The 24h TTL remains the backstop for windows that never see a
 * clean close.
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

/**
 * Every live token for one window, so a close can revoke all of them at once.
 *
 * Scoped by monitor as well as session, because a raw window id repeats across monitors
 * — the same app open on two of them mints two tokens both spelled `memo`, and closing
 * one window must not revoke the other window's credential.
 */
const tokensByWindow = new Map<string, Set<string>>();

function windowIndexKey(sessionId: string, windowId: string, monitorId?: string): string {
  return `${sessionId}::${monitorId ?? ''}::${windowId}`;
}

/**
 * Drop the app's cookie jar only once nothing is left holding it.
 *
 * The jar is keyed by (session, app), not by window, so an app with two windows open
 * shares one. Clearing it whenever *a* token dies was harmless while the only caller was
 * the 24h TTL; with revocation wired to window close it would log the app's other window
 * out of whatever it had fetched.
 */
function clearJarIfOrphaned(entry: TokenEntry): void {
  for (const other of tokens.values()) {
    if (other.sessionId === entry.sessionId && other.appId === entry.appId) return;
  }
  clearJar(jarKey(entry.sessionId, entry.appId));
}

/** Remove one token from every structure that holds it. The single teardown path. */
function forgetToken(token: string, entry: TokenEntry): void {
  clearTimeout(entry.timer);
  tokens.delete(token);
  const key = windowIndexKey(entry.sessionId, entry.windowId, entry.monitorId);
  const live = tokensByWindow.get(key);
  if (live) {
    live.delete(token);
    if (live.size === 0) tokensByWindow.delete(key);
  }
  clearJarIfOrphaned(entry);
}

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
    if (entry) forgetToken(token, entry);
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
  const key = windowIndexKey(sessionId, windowId, monitorId);
  let live = tokensByWindow.get(key);
  if (!live) {
    live = new Set();
    tokensByWindow.set(key, live);
  }
  live.add(token);
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
 * `handleDevRoutes`, which reads the same `bundles` key off the same file — by a
 * caller-relative path, since a compile names its own source directory and a mint
 * only has `preview--{projectId}` to go on). The two readings must agree: a bundle
 * that reaches the iframe is a bundle that was declared. The preview principal is
 * neither bundled nor system, so the sharper guards — `canWriteApp`, `controls`,
 * `streams` — still refuse it.
 *
 * Returning `undefined` is ordinary on three of the five paths — not a preview at
 * all (most calls), the project declares no bundles, the project is gone — so those
 * are silent. The two that are *not* ordinary say so: a project id that would climb
 * out of the directory, and a manifest that exists and will not parse. Without those
 * two lines a devtools layout change or a broken app.json surfaces only as a 403
 * from a gated door nowhere near here.
 */
export async function previewBundles(
  appId: string | undefined,
  storageRoot: string = getStorageDir(),
): Promise<string[] | undefined> {
  if (!isPreviewAppId(appId)) return undefined;
  const projectId = appId!.slice(PREVIEW_APP_PREFIX.length);
  // Reject anything that could climb out of the projects directory. Project ids are
  // timestamps in practice, but this string reaches a path join.
  if (!projectId || !/^[\w.-]+$/.test(projectId) || projectId.includes('..')) {
    console.warn(
      `[IframeToken] Refusing preview project id ${JSON.stringify(projectId.slice(0, 80))}: not a bare id.`,
    );
    return undefined;
  }
  const manifestPath = join(storageRoot, 'apps', 'devtools', 'projects', projectId, 'app.json');
  let manifest: unknown;
  try {
    manifest = await Bun.file(manifestPath).json();
  } catch (err) {
    // A project with no app.json is ordinary: devtools deletes projects, and a preview
    // window can outlive the project it previews. A file that is *there* and unreadable
    // is not — that is a broken manifest or a moved layout.
    if (await Bun.file(manifestPath).exists()) {
      console.warn(
        `[IframeToken] Preview manifest unreadable at ${manifestPath} — granting no bundles: ${String(err)}`,
      );
    }
    return undefined;
  }
  const bundles = (manifest as { bundles?: unknown }).bundles;
  return Array.isArray(bundles) ? bundles.filter((b) => typeof b === 'string') : undefined;
}

/**
 * Generate an iframe token with automatic app metadata resolution.
 * Consolidates the repeated pattern of: getAppMeta -> extract permissions -> generateIframeToken.
 */
export async function generateAppIframeToken(
  windowId: string,
  sessionId: string,
  { appId, permissions: explicitPermissions, monitorId }: IframeTokenOptions = {},
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

  // The document this iframe was told to render, and any permissions a privileged
  // caller added on top, used to be folded in here. They are window-scoped authority,
  // not identity, so they now live on `WindowStateRegistry` and are read per request at
  // the access gate — see this file's header, and `features/window/create.ts` for the
  // producers. Nothing is left for a re-mint to forget.

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
    forgetToken(token, entry);
    return null;
  }
  return entry;
}

/**
 * Revoke every token out for one window — the close pipeline's call.
 *
 * A window closing is the end of the thing its tokens are credentials *for*, and every
 * other trace of it (delegated grants, app commands, subscriptions, the context tape, the
 * app agent) is already dropped at that point. Without this the token stayed valid, with
 * the same appId and the same permissions, for the remainder of its 24h TTL.
 *
 * **Both id spellings must be revoked, and that is the caller's job**: a token minted by
 * `window.create` is keyed by the raw id, one minted by restore or a reconnect by the
 * monitor-scoped handle, and this module deliberately does not know how to parse a handle
 * (`WindowHandleMap` owns that format). `LiveSession` calls this once per spelling.
 *
 * Returns how many tokens were revoked.
 */
export function revokeTokensForWindow(
  sessionId: string,
  windowId: string,
  monitorId?: string,
): number {
  const live = tokensByWindow.get(windowIndexKey(sessionId, windowId, monitorId));
  if (!live) return 0;
  let revoked = 0;
  for (const token of [...live]) {
    const entry = tokens.get(token);
    if (!entry) continue;
    forgetToken(token, entry);
    revoked++;
  }
  return revoked;
}
