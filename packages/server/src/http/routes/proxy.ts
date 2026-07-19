/**
 * Fetch proxy route — the iframe door to cross-origin HTTP.
 *
 * Apps in iframes route cross-origin fetch through POST /api/fetch,
 * which delegates to performFetch() for SSRF protection and domain allowlist.
 *
 * This is an *app* door, like POST /api/verb: it resolves the caller to a
 * principal and names the URI it is about to reach (`yaar://http`), rather than
 * inventing its own check. It used to read the iframe token opportunistically —
 * an expired token silently downgraded the request to an anonymous, un-jarred
 * fetch instead of failing it, and no `yaar://http` permission was ever
 * consulted, so the transparent-proxy path was strictly weaker than the verb
 * path that reaches the very same performFetch().
 */

import { errorResponse, jsonResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import {
  performFetch,
  FetchDomainError,
  FetchResponseError,
  FetchTimeoutError,
} from '../../features/http/fetch.js';
import { resolvePrincipal, requirePermission } from '../access.js';
import { jarKey } from '../../features/http/cookie-jar.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/fetch',
    response: 'JSON',
    description:
      'Proxy HTTP request (for CORS-blocked APIs). Requires an iframe token; apps must ' +
      'declare `yaar://http`. Body: `{ url, method?, headers?, body? }`',
  },
];

export async function handleProxyRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/fetch' || req.method !== 'POST') {
    return null;
  }

  // Parse request body
  const body = await parseJsonBody<{
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Accepted for wire compatibility with older iframe scripts; ignored — see below. */
    sessionId?: string;
    redirect?: string;
  }>(req);
  if (body instanceof Response) return body;

  const targetUrl = body.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return errorResponse('Missing or invalid "url" field', 400);
  }

  // Resolve the caller. An invalid or expired token is a 403 from resolvePrincipal;
  // a request bearing *no* token resolves to the host, which this route refuses —
  // the desktop drives the server over the WebSocket and never posts here.
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  if (principal.kind !== 'app') {
    return errorResponse('Invalid or missing iframe token', 403);
  }

  // Only an app can *hold* a `yaar://http` permission. A plain (non-app) iframe
  // window — AI-generated HTML, no app.json — has no manifest to declare one in, so
  // gating it would deny cross-origin fetch with no way to opt in. It still passes
  // through the SSRF check and the domain allowlist below, which are the actual
  // network gate; what the permission adds for apps is a *declared* intent.
  if (principal.appId) {
    const denied = requirePermission(principal, 'yaar://http', 'invoke');
    if (denied) return denied;
  }

  // Session and cookie-jar identity come from the validated token only. The body's
  // `sessionId` and the Referer are caller-supplied and were previously trusted,
  // which let a request name a session it did not belong to — and so surface a
  // domain-approval dialog in someone else's session.
  const sessionId = principal.sessionId;
  const cookieJarKey = jarKey(principal.sessionId, principal.appId);

  try {
    const result = await performFetch(targetUrl, {
      method: body.method,
      headers: body.headers,
      body: body.body,
      sessionId,
      cookieJarKey,
      // `follow` is performFetch's default; anything that is not an explicit
      // `manual` falls back to it rather than being guessed at.
      redirect: body.redirect === 'manual' ? 'manual' : undefined,
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
