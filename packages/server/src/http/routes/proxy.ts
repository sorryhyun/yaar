/**
 * Fetch proxy route — enforces domain allowlist for iframe app HTTP requests.
 *
 * Apps in iframes route cross-origin fetch through POST /api/fetch,
 * which checks the domain against curl_allowed_domains.yaml.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { MAX_UPLOAD_SIZE } from '../../config.js';
import { sendError, sendJson, type EndpointMeta } from '../utils.js';

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

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const TIMEOUT_MS = 30_000;

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

/**
 * Collect the full request body as a string.
 */
function collectJsonBody(req: IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => reject(err));
  });
}

export async function handleProxyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/fetch' || req.method !== 'POST') {
    return false;
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
    const raw = await collectJsonBody(req, MAX_UPLOAD_SIZE);
    body = JSON.parse(raw);
  } catch {
    sendError(res, 'Invalid JSON body', 400);
    return true;
  }

  const targetUrl = body.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    sendError(res, 'Missing or invalid "url" field', 400);
    return true;
  }

  // Validate URL scheme
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    sendError(res, 'Invalid URL', 400);
    return true;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendError(res, 'Only http: and https: URLs are allowed', 400);
    return true;
  }

  // Block internal/private network access (SSRF protection)
  if (INTERNAL_HOSTNAME_PATTERNS.some((p) => p.test(parsed.hostname))) {
    sendError(res, 'Access to internal networks is not allowed', 403);
    return true;
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
      const referer = req.headers.referer;
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
      sendError(
        res,
        `Domain "${domain}" is not in the allowed list. Add it to curl_allowed_domains.yaml.`,
        403,
      );
      return true;
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
      sendError(res, `User denied access to domain "${domain}".`, 403);
      return true;
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

    const response = await fetch(targetUrl, {
      method: body.method || 'GET',
      headers: fetchHeaders,
      body: body.method && body.method !== 'GET' && body.method !== 'HEAD' ? body.body : undefined,
      signal: controller.signal,
    });

    // Check Content-Length before reading body (fast reject)
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      sendError(res, 'Response too large (max 10MB)', 502);
      return true;
    }

    // Read response body with streaming size limit
    const reader = response.body?.getReader();
    if (!reader) {
      sendError(res, 'No response body', 502);
      return true;
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        reader.cancel();
        sendError(res, 'Response too large (max 10MB)', 502);
        return true;
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

    sendJson(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    if (message.includes('abort')) {
      sendError(res, 'Request timed out', 504);
    } else {
      sendError(res, message, 502);
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return true;
}
