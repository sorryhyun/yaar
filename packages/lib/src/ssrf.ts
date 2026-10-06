/**
 * SSRF protection utilities — URL validation and safe fetch with redirect following.
 */

import { getFreeDpiProxyUrl } from './freedpi/active.js';

/** Loopback addresses — allowed through SSRF protection. */
const LOOPBACK_PATTERNS = [/^127\./, /^localhost$/i, /^\[?::1\]?$/];

/** Private/internal IP patterns — block SSRF to internal networks. */
const INTERNAL_HOSTNAME_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[?fe80:/i,
];

export function isLoopback(hostname: string): boolean {
  return LOOPBACK_PATTERNS.some((p) => p.test(hostname));
}

export function isPrivateHostname(hostname: string): boolean {
  if (isLoopback(hostname)) return false;
  return INTERNAL_HOSTNAME_PATTERNS.some((p) => p.test(hostname));
}

/**
 * Validate a URL for SSRF safety. Returns the parsed URL.
 * Throws if the URL is invalid, uses a non-HTTP scheme, or targets a private network.
 */
export function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http: and https: URLs are allowed');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('Access to internal networks is not allowed');
  }
  return parsed;
}

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The bypass proxy option for one URL, or nothing.
 *
 * Empty only when `YAAR_FREEDPI=0` kept the proxy down, or it failed to bind — in which
 * case this issues exactly the `fetch` it always did. Private and loopback targets are
 * deliberately excluded even when the proxy is up:
 * the proxy refuses them anyway (`freedpi/resolve.ts`), and routing them at it would
 * turn a working local call into a 403 for no gain — the bypass exists for censored
 * *public* hosts.
 *
 * Note the split of responsibility. `validateUrl` governs the hostname a caller asked
 * for; the address actually dialed once traffic is tunnelled is the one the proxy
 * resolves over DoH, which is why the proxy re-applies these same rules on its side.
 */
function bypassFor(url: string): { proxy: string } | undefined {
  const proxyUrl = getFreeDpiProxyUrl();
  if (!proxyUrl) return undefined;
  try {
    const { hostname } = new URL(url);
    if (isLoopback(hostname) || isPrivateHostname(hostname)) return undefined;
    return { proxy: proxyUrl };
  } catch {
    return undefined;
  }
}

/** Credentials a browser never carries across origins on a redirect (Fetch spec §4.4). */
const CROSS_ORIGIN_STRIPPED = ['authorization', 'proxy-authorization'];

/** Headers that describe a request body, dropped with the body (Fetch "request-body-header name"). */
const BODY_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
];

/** A cookie held across one redirect chain, scoped the way a browser would scope it. */
interface ChainCookie {
  name: string;
  value: string;
  /** Lowercase, no leading dot. */
  domain: string;
  /** Sent to `domain` only, not its subdomains — the cookie named no `Domain`. */
  hostOnly: boolean;
  path: string;
  /**
   * Set by a redirect hop's `Set-Cookie`, as opposed to seeded from the caller's own
   * `Cookie` header. Only these are news to the caller, so only these are echoed back.
   */
  fromHop: boolean;
}

function cookieDomainMatches(host: string, cookie: ChainCookie): boolean {
  if (host === cookie.domain) return true;
  return !cookie.hostOnly && host.endsWith(`.${cookie.domain}`);
}

function cookiePathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

/** RFC 6265 §5.1.4 default-path: the request path up to its last `/`. */
function defaultCookiePath(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash <= 0 ? '/' : pathname.slice(0, slash);
}

/**
 * Parse one `Set-Cookie` received from `url`, or null when it may not be stored.
 * A `Domain` the responding host does not belong to is refused, as a browser refuses it.
 */
function parseChainCookie(header: string, url: URL): ChainCookie | null {
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const host = url.hostname.toLowerCase();
  const cookie: ChainCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: host,
    hostOnly: true,
    path: defaultCookiePath(url.pathname),
    fromHop: true,
  };
  for (const attr of attrs) {
    const at = attr.indexOf('=');
    const key = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase();
    const value = at === -1 ? '' : attr.slice(at + 1).trim();
    if (key === 'domain' && value) {
      const domain = value.replace(/^\./, '').toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) return null;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === 'path' && value.startsWith('/')) {
      cookie.path = value;
    }
  }
  return cookie;
}

function readCookieHeader(headers: RequestInit['headers']): string {
  if (!headers) return '';
  return new Headers(headers as ConstructorParameters<typeof Headers>[0]).get('cookie') ?? '';
}

export interface SafeFetchOptions {
  /**
   * Called with each redirect target before it is followed, after the SSRF check. Throw
   * to refuse the hop — a caller that vets the first URL (a domain allowlist) vets every
   * URL the chain reaches the same way, or the first host decides where the rest go.
   */
  beforeRedirect?: (url: string) => void | Promise<void>;
}

/**
 * Fetch with SSRF-safe redirect following.
 *
 * Validates each redirect target before following it, and follows the way a browser
 * does rather than replaying the first request at every hop: `Authorization` does not
 * cross origins, cookies go only where their domain and path reach, and a 303 (or a
 * POST answered by 301/302) is retried as a bodiless GET.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<Response> {
  validateUrl(url);

  // If caller explicitly wants manual redirect handling, do a single request
  if (init?.redirect === 'manual') {
    return fetch(url, { ...init, ...bypassFor(url), redirect: 'manual' });
  }

  let currentUrl = new URL(url);
  let method = (init?.method ?? 'GET').toUpperCase();
  let body = init?.body;
  // The caller's headers, minus what the chain manages itself; credentials leave on the
  // first cross-origin hop and never come back, as in a browser.
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
  headers.delete('cookie');

  // Accumulate cookies across redirects (needed for SSO flows), scoped to where each
  // may be sent. The caller's own Cookie header is for the URL it named.
  const cookieJar: ChainCookie[] = [];
  const setCookie = (cookie: ChainCookie) => {
    const i = cookieJar.findIndex(
      (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (i === -1) cookieJar.push(cookie);
    else cookieJar[i] = cookie;
  };
  for (const pair of readCookieHeader(init?.headers).split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    setCookie({
      name: pair.substring(0, eq).trim(),
      value: pair.substring(eq + 1).trim(),
      domain: currentUrl.hostname.toLowerCase(),
      hostOnly: true,
      path: '/',
      fromHop: false,
    });
  }

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const host = currentUrl.hostname.toLowerCase();
    const cookies = cookieJar.filter(
      (c) => cookieDomainMatches(host, c) && cookiePathMatches(currentUrl.pathname, c.path),
    );
    const hopHeaders = new Headers(headers);
    if (cookies.length > 0) {
      hopHeaders.set('Cookie', cookies.map((c) => `${c.name}=${c.value}`).join('; '));
    }

    // Recomputed per hop: a redirect can cross from a censored host to a clean one,
    // or into private space, and the routing decision belongs to the URL being fetched.
    const response = await fetch(currentUrl.toString(), {
      ...init,
      ...bypassFor(currentUrl.toString()),
      method,
      body,
      headers: hopHeaders,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      // Merge Set-Cookie headers from redirect hops into the final response, so callers
      // see what the chain was handed. Never the caller's own cookies: echoed back, they
      // land in a caller's jar as if the upstream had set them, and on its next request
      // that stale copy outranks the fresh value the caller sends.
      const hopCookies = cookieJar.filter((c) => c.fromHop);
      if (hopCookies.length > 0) {
        const mergedHeaders = new Headers(response.headers);
        for (const c of hopCookies) {
          mergedHeaders.append('Set-Cookie', `${c.name}=${c.value}; path=/`);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: mergedHeaders,
        });
      }
      return response;
    }

    // Capture Set-Cookie from this hop
    for (const sc of response.headers.getSetCookie?.() ?? []) {
      const cookie = parseChainCookie(sc, currentUrl);
      if (cookie) setCookie(cookie);
    }

    const location = response.headers.get('location');
    if (!location) {
      return response; // No Location header, return as-is
    }

    // Resolve relative URLs against the current URL
    const nextUrl = new URL(location, currentUrl);
    validateUrl(nextUrl.toString()); // Throws if redirect targets private network
    await options?.beforeRedirect?.(nextUrl.toString());

    if (nextUrl.origin !== currentUrl.origin) {
      for (const name of CROSS_ORIGIN_STRIPPED) headers.delete(name);
    }
    const status = response.status;
    if (
      (status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((status === 301 || status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}
