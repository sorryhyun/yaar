/**
 * Fetch proxy route — enforces domain allowlist for iframe app HTTP requests.
 *
 * Apps in iframes route cross-origin fetch through POST /api/fetch,
 * which checks the domain against curl_allowed_domains.yaml.
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/fetch',
    response: 'JSON',
    description:
      'Proxy HTTP request (for CORS-blocked APIs). Body: `{ url, method?, headers?, body? }`',
  },
];
import { extractDomain, isDomainAllowed, addAllowedDomain } from '../../mcp/domains.js';
import { actionEmitter } from '../../mcp/action-emitter.js';
import { validateUrl, safeFetch } from '../../lib/ssrf.js';

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const TIMEOUT_MS = 30_000;

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

  // Validate URL scheme, format, and block internal networks (SSRF protection)
  try {
    validateUrl(targetUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid URL';
    return errorResponse(message, 400);
  }

  // Check domain allowlist — show permission dialog if sessionId is available
  const domain = extractDomain(targetUrl);
  if (!(await isDomainAllowed(domain))) {
    // Resolve a valid LiveSession sessionId.
    // The iframe URL may carry a stale/restored sessionId that doesn't match
    // any current LiveSession, so we validate against the SessionHub and fall
    // back to the default session.
    const { getSessionHub } = await import('../../session/live-session.js');
    const hub = getSessionHub();

    let sessionId: string | undefined;

    // 1. Request body (set by fetch proxy script) — validate it's a live session
    if (body.sessionId && hub.get(body.sessionId)) {
      sessionId = body.sessionId;
    }

    // 2. Referer header (iframe URL may contain ?sessionId=)
    if (!sessionId) {
      const referer = req.headers.get('referer');
      if (referer) {
        try {
          const refId = new URL(referer).searchParams.get('sessionId') ?? undefined;
          if (refId && hub.get(refId)) {
            sessionId = refId;
          }
        } catch {
          /* invalid referer URL */
        }
      }
    }

    // 3. Default session (fallback for stale/mismatched IDs)
    if (!sessionId) {
      sessionId = hub.getDefault()?.sessionId;
    }

    if (!sessionId) {
      return errorResponse(
        `Domain "${domain}" is not in the allowed list. Add it to curl_allowed_domains.yaml.`,
        403,
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
      return errorResponse(`User denied access to domain "${domain}".`, 403);
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
    if (body.headers) {
      for (const [k, v] of Object.entries(body.headers)) {
        // Skip host/origin headers that shouldn't be forwarded
        const lower = k.toLowerCase();
        if (lower === 'host' || lower === 'origin' || lower === 'referer') continue;
        fetchHeaders[k] = v;
      }
    }

    const response = await safeFetch(targetUrl, {
      method: body.method || 'GET',
      headers: fetchHeaders,
      body: body.method && body.method !== 'GET' && body.method !== 'HEAD' ? body.body : undefined,
      signal: controller.signal,
    });

    // Check Content-Length before reading body (fast reject)
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      return errorResponse('Response too large (max 10MB)', 502);
    }

    // Read response body with streaming size limit
    const reader = response.body?.getReader();
    if (!reader) {
      return errorResponse('No response body', 502);
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        reader.cancel();
        return errorResponse('Response too large (max 10MB)', 502);
      }
      chunks.push(value);
    }

    const responseBuffer = Buffer.concat(chunks);

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    // Determine if response is text or binary
    const responseContentType = response.headers.get('content-type') || '';
    const isText =
      responseContentType.includes('text/') ||
      responseContentType.includes('json') ||
      responseContentType.includes('xml') ||
      responseContentType.includes('javascript') ||
      responseContentType.includes('css') ||
      responseContentType.includes('svg');

    const result: Record<string, unknown> = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    };

    if (isText) {
      result.body = responseBuffer.toString('utf-8');
    } else {
      result.body = responseBuffer.toString('base64');
      result.bodyEncoding = 'base64';
    }

    return jsonResponse(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    if (message.includes('abort')) {
      return errorResponse('Request timed out', 504);
    } else {
      return errorResponse(message, 502);
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
