/**
 * Remote Control routes — the only door to `features/remote-control.ts`.
 *
 * GET  /api/remote-control        — status, plus the caller's own `callerMonitorId`
 * POST /api/remote-control/start  — `{ name? }`; asks the user, then bridges the caller's monitor
 * POST /api/remote-control/stop   — take it off claude.ai
 *
 * ── Who may call these ──
 *
 * The desktop host and the bundled Remote Control app, nobody else. This used to be a
 * `yaar://system/remote-control` verb; it is off the verb surface now, so an agent goes
 * through the app's `start` command — the same path as the user's click, in a window that
 * shows the user what is on. `systemApp` comes from the bundled
 * manifest and cannot be self-granted (discovery.ts), so a user app that names itself
 * `remote-control` is still refused.
 *
 * The caller's monitor is the one it acts on: the app's comes from its iframe token, the
 * host's is monitor 0.
 */
import type { SessionId } from '@yaar/shared';
import {
  remoteControlStatus,
  startRemoteControl,
  stopRemoteControl,
} from '../../features/remote-control.js';
import { getSessionHub } from '../../session/session-hub.js';
import type { LiveSession } from '../../session/live-session.js';
import { resolvePrincipal } from '../access.js';
import { jsonResponse, errorResponse, parseJsonBody, type EndpointMeta } from '../utils.js';

const REMOTE_CONTROL_APP_ID = 'remote-control';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/remote-control',
    response: 'JSON',
    description: 'Remote Control status (host + the Remote Control app only).',
  },
  {
    method: 'POST',
    path: '/api/remote-control/start',
    response: 'JSON',
    description:
      "Put the caller's monitor agent on claude.ai after the user confirms (host + the Remote Control app only).",
  },
  {
    method: 'POST',
    path: '/api/remote-control/stop',
    response: 'JSON',
    description: 'Turn Remote Control off (host + the Remote Control app only).',
  },
];

interface Caller {
  session: LiveSession | undefined;
  monitorId: string;
}

function resolveCaller(req: Request, url: URL): Caller | Response {
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  const hub = getSessionHub();
  if (principal.kind === 'host') return { session: hub.getDefault(), monitorId: '0' };
  if (!principal.systemApp || principal.appId !== REMOTE_CONTROL_APP_ID) {
    return errorResponse('Remote Control is available only to the Remote Control app.', 403);
  }
  const session = hub.get(principal.sessionId as SessionId);
  const monitorId =
    principal.monitorId ?? session?.windowState.getMonitorForWindow(principal.windowId) ?? '0';
  return { session, monitorId };
}

export async function handleRemoteControlRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/remote-control' && !url.pathname.startsWith('/api/remote-control/')) {
    return null;
  }

  const caller = resolveCaller(req, url);
  if (caller instanceof Response) return caller;
  const pool = caller.session?.getPool() ?? null;

  if (url.pathname === '/api/remote-control' && req.method === 'GET') {
    return jsonResponse({ ...remoteControlStatus(pool), callerMonitorId: caller.monitorId });
  }

  if (url.pathname === '/api/remote-control/start' && req.method === 'POST') {
    const body = await parseJsonBody<{ name?: unknown }>(req, { allowEmpty: true });
    if (body instanceof Response) return body;
    if (!caller.session) return errorResponse('No active session.', 409);
    const name = typeof body?.name === 'string' && body.name ? body.name : undefined;
    const outcome = await startRemoteControl(caller.session, caller.monitorId, name);
    if (!outcome.ok) return errorResponse(outcome.error, outcome.status);
    return jsonResponse({ ...outcome.status, callerMonitorId: caller.monitorId });
  }

  if (url.pathname === '/api/remote-control/stop' && req.method === 'POST') {
    const stopped = await stopRemoteControl(pool);
    return jsonResponse({ stopped, ...remoteControlStatus(pool) });
  }

  return errorResponse('Not found', 404);
}
