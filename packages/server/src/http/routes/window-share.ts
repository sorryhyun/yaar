/**
 * Window share routes — the titlebar's share button (`features/window/external-share.ts`).
 *
 * GET  /api/window-share?windowId=…&sessionId=…  — `{ shared, path?, localUrl? }`
 * POST /api/window-share  `{ windowId, sessionId?, shared }` — share or unshare; same answer
 *
 * `path` is `/mcp/window/{token}`: the credential itself, answered only to the tab that asks.
 * `localUrl` is that path on the plain loopback socket, which is what a local agent should
 * be handed. The desktop's own origin is the wrong base: on the local TLS socket
 * (`https://localhost:8443`, http/local-tls.ts) it names a self-signed certificate that
 * Node, Bun and so Claude Code refuse, and the MCP client fails before sending a byte.
 * A remote desktop still builds on its remote server URL, which carries a real one.
 *
 * Host-only. Pressing the button *is* the user's consent, so the route must be one only the
 * desktop can reach — an app iframe that could call it would share itself, or any other
 * window, with whoever it liked.
 */
import type { SessionId } from '@yaar/shared';
import { getSessionHub } from '../../session/session-hub.js';
import type { LiveSession } from '../../session/live-session.js';
import { EXTERNAL_MCP_PREFIX, setWindowShared } from '../../features/window/external-share.js';
import { requireHost, resolvePrincipal } from '../access.js';
import { jsonResponse, errorResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import { getPort } from '../../config.js';
import { getBindHostname } from '../../lifecycle.js';

/** Host-only, so nothing here is on the iframe allowlist (the same shape as sessions.ts). */
export const PUBLIC_ENDPOINTS: EndpointMeta[] = [];

const ROUTE = '/api/window-share';

function sessionFor(sessionId: string | null | undefined): LiveSession | undefined {
  const hub = getSessionHub();
  return sessionId ? hub.get(sessionId as SessionId) : hub.getDefault();
}

function answer(token: string | undefined): Response {
  if (!token) return jsonResponse({ shared: false });
  const path = `${EXTERNAL_MCP_PREFIX}${token}`;
  return jsonResponse({
    shared: true,
    path,
    localUrl: `http://${getBindHostname()}:${getPort()}${path}`,
  });
}

export async function handleWindowShareRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null;

  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  const denied = requireHost(principal);
  if (denied) return denied;

  if (req.method === 'GET') {
    const windowId = url.searchParams.get('windowId');
    if (!windowId) return errorResponse('windowId is required', 400);
    const session = sessionFor(url.searchParams.get('sessionId'));
    if (!session) return errorResponse('No such session', 404);
    return answer(session.windowState.getExternalShareToken(windowId));
  }

  if (req.method === 'POST') {
    const body = await parseJsonBody<{ windowId?: string; sessionId?: string; shared?: boolean }>(
      req,
    );
    if (body instanceof Response) return body;
    if (!body.windowId || typeof body.shared !== 'boolean') {
      return errorResponse('windowId and shared (boolean) are required', 400);
    }
    const session = sessionFor(body.sessionId);
    if (!session) return errorResponse('No such session', 404);
    const result = setWindowShared(session, body.windowId, body.shared);
    if (!result.ok) return errorResponse(result.error, 400);
    return answer(result.token);
  }

  return errorResponse('Method not allowed', 405);
}
