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
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
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
