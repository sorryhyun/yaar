/**
 * Bridge route — direct HTTP access to the user's REAL browser tabs (via the YAAR Bridge extension).
 *
 * POST /api/bridge — dispatch a bridge action (listTabs, presence, focus, close, group, move,
 *                    track, extract).
 *
 * This is the symmetric counterpart to `/api/browser` (which drives the headless sandbox): the
 * `browser-user` app iframe calls it directly (iframe-token auth), and a monitor agent reaches it
 * only by driving that app through the App Protocol. There is no `yaar://browser` verb namespace —
 * control of the user's real browser is deliberately app-mediated. See `features/browser/bridge-actions.ts`.
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { requireBundle, resolvePrincipal, type Principal } from '../access.js';
import { getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import { runBridgeAction } from '../../features/browser/bridge-actions.js';
import type { EndpointMeta } from '../utils.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/bridge',
    response: 'json',
    description: "Observe/manage the user's real browser tabs via the YAAR Bridge extension",
  },
];

/**
 * The bridge observes and manages the user's *real* browser tabs through the
 * companion extension. It was gated on "holds some valid iframe token" — any app,
 * declared or not. It is `yaar-web` surface, so it is held to the same declaration.
 */
function requireAuth(req: Request, url: URL): Principal | Response {
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  if (principal.kind !== 'app') return errorResponse('Invalid or missing iframe token', 403);
  const denied = requireBundle(principal, 'yaar-web');
  if (denied) return denied;
  return principal;
}

export async function handleBridgeRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/bridge' || req.method !== 'POST') return null;

  const auth = requireAuth(req, url);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown>;
  try {
    const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
    body = JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return errorResponse('Request body too large', 413);
    return errorResponse('Invalid JSON body', 400);
  }

  const action = body.action as string;
  if (!action) return errorResponse('"action" is required', 400);

  const { action: _action, ...params } = body;
  // No agent context on this HTTP path (the iframe calls it): fall back to the default session so
  // per-origin consent grants still resolve to a real session. Mirrors the /api/browser route.
  const sessionId = getSessionId() ?? getSessionHub().getDefault()?.sessionId;

  try {
    const result = await runBridgeAction(action, params, sessionId);
    if (!result.ok) {
      return jsonResponse(
        { ok: false, error: result.error ?? 'Bridge error' },
        result.status ?? 400,
      );
    }
    return jsonResponse({ ok: true, data: result.data });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `Bridge error: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
}
