/**
 * The access chokepoint.
 *
 * Every HTTP route that reaches a real resource resolves its caller to a
 * `Principal` here and asks this module whether that principal may perform a
 * verb on a `yaar://` URI. The verb layer already had this model — declared
 * `permissions[]`, `self` resolution, the session-principal gate — but only
 * `POST /api/verb` went through it. The REST routes reached the same storage,
 * the same config, and the same session logs with no check at all.
 *
 * So the rule is: routes do not invent their own checks. They name the URI and
 * the verb they are about to perform, and call `requirePermission`.
 *
 * ── What a principal is ──
 *
 * `host`  — the desktop UI itself (or the local user with curl). Full access.
 *           In REMOTE mode it has already proven the remote token in auth.ts.
 * `app`   — an iframe app, identified by its iframe token. Confined to the
 *           permissions its app.json declares, plus its own app storage.
 *
 * ── The boundary this does NOT enforce ──
 *
 * App iframes are served same-origin and unsandboxed (IframeRenderer.tsx: "for
 * same-origin content (local apps), don't sandbox - it's trusted"). A *hostile*
 * app can therefore decline to send its token and be resolved as `host`, spoof
 * `Referer`, or reach `window.parent` directly. No header-based principal can
 * close that; it needs an origin boundary. Tracked as F-23 in plan.md.
 *
 * What this module does buy, today: a network caller cannot reach these routes
 * at all (auth.ts), an app that behaves like an app is confined to what it
 * declared, cross-app and cross-session reads are refused, and a compromised
 * app can no longer flip global switches like `allowAllDomains` by accident.
 */

import type { Verb } from '../handlers/uri-registry.js';
import { validateIframeToken } from './iframe-tokens.js';
import { errorResponse } from './utils.js';

/**
 * A permission entry is either:
 * - a URI prefix string (allows all verbs), or
 * - an object with `uri` and optional `verbs` array (restricts to listed verbs).
 */
export type PermissionEntry = string | { uri: string; verbs?: Verb[] };

/** The desktop itself. Not confined — it is the user. */
interface HostPrincipal {
  kind: 'host';
}

/** An iframe app, confined to the permissions its app.json declares. */
interface AppPrincipal {
  kind: 'app';
  /** Absent for a plain (non-app) iframe window — it gets no permissions at all. */
  appId?: string;
  sessionId: string;
  windowId: string;
  monitorId?: string;
  permissions: PermissionEntry[];
  /** Bundled `kind: "system"` app — may reach yaar://session/*. */
  systemApp: boolean;
  /** Gated SDKs declared in app.json `bundles` (yaar-dev / yaar-web / yaar-ml). */
  bundles: string[];
  /** The raw token, for callers that need to key subscriptions by it. */
  token: string;
}

export type Principal = HostPrincipal | AppPrincipal;

/** Apps that declare nothing get nothing. */
const NO_PERMISSIONS: PermissionEntry[] = [];

// ── Resolving the caller ────────────────────────────────────────────────────

/**
 * Find the iframe token a request is presenting, if any.
 *
 * The header is what the SDK sends. The query parameter is how a *subresource*
 * carries it — an `<img src="/api/storage/…">` inside an app cannot set headers,
 * and IframeRenderer already appends `__yaar_token` to the iframe's own URL, so
 * the same parameter works on asset URLs the app builds.
 */
function extractIframeToken(req: Request, url: URL): string | null {
  return req.headers.get('x-iframe-token') ?? url.searchParams.get('__yaar_token');
}

/**
 * Resolve the caller of a request to a principal.
 *
 * A request that presents *no* token is the host. A request that presents a
 * token gets that token's identity — and a token that is invalid or expired is
 * refused outright. It used to fall through to "treat as host", which meant an
 * app whose token had merely expired silently gained full access instead of
 * losing it.
 */
export function resolvePrincipal(req: Request, url: URL): Principal | Response {
  const token = extractIframeToken(req, url);
  if (!token) return { kind: 'host' };

  const entry = validateIframeToken(token);
  if (!entry) return errorResponse('Invalid or expired iframe token', 403);

  return {
    kind: 'app',
    appId: entry.appId,
    sessionId: entry.sessionId,
    windowId: entry.windowId,
    monitorId: entry.monitorId,
    permissions: entry.permissions ?? NO_PERMISSIONS,
    systemApp: entry.systemApp ?? false,
    bundles: entry.bundles ?? [],
    token,
  };
}

// ── Matching a URI against declared permissions ─────────────────────────────

/** Check if a single permission entry matches the URI. */
function uriMatches(uri: string, pattern: string): boolean {
  return (
    uri === pattern || (pattern.endsWith('/') && (uri.startsWith(pattern) || uri + '/' === pattern))
  );
}

/** Check if a URI + verb is allowed by the given permission entries. */
export function isUriAllowed(uri: string, verb: Verb, entries: PermissionEntry[]): boolean {
  return entries.some((entry) => {
    if (typeof entry === 'string') {
      return uriMatches(uri, entry); // string entry → all verbs allowed
    }
    return uriMatches(uri, entry.uri) && (!entry.verbs || entry.verbs.includes(verb));
  });
}

/** Is this the session principal's private namespace? */
function isSessionUri(uri: string): boolean {
  return uri === 'yaar://session' || uri.startsWith('yaar://session/');
}

/**
 * Rewrite `yaar://apps/self/…` to the calling app's real id.
 *
 * Applied to *both* sides of the match — the URI being requested and the app's
 * declared permissions — because the two are not written in the same dialect. An
 * app.json says `yaar://apps/self/storage/`; a storage URI derived from an HTTP path
 * says `yaar://apps/notes/storage/todo.json`. Matching those literally denies an app
 * its own storage. Canonicalizing both means either spelling works and they agree.
 */
function resolveSelf(uri: string, appId?: string): string {
  if (!appId) return uri;
  if (uri === 'yaar://apps/self') return `yaar://apps/${appId}`;
  if (uri.startsWith('yaar://apps/self/')) {
    return uri.replace('yaar://apps/self/', `yaar://apps/${appId}/`);
  }
  return uri;
}

// ── The gates ───────────────────────────────────────────────────────────────

/**
 * May `principal` perform `verb` on `uri`? Returns a 403 Response if not.
 *
 * `describe` is metadata-only (it reveals a handler's schema, not its data), so
 * it bypasses the permission list — matching the verb endpoint's existing rule.
 */
export function requirePermission(principal: Principal, uri: string, verb: Verb): Response | null {
  if (principal.kind === 'host') return null;

  // Non-self-grant: yaar://session/* is the session principal's private namespace.
  // A marketplace app cannot self-grant it by declaring it in app.json — the only
  // apps that get through are bundled `kind: "system"` ones, which ship with the
  // repo and still need the URI in their permissions list.
  if (isSessionUri(uri) && !principal.systemApp) {
    return errorResponse('yaar://session/* is restricted to the session agent', 403);
  }

  const target = resolveSelf(uri, principal.appId);
  const granted = principal.permissions.map((entry) =>
    typeof entry === 'string'
      ? resolveSelf(entry, principal.appId)
      : { ...entry, uri: resolveSelf(entry.uri, principal.appId) },
  );

  if (verb !== 'describe' && !isUriAllowed(target, verb, granted)) {
    return errorResponse(`Not permitted: ${verb} ${uri}`, 403);
  }

  return null;
}

/**
 * Restrict a route to the desktop itself.
 *
 * For routes that are not resources an app could ever hold a permission for —
 * minting an iframe token, opening a native directory picker, restoring a
 * session. There is no URI to name, so there is nothing to declare.
 */
export function requireHost(principal: Principal): Response | null {
  if (principal.kind === 'host') return null;
  return errorResponse('Not available to app iframes', 403);
}

/**
 * Require that an app declared a gated SDK in its app.json `bundles`.
 *
 * The compiler refuses to bundle `@bundled/yaar-dev` et al without this
 * declaration, but that is a *compile-time* check on the app's source — it says
 * nothing about what a hand-written `fetch()` can reach at runtime. The doors
 * those SDKs open (`/api/dev/*`, `/api/browser`, `/api/bridge`, `/api/ml-*`)
 * have to check for themselves.
 */
export function requireBundle(principal: Principal, bundle: string): Response | null {
  if (principal.kind === 'host') return null;
  if (principal.bundles.includes(bundle)) return null;
  return errorResponse(
    `"${bundle}" must be declared in app.json "bundles" to use this endpoint`,
    403,
  );
}

// ── URI construction for the storage routes ─────────────────────────────────

/**
 * Map a `/api/storage/{path}` request to the `yaar://` URI that names the same
 * resource, resolving `apps/self/` against the calling app.
 *
 * The two spellings matter. On disk, an app's storage lives at
 * `storage/apps/{appId}/…`, so the HTTP path `/api/storage/apps/notes/x.json`
 * and the URI `yaar://apps/notes/storage/x.json` are the *same file*. Only the
 * second is the one apps hold a permission for — `yaar://apps/self/storage/` is
 * auto-granted to every app at mint time. If this returned the flat
 * `yaar://storage/apps/notes/x.json` instead, every app would be denied its own
 * storage over HTTP, and a permission for `yaar://storage/` would silently be a
 * permission for every other app's secrets.
 */
export function storageUriFor(principal: Principal, path: string): string | Response {
  let p = path;

  if (p === 'apps/self' || p.startsWith('apps/self/')) {
    if (principal.kind !== 'app' || !principal.appId) {
      return errorResponse('Cannot resolve "self": caller is not an app', 403);
    }
    p = p.replace('apps/self', `apps/${principal.appId}`);
  }

  // Traversal would let `apps/{me}/../{other}/secrets.json` name another app's
  // storage while presenting as this app's own URI.
  if (p.split('/').includes('..')) {
    return errorResponse('Invalid path', 403);
  }

  const appScoped = p.match(/^apps\/([^/]+)(?:\/(.*))?$/);
  if (appScoped) {
    const [, appId, rest] = appScoped;
    return `yaar://apps/${appId}/storage${rest ? `/${rest}` : ''}`;
  }

  return `yaar://storage${p ? `/${p}` : ''}`;
}
