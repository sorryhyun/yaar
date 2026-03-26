/**
 * SSRF protection utilities — URL validation and safe fetch with redirect following.
 */

/** Private/internal IP patterns — block SSRF to internal networks. */
const INTERNAL_HOSTNAME_PATTERNS = [
  /^127\./,
  /^localhost$/i,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
];

export function isPrivateHostname(hostname: string): boolean {
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
 * Fetch with SSRF-safe redirect following.
 * Validates each redirect target before following it.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  validateUrl(url);

  // If caller explicitly wants manual redirect handling, do a single request
  if (init?.redirect === 'manual') {
    return fetch(url, { ...init, redirect: 'manual' });
  }

  let currentUrl = url;
  // Accumulate cookies across redirects (needed for SSO flows)
  const cookieJar = new Map<string, string>();

  // Seed jar with any cookies from the original request
  const initCookie =
    (init?.headers instanceof Headers
      ? init.headers.get('cookie')
      : Array.isArray(init?.headers)
        ? init.headers.find(([k]) => k.toLowerCase() === 'cookie')?.[1]
        : ((init?.headers as Record<string, string> | undefined)?.['Cookie'] ??
          (init?.headers as Record<string, string> | undefined)?.['cookie'])) ?? '';
  if (initCookie) {
    for (const pair of initCookie.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) cookieJar.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
    }
  }

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // Build headers with accumulated cookies
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    if (cookieJar.size > 0) {
      headers.set(
        'Cookie',
        Array.from(cookieJar.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      );
    }

    const response = await fetch(currentUrl, {
      ...init,
      headers,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      // Merge accumulated Set-Cookie headers from redirect hops into final response
      if (cookieJar.size > 0) {
        const mergedHeaders = new Headers(response.headers);
        // Append redirect-hop cookies as Set-Cookie headers so callers see them
        for (const [name, value] of cookieJar) {
          mergedHeaders.append('Set-Cookie', `${name}=${value}; path=/`);
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
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const nameValue = sc.split(';')[0] ?? '';
      const eq = nameValue.indexOf('=');
      if (eq > 0)
        cookieJar.set(nameValue.substring(0, eq).trim(), nameValue.substring(eq + 1).trim());
    }

    const location = response.headers.get('location');
    if (!location) {
      return response; // No Location header, return as-is
    }

    // Resolve relative URLs against the current URL
    const nextUrl = new URL(location, currentUrl).toString();
    validateUrl(nextUrl); // Throws if redirect targets private network
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}
