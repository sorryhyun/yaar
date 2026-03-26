/**
 * Fetch proxy route — enforces domain allowlist for iframe app HTTP requests.
 *
 * Apps in iframes route cross-origin fetch through POST /api/fetch,
 * which delegates to performFetch() for SSRF protection and domain allowlist.
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import {
  performFetch,
  FetchDomainError,
  FetchResponseError,
  FetchTimeoutError,
} from '../../features/http/fetch.js';
import { validateIframeToken } from '../iframe-tokens.js';
import { jarKey } from '../../features/http/cookie-jar.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/fetch',
    response: 'JSON',
    description:
      'Proxy HTTP request (for CORS-blocked APIs). Body: `{ url, method?, headers?, body? }`',
  },
];

export async function handleProxyRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/fetch' || req.method !== 'POST') {
    return null;
  }

  // Parse request body
  let body: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    sessionId?: string;
  };
  try {
    const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
    body = JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return errorResponse('Request body too large', 413);
    }
    return errorResponse('Invalid JSON body', 400);
  }

  const targetUrl = body.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return errorResponse('Missing or invalid "url" field', 400);
  }

  // Resolve sessionId from request context for permission dialogs.
  // The iframe URL may carry a stale/restored sessionId, so we also check
  // the Referer header and fall back to the default session.
  let sessionId = body.sessionId;
  if (!sessionId) {
    const referer = req.headers.get('referer');
    if (referer) {
      try {
        sessionId = new URL(referer).searchParams.get('sessionId') ?? undefined;
      } catch {
        /* invalid referer URL */
      }
    }
  }

  // Resolve cookie jar key from iframe token context
  let cookieJarKey: string | undefined;
  const iframeToken = req.headers.get('x-iframe-token');
  if (iframeToken) {
    const tokenEntry = validateIframeToken(iframeToken);
    if (tokenEntry) {
      cookieJarKey = jarKey(tokenEntry.sessionId, tokenEntry.appId);
      // Also use token's sessionId if none was provided explicitly
      if (!sessionId) sessionId = tokenEntry.sessionId;
    }
  }

  try {
    const result = await performFetch(targetUrl, {
      method: body.method,
      headers: body.headers,
      body: body.body,
      sessionId,
      cookieJarKey,
    });
    return jsonResponse(result);
  } catch (err) {
    if (err instanceof FetchDomainError) {
      return errorResponse(err.message, 403);
    }
    if (err instanceof FetchResponseError) {
      return errorResponse(err.message, 502);
    }
    if (err instanceof FetchTimeoutError) {
      return errorResponse(err.message, 504);
    }
    // URL validation errors (from validateUrl)
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    if (
      message.includes('Invalid URL') ||
      message.includes('Only http:') ||
      message.includes('internal networks')
    ) {
      return errorResponse(message, 400);
    }
    return errorResponse(message, 502);
  }
}
