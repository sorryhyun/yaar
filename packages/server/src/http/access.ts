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
 * Behind `YAAR_APP_ORIGIN_ISOLATION` (default on) that boundary exists: installed
 * (`source:'user'`) apps are served from a distinct origin, the desktop from its own.
 * `resolvePrincipal` then stops reading "no token" as "the desktop" *for requests that
 * carry the app origin* and refuses them. Bundled apps and AI-authored HTML stay
 * same-origin (host-authored, not hostile app code) and are unaffected. Being a
 * distinct origin also blocks the isolated app's `window.parent` DOM/memory reach;
 * top-level navigation — the one reach cross-origin left open — is now closed by the
 * `ISOLATED_APP_SANDBOX` on isolated frames (IframeRenderer.tsx).
 *
 * *Which* two origins those are is the transport's business, not this module's:
 * `localhost`/`127.0.0.1` locally, two Tailscale Serve ports over the network. This
 * module asks `origin-boundary.ts` one question — does this request carry the app
 * origin — and that module knows how to answer it in either mode. The full gap history
 * is in docs/guides/remote_mode.md.
 *
 * What this module does buy, today: a network caller cannot reach these routes
 * at all (auth.ts), an app that behaves like an app is confined to what it
 * declared, cross-app and cross-session reads are refused, and a compromised
 * app can no longer flip global switches like `allowAllDomains` by accident.
 */

import type { Verb } from '../handlers/uri-registry.js';
import { requestCarriesAppOrigin } from './origin-boundary.js';
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

/**
 * Storage files a more-privileged principal named to this window's app.
 *
 * Injected rather than imported (the `setAccessRoleResolver` pattern): the grants live
 * on `WindowStateRegistry`, reached through `SessionHub`, and a static import of the
 * session tree from the HTTP access module is a runtime cycle. Wired in `lifecycle.ts`;
 * until then, and in any test that boots no hub, nothing is delegated.
 *
 * Read here rather than folded into the token at mint time because the token is not
 * durable — see `WindowStateRegistry.delegatedGrants`.
 */
let resolveWindowGrants: (
  sessionId: string,
  windowId: string,
  monitorId?: string,
) => PermissionEntry[] = () => NO_PERMISSIONS;

export function setWindowGrantResolver(fn: typeof resolveWindowGrants): void {
  resolveWindowGrants = fn;
}

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
  if (!token) {
    // App-origin isolation (docs/guides/remote_mode.md). With a boundary in force,
    // "no token" no longer means "the desktop": an isolated app can omit its token,
    // but it cannot shed the app origin — the browser stamps it on cross-origin calls,
    // and a same-origin call still lands on the app side of the boundary. Either way
    // the request is an app trying to pass as the host, so it is refused rather than
    // promoted. With no boundary this is inert and behavior is exactly as before.
    if (requestCarriesAppOrigin(req, url)) {
      return errorResponse('App-origin request must present a valid iframe token', 403);
    }
    return { kind: 'host' };
  }

  const entry = validateIframeToken(token);
  if (!entry) return errorResponse('Invalid or expired iframe token', 403);

  // Files an agent named *to* this window, on top of what app.json declares. Read per
  // request so a grant made after the token was minted (an `app_command` naming a file
  // in an already-open window) is in force immediately, and so a grant survives the
  // token being re-minted on remount.
  const delegated = resolveWindowGrants(entry.sessionId, entry.windowId, entry.monitorId);
  const declared = entry.permissions ?? NO_PERMISSIONS;

  return {
    kind: 'app',
    appId: entry.appId,
    sessionId: entry.sessionId,
    windowId: entry.windowId,
    monitorId: entry.monitorId,
    permissions: delegated.length > 0 ? [...declared, ...delegated] : declared,
    systemApp: entry.systemApp ?? false,
    bundles: entry.bundles ?? [],
    streams: entry.streams ?? [],
    token,
  };
}

// ── Matching a URI against declared permissions ─────────────────────────────

function uriMatches(uri: string, pattern: string): boolean {
  return (
    uri === pattern || (pattern.endsWith('/') && (uri.startsWith(pattern) || uri + '/' === pattern))
  );
}

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
 * Does this URI still name `self` — i.e. is it written in the app's own dialect
 * rather than in real ids?
 *
 * The counterpart to {@link resolveSelf}, which leaves such a URI untouched when it
 * has no appId to expand against. Callers that must not store or match an
 * unresolved URI (the subscription registry keys by literal string) test the
 * *result* of `resolveSelf` with this rather than re-deriving the spelling.
 */
export function namesSelf(uri: string): boolean {
  return uri === 'yaar://apps/self' || uri.startsWith('yaar://apps/self/');
}

/**
 * Rewrite `yaar://apps/self/…` to the calling app's real id.
 *
 * Applied to *both* sides of the match — the URI being requested and the app's
 * declared permissions — because the two are not written in the same dialect. An
 * app.json says `yaar://apps/self/storage/`; a storage URI derived from an HTTP path
 * says `yaar://apps/notes/storage/todo.json`. Matching those literally denies an app
 * its own storage. Canonicalizing both means either spelling works and they agree.
 *
 * Exported because the permission gate is not the only place `self` has to be
 * expanded: `POST /api/verb` resolves it before dispatching, and
 * `/api/verb/subscribe` before *storing* the URI (a subscription keyed by the
 * `self` spelling would never match the real-id URI a producer notifies with). All
 * three used to spell the rewrite out by hand, so a change to the spelling — or a
 * future `windows/self` — was a three-site edit that would fail silently in the two
 * sites that were missed. Returns the URI unchanged when there is no appId to
 * expand against; the caller decides whether that is fatal ({@link namesSelf}).
 *
 * The path-flavored variant in {@link storageUriFor} is deliberately *not* folded in:
 * it expands `apps/self` inside an HTTP **path** (`apps/self/x.json`), not a URI, and
 * round-tripping it through the URI form to share these five lines would be more
 * indirection than the duplication costs. The two must agree on the literal `self`
 * segment and nothing else.
 */
export function resolveSelf(uri: string, appId?: string): string {
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
  //
  // This is the cheap early refusal, not the authority. `ResourceRegistry.execute`'s
  // `access: 'session-principal'` gate is — it sits behind *both* doors (MCP and
  // `POST /api/verb`) and applies the same widening, admitting the session agent or a
  // token-backed system app. The two used to answer in different currencies (this
  // module's `systemApp` flag vs. the registry's agent `role`), which is how a system
  // app came to be admitted here and 403'd there.
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
 * Insist the caller is a real app, and hand back the narrowed principal.
 *
 * A `host` principal is what "presented no token" resolves to, so a door that only
 * asks `requirePermission` is open to anyone who simply omits one — `requirePermission`
 * returns `null` for the host, correctly, since the host is the user. The app doors
 * (`/api/verb`, `/api/verb/subscribe`, the gated-SDK routes) are reached *from an
 * iframe*; the desktop drives the server over the WebSocket and has no business here.
 * So for them a token-less caller is not the user asking a favour, it is an app with
 * nothing declared.
 *
 * Returns the `AppPrincipal` rather than a `Response | null` so the narrowing survives
 * the call — every caller goes on to read `appId`/`sessionId`/`token` off it.
 */
export function requireApp(principal: Principal): AppPrincipal | Response {
  if (principal.kind !== 'app') return errorResponse('Invalid or missing iframe token', 403);
  return principal;
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
 * The {@link requireApp} step is the load-bearing one and the reason this is a
 * helper rather than a bare `requireBundle` call — see its docstring for why a door
 * that skips it is open to anyone who omits a token. `/api/browser`, `/api/bridge`
 * and `/api/dev/*` each rewrote this sequence by hand; `browser.ts` re-ran it (and
 * re-resolved the principal) five times per request.
 *
 * Returns the `AppPrincipal` so callers can read `appId`/`sessionId` off it
 * without re-narrowing.
 */
export function requireBundledApp(req: Request, url: URL, bundle: string): AppPrincipal | Response {
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  const app = requireApp(principal);
  if (app instanceof Response) return app;
  const denied = requireBundle(app, bundle);
  if (denied) return denied;
  return app;
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
 *
 * The `self` expansion here is the *path* flavor of {@link resolveSelf} — same
 * literal segment, different dialect (`apps/self/x.json`, not
 * `yaar://apps/self/x.json`). Change one and check the other.
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
