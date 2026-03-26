/**
 * Lightweight in-memory cookie jar for the fetch proxy.
 *
 * Cookies are scoped per jar key (typically `sessionId:appId`) so different
 * apps and sessions maintain isolated cookie state. Supports domain/path
 * matching, expiry, Secure flag, and automatic cleanup.
 */

interface StoredCookie {
  name: string;
  value: string;
  domain: string; // lowercase, leading dot stripped
  path: string;
  expires: number; // epoch ms, Infinity = session cookie
  secure: boolean;
  httpOnly: boolean;
}

const jars = new Map<string, StoredCookie[]>();

// ── Public API ───────────────────────────────────────────────────────

/**
 * Parse Set-Cookie headers from a response and store them in the jar.
 */
export function captureResponseCookies(
  jarKey: string,
  url: string,
  headers: Record<string, string>,
): void {
  // Collect all Set-Cookie values — response.headers.forEach collapses them
  // into a single comma-joined string, but Set-Cookie values can contain commas
  // in Expires dates. We split carefully.
  const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
  if (!raw) return;

  const parsed = new URL(url);
  const requestDomain = parsed.hostname.toLowerCase();
  const requestPath = parsed.pathname;

  const setCookies = splitSetCookieHeader(raw);

  for (const str of setCookies) {
    const cookie = parseSetCookie(str, requestDomain, requestPath);
    if (cookie) {
      storeCookie(jarKey, cookie);
    }
  }
}

/**
 * Build a Cookie header value for an outgoing request from stored cookies.
 * Returns undefined if no cookies match.
 */
export function getCookieHeader(jarKey: string, url: string): string | undefined {
  const cookies = jars.get(jarKey);
  if (!cookies || cookies.length === 0) return undefined;

  const parsed = new URL(url);
  const domain = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const isSecure = parsed.protocol === 'https:';
  const now = Date.now();

  const matching: StoredCookie[] = [];
  // Filter expired while we iterate
  const kept: StoredCookie[] = [];

  for (const c of cookies) {
    if (c.expires <= now) continue; // expired
    kept.push(c);
    if (c.secure && !isSecure) continue;
    if (!domainMatches(domain, c.domain)) continue;
    if (!pathMatches(path, c.path)) continue;
    matching.push(c);
  }

  // Compact expired cookies
  if (kept.length !== cookies.length) {
    if (kept.length === 0) {
      jars.delete(jarKey);
    } else {
      jars.set(jarKey, kept);
    }
  }

  if (matching.length === 0) return undefined;

  // Sort: longer paths first (RFC 6265 §5.4)
  matching.sort((a, b) => b.path.length - a.path.length);

  return matching.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Clear all cookies for a jar key.
 */
export function clearJar(jarKey: string): void {
  jars.delete(jarKey);
}

/**
 * Clear all jars matching a session prefix (e.g., on session cleanup).
 */
export function clearSessionJars(sessionId: string): void {
  const prefix = sessionId + ':';
  for (const key of jars.keys()) {
    if (key.startsWith(prefix)) {
      jars.delete(key);
    }
  }
}

/**
 * Build a jar key from session and app identifiers.
 */
export function jarKey(sessionId: string, appId?: string): string {
  return appId ? `${sessionId}:${appId}` : `${sessionId}:__host__`;
}

// ── Internals ────────────────────────────────────────────────────────

function storeCookie(key: string, cookie: StoredCookie): void {
  let cookies = jars.get(key);
  if (!cookies) {
    cookies = [];
    jars.set(key, cookies);
  }

  // Replace existing cookie with same name+domain+path
  const idx = cookies.findIndex(
    (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
  );
  if (idx >= 0) {
    if (cookie.expires <= Date.now()) {
      // Expired cookie = delete
      cookies.splice(idx, 1);
      if (cookies.length === 0) jars.delete(key);
    } else {
      cookies[idx] = cookie;
    }
  } else if (cookie.expires > Date.now()) {
    cookies.push(cookie);
  }
}

function parseSetCookie(
  str: string,
  requestDomain: string,
  requestPath: string,
): StoredCookie | null {
  const parts = str.split(';').map((s) => s.trim());
  const nameValue = parts[0];
  if (!nameValue) return null;

  const eqIdx = nameValue.indexOf('=');
  if (eqIdx < 1) return null;

  const name = nameValue.substring(0, eqIdx).trim();
  const value = nameValue.substring(eqIdx + 1).trim();

  let domain = requestDomain;
  let path = defaultPath(requestPath);
  let expires = Infinity; // session cookie by default
  let secure = false;
  let httpOnly = false;
  let maxAgeSet = false;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const attrEq = part.indexOf('=');
    const attrName = (attrEq >= 0 ? part.substring(0, attrEq) : part).trim().toLowerCase();
    const attrValue = attrEq >= 0 ? part.substring(attrEq + 1).trim() : '';

    switch (attrName) {
      case 'domain': {
        let d = attrValue.toLowerCase();
        if (d.startsWith('.')) d = d.substring(1);
        // Validate: request domain must match or be a subdomain
        if (d && (requestDomain === d || requestDomain.endsWith('.' + d))) {
          domain = d;
        }
        break;
      }
      case 'path':
        if (attrValue.startsWith('/')) {
          path = attrValue;
        }
        break;
      case 'expires':
        if (!maxAgeSet) {
          const date = new Date(attrValue);
          if (!isNaN(date.getTime())) {
            expires = date.getTime();
          }
        }
        break;
      case 'max-age': {
        const seconds = parseInt(attrValue, 10);
        if (!isNaN(seconds)) {
          maxAgeSet = true;
          expires = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
        }
        break;
      }
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
    }
  }

  return { name, value, domain, path, expires, secure, httpOnly };
}

/** RFC 6265 §5.1.4: default cookie path from request URI */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const lastSlash = requestPath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return requestPath.substring(0, lastSlash);
}

/** RFC 6265 §5.1.3: domain matching */
function domainMatches(requestDomain: string, cookieDomain: string): boolean {
  if (requestDomain === cookieDomain) return true;
  return requestDomain.endsWith('.' + cookieDomain);
}

/** RFC 6265 §5.1.4: path matching */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith('/')) return true;
    if (requestPath[cookiePath.length] === '/') return true;
  }
  return false;
}

/**
 * Split a potentially comma-joined Set-Cookie header.
 *
 * Set-Cookie headers joined by commas are ambiguous because Expires values
 * contain commas (e.g., "Thu, 01 Jan 2025 00:00:00 GMT"). We split only
 * on commas that are followed by a token= pattern (start of a new cookie).
 */
function splitSetCookieHeader(raw: string): string[] {
  const results: string[] = [];
  let current = '';

  // Split on comma, then re-join if the next segment doesn't look like a new cookie
  const segments = raw.split(',');
  for (const segment of segments) {
    if (current && /^\s*[a-zA-Z0-9_-]+=/.test(segment)) {
      // Looks like a new cookie name=value pair
      results.push(current.trim());
      current = segment;
    } else {
      // Continuation of previous (e.g., Expires date)
      current += (current ? ',' : '') + segment;
    }
  }
  if (current) results.push(current.trim());

  return results;
}
