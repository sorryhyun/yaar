/**
 * Core fetch logic — reusable across REST endpoint and verb handler.
 *
 * Validates URLs (SSRF), checks domain allowlist, shows permission dialogs,
 * and returns a structured result.
 */

import { validateUrl, safeFetch } from '../../lib/ssrf.js';
import { extractDomain, isDomainAllowed, addAllowedDomain } from '../../features/config/domains.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionHub } from '../../session/session-hub.js';
import { getCookieHeader, captureResponseCookies } from './cookie-jar.js';

export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
export const TIMEOUT_MS = 30_000;

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  sessionId?: string;
  /** Cookie jar key — when set, stored cookies are sent and Set-Cookie headers captured. */
  cookieJarKey?: string;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: 'base64';
}

/**
 * Perform a proxied HTTP fetch with SSRF protection and domain allowlist enforcement.
 *
 * Throws on validation errors, timeouts, oversized responses, and denied domains.
 */
export async function performFetch(url: string, options?: FetchOptions): Promise<FetchResult> {
  // Validate URL scheme, format, and block internal networks (SSRF protection)
  validateUrl(url);

  // Check domain allowlist — show permission dialog if sessionId is available
  const domain = extractDomain(url);
  if (!(await isDomainAllowed(domain))) {
    const hub = getSessionHub();

    // Resolve a valid LiveSession sessionId.
    // The caller may pass a stale/restored sessionId that doesn't match
    // any current LiveSession, so we validate against the SessionHub and
    // fall back to the default session.
    let sessionId: string | undefined;

    // 1. Caller-provided sessionId — validate it's a live session
    if (options?.sessionId && hub.get(options.sessionId)) {
      sessionId = options.sessionId;
    }

    // 2. Default session (fallback for stale/mismatched IDs)
    if (!sessionId) {
      sessionId = hub.getDefault()?.sessionId;
    }

    if (!sessionId) {
      throw new FetchDomainError(
        `Domain "${domain}" is not in the allowed list. Add it to curl_allowed_domains.yaml.`,
      );
    }

    // Show permission dialog to the user via WebSocket
    const confirmed = await actionEmitter.showPermissionDialogToSession(
      sessionId,
      'Allow Domain Access',
      `An app wants to make HTTP requests to "${domain}".\n\nDo you want to allow this domain?`,
      'http_domain',
      domain,
    );

    if (!confirmed) {
      throw new FetchDomainError(`User denied access to domain "${domain}".`);
    }

    // User approved — add domain to allowlist
    await addAllowedDomain(domain);
  }

  // Make the proxied request
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const fetchHeaders: Record<string, string> = {};
    if (options?.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        // Skip host/origin headers that point to YAAR itself; forward upstream-targeted ones
        const lower = k.toLowerCase();
        if (lower === 'host' || lower === 'origin') continue;
        if (lower === 'referer') {
          // Only forward referer when it targets the upstream site, not the YAAR server
          try {
            const refererHost = new URL(v).hostname;
            const targetHost = new URL(url).hostname;
            if (refererHost === 'localhost' || refererHost === '127.0.0.1') continue;
            // Allow if referer domain matches target or is a plausible upstream origin
            if (
              !targetHost.endsWith(refererHost) &&
              !refererHost.endsWith(targetHost.replace(/^www\./, ''))
            ) {
              // Still forward — the app explicitly set this referer for the target site
            }
          } catch {
            continue; // malformed referer, skip
          }
        }
        fetchHeaders[k] = v;
      }
    }

    // Inject stored cookies from the jar
    if (options?.cookieJarKey) {
      const cookieValue = getCookieHeader(options.cookieJarKey, url);
      if (cookieValue) {
        // Merge with any existing Cookie header from the app
        const existing = fetchHeaders['cookie'] || fetchHeaders['Cookie'] || '';
        fetchHeaders['Cookie'] = existing ? `${existing}; ${cookieValue}` : cookieValue;
        delete fetchHeaders['cookie']; // normalize to capitalized key
      }
    }

    const method = options?.method || 'GET';
    const response = await safeFetch(url, {
      method,
      headers: fetchHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? options?.body : undefined,
      signal: controller.signal,
    });

    // Check Content-Length before reading body (fast reject)
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new FetchResponseError('Response too large (max 10MB)');
    }

    // Read response body with streaming size limit
    const reader = response.body?.getReader();
    if (!reader) {
      throw new FetchResponseError('No response body');
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        reader.cancel();
        throw new FetchResponseError('Response too large (max 10MB)');
      }
      chunks.push(value);
    }

    const responseBuffer = Buffer.concat(chunks);

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    // Capture Set-Cookie headers into the cookie jar
    if (options?.cookieJarKey) {
      // response.headers.getSetCookie() preserves individual Set-Cookie values
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) {
        captureResponseCookies(
          options.cookieJarKey,
          url,
          // Pass individual Set-Cookie values joined — captureResponseCookies splits them
          { 'set-cookie': setCookies.join(', ') },
        );
      } else if (responseHeaders['set-cookie']) {
        // Fallback for runtimes without getSetCookie
        captureResponseCookies(options.cookieJarKey, url, responseHeaders);
      }
    }

    // Determine if response is text or binary
    const responseContentType = response.headers.get('content-type') || '';
    const isText =
      responseContentType.includes('text/') ||
      responseContentType.includes('json') ||
      responseContentType.includes('xml') ||
      responseContentType.includes('javascript') ||
      responseContentType.includes('css') ||
      responseContentType.includes('svg');

    const result: FetchResult = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: isText ? responseBuffer.toString('utf-8') : responseBuffer.toString('base64'),
    };

    if (!isText) {
      result.bodyEncoding = 'base64';
    }

    return result;
  } catch (err) {
    if (err instanceof FetchDomainError || err instanceof FetchResponseError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    if (message.includes('abort')) {
      throw new FetchTimeoutError('Request timed out');
    }
    throw new FetchNetworkError(message);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ── Error classes for callers to distinguish error types ──

export class FetchDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchDomainError';
  }
}

export class FetchResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchResponseError';
  }
}

export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

export class FetchNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchNetworkError';
  }
}
