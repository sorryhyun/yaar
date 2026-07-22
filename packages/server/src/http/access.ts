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
 * ── The origin boundary (app-origin isolation) ──
 *
 * App iframes are served same-origin and unsandboxed (IframeRenderer.tsx: "for
 * same-origin content (local apps), don't sandbox - it's trusted"). A *hostile* app
 * can therefore decline to send its token, spoof `Referer`, or reach `window.parent`
 * directly. No header-based principal closes that; it needs an origin boundary.
 *
 * Behind `YAAR_APP_ORIGIN_ISOLATION` (default off, local mode only) that boundary
 * exists: installed (`source:'user'`) apps are served from the `127.0.0.1` alias,
 * the desktop from `localhost`. `resolvePrincipal` then stops reading "no token" as
 * "the desktop" *for requests that carry the app origin* — a browser-set `Origin` of
 * the app alias, or a request landing on that alias — and refuses them. Bundled apps
 * and AI-authored HTML stay same-origin (host-authored, not hostile app code) and are
 * unaffected. The remaining reach — `window.parent` on a still-unsandboxed frame — is
 * a later stage's concern. The full gap history is in docs/architecture/known_gaps.md.
 *
 * What this module does buy, today: a network caller cannot reach these routes
 * at all (auth.ts), an app that behaves like an app is confined to what it
 * declared, cross-app and cross-session reads are refused, and a compromised
 * app can no longer flip global switches like `allowAllDomains` by accident.
 */

import type { Verb } from '../handlers/uri-registry.js';
import { isAppOriginIsolationEnabled, APP_ORIGIN_HOST } from '../config.js';
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
export interface AppPrincipal {
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
  /** Streamable capabilities declared in app.json `streams` (e.g. `agents`). */
  streams: string[];
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

/** Parse the hostname out of an origin/URL string, or null if it isn't one. */
function hostnameOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * Does this request carry the isolated-app origin (Stage 2)?
 *
 * With app-origin isolation on, the desktop is pinned to `localhost` and installed
 * apps to `127.0.0.1` (the same socket, a distinct browser origin). A request wears
 * the app origin one of two ways, and both are unspoofable by app code:
 *
 * - **A browser-set `Origin` header of the app alias.** The app's SDK calls the
 *   desktop origin cross-origin, so the browser attaches `Origin: http://127.0.0.1:PORT`.
 *   A hostile app doing the same `fetch()` *without* a token wears the same Origin —
 *   that is what pins it as an app rather than the host.
 * - **Landing on the app alias itself.** A relative `fetch('/api/...')` from an app
 *   stays on `127.0.0.1`, sends no `Origin` header, and would otherwise read as the
 *   host. The request host (`url.hostname`) catches it. The desktop never lands here
 *   because a document that does is redirected to localhost (http/server.ts).
 */
function requestCarriesAppOrigin(req: Request, url: URL): boolean {
  if (hostnameOf(req.headers.get('origin')) === APP_ORIGIN_HOST) return true;
  if (url.hostname === APP_ORIGIN_HOST) return true;
  return false;
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
  if (!token) {
    // App-origin isolation (Stage 2, docs/architecture/known_gaps.md). When the flag
    // is on, "no token" no longer means "the desktop": an installed app served from
    // the 127.0.0.1 alias can omit its token, but it cannot shed the app origin — the
    // browser stamps it on cross-origin calls, and a relative call still lands on that
    // alias. Either way the request is an app trying to pass as the host, so it is
    // refused rather than promoted. Absent the flag this branch is inert and behavior
    // is exactly as before.
    if (isAppOriginIsolationEnabled() && requestCarriesAppOrigin(req, url)) {
      return errorResponse('App-origin request must present a valid iframe token', 403);
    }
    return { kind: 'host' };
  }

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
    streams: entry.streams ?? [],
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

/**
 * Rewrite the flat spelling of an app's storage to the namespaced one.
 *
 * `yaar://storage/apps/notes/todo.json` and `yaar://apps/notes/storage/todo.json`
 * are the same file — `storage/apps/{id}/` is a plain subtree of the flat root, not
 * a separate volume. Only the second spelling is the one permissions are written
 * against, so without this rewrite `isUriAllowed` is plain prefix matching and an
 * app declaring `yaar://storage/` holds a permission for *every other app's*
 * storage: credentials, databases, project sources.
 *
 * `/api/storage/*` already avoided that by naming its URI through `storageUriFor`
 * (see its docstring), but `/api/verb` took the URI from the request body verbatim.
 * Doing the rewrite here rather than at each door means every caller of
 * `requirePermission` gets it, and the two spellings can never disagree.
 *
 * Returns the URI unchanged when it does not name flat storage, and `null` for a
 * traversing path — which names no resource and must not be matched against
 * anything.
 */
function canonicalStorageUri(uri: string): string | null {
  if (uri !== 'yaar://storage' && !uri.startsWith('yaar://storage/')) return uri;

  // A trailing slash is what makes a permission entry a *prefix* (uriMatches), so it
  // has to survive the round trip. `storageUriForPath` names a concrete resource and
  // drops it.
  const trailing = uri.endsWith('/') ? '/' : '';
  const path = uri.slice('yaar://storage'.length).replace(/^\//, '').replace(/\/$/, '');

  const rewritten = storageUriForPath(path);
  return rewritten === null ? null : rewritten + trailing;
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

  // Canonicalize both sides, as with `self` below: an app.json may spell a grant
  // either way, and a URI from a request body certainly may.
  const canonical = canonicalStorageUri(uri);
  if (canonical === null) return errorResponse(`Not permitted: ${verb} ${uri}`, 403);

  const target = resolveSelf(canonical, principal.appId);
  const granted = principal.permissions.flatMap((entry) => {
    const raw = typeof entry === 'string' ? entry : entry.uri;
    const rewritten = canonicalStorageUri(raw);
    if (rewritten === null) return [];
    const resolved = resolveSelf(rewritten, principal.appId);
    return [typeof entry === 'string' ? resolved : { ...entry, uri: resolved }];
  });

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

/**
 * The full prelude for a gated-SDK door: resolve the caller, insist it is a real
 * app, and require the bundle.
 *
 * The `kind !== 'app'` step is the load-bearing one and the reason this is a
 * helper rather than a bare `requireBundle` call. `requireBundle` returns `null`
 * for a `host` principal — correct on its own terms, since the host is the user —
 * so a door that calls it *without* first pinning the caller to an app is open to
 * anyone who simply omits a token. `/api/browser`, `/api/bridge` and `/api/dev/*`
 * each rewrote this sequence by hand; `browser.ts` re-ran it (and re-resolved the
 * principal) five times per request.
 *
 * Returns the `AppPrincipal` so callers can read `appId`/`sessionId` off it
 * without re-narrowing.
 */
export function requireBundledApp(req: Request, url: URL, bundle: string): AppPrincipal | Response {
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  if (principal.kind !== 'app') return errorResponse('Invalid or missing iframe token', 403);
  const denied = requireBundle(principal, bundle);
  if (denied) return denied;
  return principal;
}

/**
 * Require that an app declared a streamable capability in its app.json `streams`.
 *
 * Opening a `mode:'stream'` subscription to a sensitive source — an agent's live
 * transcript at `yaar://agents/{id}/stream` — is more than reading a resource, so
 * it is gated on an explicit, bundled-only declaration rather than a `read`
 * permission. `streams` is only ever populated on the token for bundled apps
 * (getAppMeta enforces that), so membership here is also a bundled-app check.
 */
export function requireStream(principal: Principal, capability: string): Response | null {
  if (principal.kind === 'host') return null;
  if (principal.streams.includes(capability)) return null;
  return errorResponse(
    `"${capability}" must be declared in app.json "streams" to stream this source`,
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

  const uri = storageUriForPath(p);
  if (!uri) return errorResponse('Invalid path', 403);
  return uri;
}

/**
 * The bare path → URI mapping, with no principal to resolve `self` against.
 *
 * Callers that already hold a concrete path (no `self` to expand) name the URI
 * through this rather than rebuilding the mapping — a second copy that drifted
 * would hand out permissions for one URI while the gate checked another.
 * Returns null for a traversing path, which names no resource.
 */
export function storageUriForPath(path: string): string | null {
  // Traversal would let `apps/{me}/../{other}/secrets.json` name another app's
  // storage while presenting as this app's own URI.
  if (path.split('/').includes('..')) return null;

  const appScoped = path.match(/^apps\/([^/]+)(?:\/(.*))?$/);
  if (appScoped) {
    const [, appId, rest] = appScoped;
    return `yaar://apps/${appId}/storage${rest ? `/${rest}` : ''}`;
  }

  return `yaar://storage${path ? `/${path}` : ''}`;
}
