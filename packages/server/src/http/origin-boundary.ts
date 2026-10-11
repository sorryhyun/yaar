/**
 * The app-origin boundary: where its two origins live, and how a request is
 * attributed to one of them.
 *
 * App-origin isolation needs exactly one thing from the transport — two *browser*
 * origins over the same server — and there are two ways to get it:
 *
 * - **`loopback-alias`** (local mode, with `YAAR_PER_APP_ORIGIN=0`). The desktop is `localhost`, isolated apps are
 *   `127.0.0.1`, one socket. A request wears the app origin by carrying a browser-set
 *   `Origin` of the alias, or by landing on the alias (`url.hostname`).
 * - **`loopback-subdomain`** (local mode, the default; `YAAR_PER_APP_ORIGIN=0` opts out). The same
 *   split, but each installed app gets an origin of its own, `<appId>.localhost` — a
 *   distinct *site*, so Chromium gives it its own renderer process, and no app can reach
 *   into a sibling's frame (`docs/proposals/app_site_isolation_proposal.md`). The
 *   `127.0.0.1` alias stays an app origin too: a client that cannot resolve
 *   `*.localhost` falls back to it, so this mode is `loopback-alias` plus more.
 * - **`proxy-port`** (Tailscale Serve). One stable MagicDNS name, two public HTTPS
 *   ports (`:443` desktop, `:8443` apps) — distinct origins, since the same-origin
 *   policy separates on port too. This is how remote mode gets a boundary at all:
 *   `localhost`/`127.0.0.1` means nothing once you reach the machine over a network,
 *   and a second origin needs a hostname that survives a restart.
 *
 * `proxy-port` cannot read the addressed origin off the request: `url.hostname` and
 * `url.port` describe the *local* socket the proxy dialed, and `Host` /
 * `X-Forwarded-*` are proxy-supplied. So the two public ports are pointed at two
 * *different local sockets*, and the server knows which one a request arrived on
 * because each socket gets its own `fetch` handler — the app-origin one runs inside
 * {@link runOnAppOriginSocket}. That is unspoofable by construction: no header, no
 * trust in the proxy, nothing an app's JS can set.
 *
 * Every consumer asks this module rather than comparing hostnames itself, so adding a
 * transport means adding a mode here and nothing else.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isLoopback } from '@yaar/lib/ssrf';
import {
  isAppOriginIsolationEnabled,
  isPerAppOriginRequested,
  APP_ORIGIN_HOST,
  DESKTOP_ORIGIN_HOST,
} from '../config.js';

export type OriginBoundary =
  | { mode: 'off' }
  | { mode: 'loopback-alias' }
  | { mode: 'loopback-subdomain' }
  | { mode: 'proxy-port'; desktopOrigin: string; appOrigin: string };

const OFF: OriginBoundary = { mode: 'off' };
const LOOPBACK_ALIAS: OriginBoundary = { mode: 'loopback-alias' };
const LOOPBACK_SUBDOMAIN: OriginBoundary = { mode: 'loopback-subdomain' };

/**
 * A boundary installed at runtime by the lifecycle, once a transport has actually
 * published both origins. Absent, the boundary is whatever the environment implies —
 * which stays a *function* call rather than a startup constant so a test can flip
 * `YAAR_APP_ORIGIN_ISOLATION` between assertions.
 */
let installed: OriginBoundary | null = null;

/**
 * Install the proxy-port boundary. Called once, after the transport confirms both
 * public origins are live (see `lifecycle.startTunnel`).
 */
export function installProxyPortBoundary(desktopOrigin: string, appOrigin: string): void {
  installed = { mode: 'proxy-port', desktopOrigin, appOrigin };
}

/**
 * Install the loopback-alias boundary explicitly.
 *
 * The environment implies this one already in local mode, so the only caller that needs
 * it is remote mode whose tunnel did not come up: `isAppOriginIsolationEnabled()` is
 * deliberately false under `IS_REMOTE` (the `localhost`/`127.0.0.1` split means nothing
 * over a network), which used to leave that fallback with **no** boundary at all.
 *
 * But a remote server whose tunnel failed is not reachable over a network — it stays on
 * loopback, and nothing outside the machine can connect. Locally is exactly where the
 * alias split does work, so the degraded path gets the local boundary rather than none.
 */
export function installLoopbackAliasBoundary(): void {
  installed = LOOPBACK_ALIAS;
}

/** Drop any installed boundary, falling back to the environment. Tests only. */
export function resetOriginBoundary(): void {
  installed = null;
}

export function getOriginBoundary(): OriginBoundary {
  if (installed) return installed;
  if (!isAppOriginIsolationEnabled()) return OFF;
  return isPerAppOriginRequested() ? LOOPBACK_SUBDOMAIN : LOOPBACK_ALIAS;
}

/** Is there an origin boundary to enforce at all? */
export function isOriginBoundaryActive(): boolean {
  return getOriginBoundary().mode !== 'off';
}

/**
 * The origin isolated app iframes must be loaded from, when the frontend cannot
 * derive it for itself.
 *
 * In the loopback modes it can (and must): only the browser knows which port the
 * document was served on, which is not necessarily the API port — a dev server in
 * front of the API serves the desktop on 5173. So that mode returns null and the
 * frontend computes the sibling alias. In `proxy-port` mode the origin is a fixed
 * published address the server chose, so the server states it.
 */
export function isolatedAppOrigin(): string | null {
  const boundary = getOriginBoundary();
  return boundary.mode === 'proxy-port' ? boundary.appOrigin : null;
}

// ── Which socket did this request arrive on? ─────────────────────────────────

const appOriginSocket = new AsyncLocalStorage<true>();

/**
 * Run the fetch handler for the app-origin socket. Everything downstream — including
 * `resolvePrincipal`, however deep in a route — can then tell that this request
 * addressed the app origin.
 */
export function runOnAppOriginSocket<T>(fn: () => T): T {
  return appOriginSocket.run(true, fn);
}

/** Did the current request arrive on the app-origin socket? */
export function isAppOriginSocketRequest(): boolean {
  return appOriginSocket.getStore() === true;
}

// ── The questions consumers ask ─────────────────────────────────────────────

function hostnameOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** The suffix every per-app host shares: `notes.localhost` is app `notes`. */
const APP_SUBDOMAIN_SUFFIX = `.${DESKTOP_ORIGIN_HOST}`;

/**
 * Is this hostname on the app side of a loopback boundary?
 *
 * Any `*.localhost` counts in `loopback-subdomain`, not only the ones naming an installed
 * app: the browser resolves every one of them to loopback, and none of them is the
 * desktop. Reading an unknown subdomain as the desktop is the failure to avoid.
 */
function isLoopbackAppHost(hostname: string | null, mode: 'loopback-alias' | 'loopback-subdomain') {
  if (hostname === null) return false;
  if (hostname === APP_ORIGIN_HOST) return true;
  return mode === 'loopback-subdomain' && hostname.endsWith(APP_SUBDOMAIN_SUFFIX);
}

/**
 * Does this request carry the isolated-app origin?
 *
 * A `true` here is what stops `resolvePrincipal` reading "no token" as "the desktop".
 * Both faces of the answer are unspoofable by app code: a browser sets `Origin`
 * itself, and which socket a request landed on is not something a request can claim.
 */
export function requestCarriesAppOrigin(req: Request, url: URL): boolean {
  const boundary = getOriginBoundary();
  switch (boundary.mode) {
    case 'off':
      return false;
    case 'loopback-alias':
    case 'loopback-subdomain':
      // A cross-origin call from the app to the desktop API (the SDK's shape), or a
      // relative call that stayed on the app alias and sent no Origin at all.
      if (isLoopbackAppHost(hostnameOf(req.headers.get('origin')), boundary.mode)) return true;
      return isLoopbackAppHost(url.hostname, boundary.mode);
    case 'proxy-port':
      // Same two cases, but the "stayed on the app origin" half is answered by the
      // socket rather than by `url` — behind a proxy `url` describes the loopback
      // hop, not the origin the browser addressed.
      if (isAppOriginSocketRequest()) return true;
      return originOf(req.headers.get('origin')) === boundary.appOrigin.toLowerCase();
  }
}

/**
 * Is this browser `Origin` one the desktop itself is served from?
 *
 * The desktop only ever lives on loopback — every host (launched Chrome, the companion
 * tab, the macOS and Android WebViews) loads `localhost` — or, in remote mode, on the
 * published desktop origin. Any loopback port counts, since the port a document was
 * served on is the browser's to know (see {@link isolatedAppOrigin}). A hostname
 * compare, not an allowlist of origins, is what keeps a DNS-rebound page out: it is
 * same-origin with itself, but its hostname is the attacker's.
 *
 * The isolated-app origin is loopback too, so callers ask
 * {@link requestCarriesAppOrigin} first.
 */
export function isDesktopOrigin(origin: string): boolean {
  const boundary = getOriginBoundary();
  if (boundary.mode === 'proxy-port' && originOf(origin) === boundary.desktopOrigin.toLowerCase()) {
    return true;
  }
  const hostname = hostnameOf(origin);
  return hostname !== null && isLoopback(hostname);
}

/**
 * Where a *desktop document* that landed on the app origin has to be sent instead,
 * or null if it didn't land there.
 *
 * The desktop must never be served from the app origin: a token-less request wearing
 * that origin is refused (that is the whole enforcement), so a desktop living there
 * would refuse its own legitimately token-less calls. App iframe documents carry a
 * token and are excluded by the caller (`Sec-Fetch-Dest: iframe`).
 */
export function desktopRedirectTarget(url: URL): string | null {
  const boundary = getOriginBoundary();
  switch (boundary.mode) {
    case 'off':
      return null;
    case 'loopback-alias':
    case 'loopback-subdomain': {
      if (!isLoopbackAppHost(url.hostname, boundary.mode)) return null;
      const port = url.port ? `:${url.port}` : '';
      return `${url.protocol}//${DESKTOP_ORIGIN_HOST}${port}${url.pathname}${url.search}`;
    }
    case 'proxy-port':
      if (!isAppOriginSocketRequest()) return null;
      return `${boundary.desktopOrigin}${url.pathname}${url.search}`;
  }
}

/**
 * Is this browser `Origin` a per-app origin (`<appId>.localhost`)?
 *
 * Only in `loopback-subdomain`. It says nothing about the port; the caller holds the
 * list of sockets this server answers on.
 */
export function isPerAppOrigin(origin: string): boolean {
  if (getOriginBoundary().mode !== 'loopback-subdomain') return false;
  return hostnameOf(origin)?.endsWith(APP_SUBDOMAIN_SUFFIX) ?? false;
}

/**
 * May a token minted for `tokenAppId` be presented on this request?
 *
 * Only `loopback-subdomain` has anything to say: there an origin names its app, so the
 * server can check not only that a token is valid but *whose* it is. Both faces of the
 * request are checked, each when it is a per-app host — the browser-set `Origin` (who is
 * calling) and the host it landed on (whose origin the response lives in). The second is
 * the one that matters most: without it, app Y could frame
 * `X.localhost/api/storage/page.html?__yaar_token=<Y's>` and run a document of its
 * choosing inside X's origin, with X's IndexedDB and OPFS.
 *
 * The shared `127.0.0.1` alias names no app, so a token passes there as before — that is
 * the fallback for clients that cannot resolve `*.localhost`, not a per-app origin.
 */
export function tokenFitsAppOrigin(
  req: Request,
  url: URL,
  tokenAppId: string | undefined,
): boolean {
  if (getOriginBoundary().mode !== 'loopback-subdomain') return true;
  for (const hostname of [hostnameOf(req.headers.get('origin')), url.hostname]) {
    if (hostname === null || !hostname.endsWith(APP_SUBDOMAIN_SUFFIX)) continue;
    if (hostname.slice(0, -APP_SUBDOMAIN_SUFFIX.length) !== tokenAppId) return false;
  }
  return true;
}
