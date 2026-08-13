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

import { isPreviewAppId } from '@yaar/shared';
import type { Verb } from '../handlers/uri-registry.js';
import { requestCarriesAppOrigin } from './origin-boundary.js';
import { validateIframeToken } from './iframe-tokens.js';
import {
  canonicalStorageUri,
  expandSelfPath,
  grantEntries,
  isSharedOnly,
  isUriAllowed,
  namesForeignAppStorage,
  namesSelfPath,
  resolveSelf,
  SHARED_STORAGE_ROOT,
} from './uri-match.js';
import { errorResponse } from './utils.js';

/**
 * A permission entry is either:
 * - a URI prefix string (allows all verbs), or
 * - an object with `uri` and optional `verbs` array (restricts to listed verbs).
 *
 * `sharedOnly` is never written in an app.json — `parsePermissions` copies only `uri` and
 * `verbs`, so a manifest cannot set it. It is stamped by `capForeignAppStorage` when a
 * caller that may not hold a grant over app storage declares one anyway, and it caps that
 * one entry to the shared tree instead of discarding it. See {@link permissionsAllow}.
 */
export type PermissionEntry = string | { uri: string; verbs?: Verb[]; sharedOnly?: true };

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

/**
 * Was this exact path named to the window by a caller that may not delegate grants?
 *
 * Injected the same way and for the same cycle, and read for one purpose: telling the two
 * 403s apart in the sentence the caller gets. "You were never given this" and "the caller
 * that named it to you could not hand it over" are different problems with different
 * fixes, and they were the same string — which is how a *correct* permission removal read
 * as a regression to the agent verifying it. Defaults to false, so an unwired server (and
 * every test that boots no hub) simply keeps the generic wording.
 */
let resolveUndelegated: (
  sessionId: string,
  windowId: string,
  uri: string,
  monitorId?: string,
) => boolean = () => false;

export function setUndelegatedUriResolver(fn: typeof resolveUndelegated): void {
  resolveUndelegated = fn;
}

// ── Resolving the caller ────────────────────────────────────────────────────

/**
 * Find the iframe token a request is presenting, if any.
 *
 * The header is what the SDK sends. The query parameter is how a *subresource*
 * carries it — an `<img src="/api/storage/…">` inside an app cannot set headers,
 * and IframeRenderer already appends `__yaar_token` to the iframe's own URL, so
 * the same parameter works on asset URLs the app builds.
 *
 * This is the one definition of "presenting a token", and the three layers that ask
 * the question all call it: this module's `resolvePrincipal`, `auth.ts`'s remote-mode
 * credential check, and `server.ts`'s coarse route allowlist. `server.ts` used to read
 * the header alone, so a subresource riding the query parameter skipped the allowlist
 * entirely and was caught only by the fine-grained gates behind it.
 */
export function extractIframeToken(req: Request, url: URL): string | null {
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

// The rule itself lives in `uri-match.ts`, a leaf this module, `iframe-tokens.ts` and
// `features/apps/discovery.ts` can all reach — see that file for why. Re-exported so this
// stays the module you import a permission check from.
export {
  capForeignAppStorage,
  coversForeignAppStorage,
  expandSelfPath,
  isUriAllowed,
  namesSelf,
  namesSelfPath,
  resolveSelf,
  uriMatches,
} from './uri-match.js';

/** Is this the commons every app holds without declaring it? */
function namesSharedTree(canonical: string): boolean {
  return canonical === 'yaar://storage/shared' || canonical.startsWith(SHARED_STORAGE_ROOT);
}

/**
 * Is this the font catalog — the other thing granted for being an app?
 *
 * The faces themselves are already public: `isStaticAsset` serves `.otf`/`.ttf`
 * unauthenticated, because a CSS-initiated font fetch cannot attach a token. So
 * a permission here would guard nothing — an app can already `fetch()` the whole
 * 1.6 MB file. What it *would* do is make an app declare a permission to get the
 * same bytes in the only form a rasteriser can use, and the user approve a
 * grant, for typography. Read-only by construction: the handler has no `delete`
 * and its `invoke` returns a subset of a file the caller could already read.
 */
function namesFonts(canonical: string): boolean {
  return canonical === 'yaar://system/fonts' || canonical.startsWith('yaar://system/fonts/');
}

/** Is this the session principal's private namespace? */
function isSessionUri(uri: string): boolean {
  return uri === 'yaar://session' || uri.startsWith('yaar://session/');
}

// ── The gates ───────────────────────────────────────────────────────────────

/**
 * Does this permission list cover `verb` on `uri`?
 *
 * The rule `requirePermission` applies, minus the principal-level gates around it
 * (host bypass, the `yaar://session/*` refusal) — those are about *who* is asking,
 * this is about what was declared.
 *
 * Exported because the app-agent MCP door has a permission list to check and no
 * `Principal` to check it for: an app agent presents no iframe token, takes its appId
 * from its own window, and answers on a tool call rather than an HTTP request, so it
 * can neither produce a 403 `Response` nor be resolved by `resolvePrincipal`. What it
 * must not do is carry a second copy of the matching — a copy that skipped
 * `canonicalStorageUri` would answer differently for the two spellings of the same file,
 * and one that drifted later would do it at one door only.
 *
 * `describe` is metadata-only (it reveals a handler's schema, not its data), so it
 * bypasses the list — matching the verb endpoint's existing rule.
 *
 * So does the commons. `yaar://storage/shared/` is granted to every app for being an
 * app, exactly as `yaar://apps/self/…` is (`SELF_GRANTS`), and it is granted *here*
 * rather than on the token because the app agent's storage door has a permission list
 * and no token — a grant minted at mint time would reach an app's iframe and not its
 * agent. The tree is the one every app publishes to for the others to read, so a
 * declaration was guarding a boundary that does not exist, while forgetting it 403'd
 * an app on the one path whose whole purpose is being reachable. It widens nothing
 * else: `storage/apps/{id}/` is a different subtree and still takes a declared entry.
 *
 * `yaar://system/fonts` is the second commons, for the reason given at `namesFonts`:
 * the font files are already served unauthenticated, so the grant would guard bytes
 * an app can fetch anyway.
 */
export function permissionsAllow(
  permissions: PermissionEntry[],
  appId: string | undefined,
  uri: string,
  verb: Verb,
): boolean {
  // Both sides are normalized before matching, but not symmetrically: a target names one
  // resource and canonicalizes onto it, while a grant is a *prefix* and expands into every
  // coordinate system that prefix reaches (`grantEntries`). `self` is expanded first on
  // both — it is a precondition for canonicalization, not an independent pass, since
  // `yaar://apps/self/storage/` names no subtree of the flat tree until `self` is real.
  const target = canonicalStorageUri(resolveSelf(uri, appId));
  if (target === null) return false;

  // The commons, granted for being an app — `appId` is the whole condition, since a
  // non-app iframe has no app identity to grant to.
  if (appId && namesSharedTree(target)) return true;
  if (appId && namesFonts(target)) return true;

  // A capped entry (`sharedOnly`) is the shared tree only: it never answers for another
  // app's private storage, however broad the prefix it was written as. That is the whole
  // ceiling — it applies to the URIs the entry should not have covered, and to nothing
  // else, so the same grant still reaches `yaar://storage/shared/` as it always did.
  const foreign = namesForeignAppStorage(target, appId);
  const granted = permissions.flatMap((entry) =>
    foreign && isSharedOnly(entry) ? [] : grantEntries(entry, appId),
  );

  return verb === 'describe' || isUriAllowed(target, verb, granted);
}

/**
 * The sentence that separates the two 403s, or `''` when this is the ordinary one.
 *
 * Appended to the refusal when a caller *did* name this exact path to this window and the
 * grant was withheld only because that caller was an app-role principal (`mayDelegateGrants`
 * — devtools' `previewCommand` relay is the case in the tree). Nothing about the decision
 * changes; the reader learns which fix applies. Without it the message points at the app's
 * `app.json`, which is the wrong file, and pointed there hardest during a permission audit
 * — the one moment "not permitted" reads as confirmation that the removal broke something.
 */
function undelegatedNote(principal: AppPrincipal, uri: string): string {
  // Matched on the canonical spelling, the same one the recording side stores: the caller
  // writes `yaar://storage/files/x.stl` in its payload and the app may ask for the file in
  // either dialect, and a note that only fires when the two happen to agree is worse than
  // none — it would be absent exactly where the spellings differ.
  const target = canonicalStorageUri(resolveSelf(uri, principal.appId));
  if (target === null) return '';
  const named = resolveUndelegated(
    principal.sessionId,
    principal.windowId,
    target,
    principal.monitorId,
  );
  if (!named) return '';
  return (
    ` — this path was named to this window by a caller that cannot delegate grants ` +
    `(an app-role principal, e.g. a devtools preview relay), so it was never handed over. ` +
    `This is not a missing app.json permission; re-run the same command as the session ` +
    `principal to reach the file.`
  );
}

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

  if (!permissionsAllow(principal.permissions, principal.appId, uri, verb)) {
    return errorResponse(`Not permitted: ${verb} ${uri}${undelegatedNote(principal, uri)}`, 403);
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
 *
 * A devtools *preview* gets its own sentence because its `bundles` came from a file
 * (`previewBundles` in iframe-tokens.ts), not from an installed manifest — so the
 * generic wording sends the reader to an app.json that is not the one consulted.
 * This is where the person hitting the refusal actually is; the mint that came up
 * empty happened windows ago and, on the ordinary paths, silently.
 */
export function requireBundle(principal: Principal, bundle: string): Response | null {
  if (principal.kind === 'host') return null;
  if (principal.bundles.includes(bundle)) return null;
  if (isPreviewAppId(principal.appId)) {
    return errorResponse(
      `"${bundle}" is not declared in this preview project's own app.json "bundles" — ` +
        `a preview's gated SDKs are read from the project file, not from an installed app. ` +
        `Add it there and reopen the preview.`,
      403,
    );
  }
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
 * resource, resolving `apps/self/` and `shared/self/` against the calling app.
 *
 * It emits the **namespaced** spelling (`yaar://apps/notes/storage/x.json`), which is the
 * dialect app.json is written in — `yaar://apps/self/storage/` is auto-granted to every
 * app at mint time — and the one worth showing a reader. Which of the two spellings comes
 * out is no longer load-bearing: `canonicalStorageUri` folds them together at the gate, so
 * either would match the same grants. It was load-bearing once, when the namespaced form
 * was canonical and the flat one arrived at the gate rewritten.
 *
 * The `self` expansion is {@link expandSelfPath}, the *path* flavor of
 * {@link resolveSelf} — same literal segment, different dialect (`apps/self/x.json`,
 * not `yaar://apps/self/x.json`). It is shared with `handleStorage`, which builds the
 * filesystem path from the same input: two literals here is a one-line drift away from
 * checking the permission on one file and writing another.
 *
 * The refusal below is what keeps that safe. An unexpandable `self` never reaches
 * `expandSelfPath`'s caller in `files.ts`, because this door has already turned it into
 * a 403 — a path naming `self` with no app to resolve it against names no file, and
 * passing it through would mint a literal `self` directory on disk.
 */
export function storageUriFor(principal: Principal, path: string): string | Response {
  const appId = principal.kind === 'app' ? principal.appId : undefined;

  if (namesSelfPath(path) && !appId) {
    return errorResponse('Cannot resolve "self": caller is not an app', 403);
  }

  const uri = storageUriForPath(expandSelfPath(path, appId));
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
