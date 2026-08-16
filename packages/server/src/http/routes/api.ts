/**
 * REST API routes — health, providers, apps, agents/stats, remote-info,
 * iframe-token, pick-directory, embeddable.
 */

import { getAvailableProviders, getWarmPool } from '../../providers/factory.js';
import { getAgentLimiter } from '../../agents/index.js';
import { listApps } from '../../features/apps/discovery.js';
import { getBroadcastCenter } from '../../session/broadcast-center.js';
import { jsonResponse, errorResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import { readSettings } from '../../storage/settings.js';
import { pickDirectory } from '../../lib/pick-directory.js';
import { getRemoteInfo } from '../../lifecycle.js';
import { generateAppIframeToken } from '../iframe-tokens.js';
import { checkEmbeddable } from '../../features/http/embeddable.js';
import { requireHost, resolvePrincipal } from '../access.js';
import { IS_REMOTE, IS_BUNDLED_EXE, YAAR_VERSION } from '../../config.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/apps',
    response: '`{ apps: AppInfo[] }`',
    description: 'List all installed apps',
  },
  {
    method: 'GET',
    path: '/api/version',
    response: '`{ version, bundled, platform, arch }`',
    description: 'Running YAAR version and build shape',
  },
];

export async function handleApiRoutes(req: Request, url: URL): Promise<Response | null> {
  // Health check. `remote` tells an unauthenticated client whether reachability implies
  // access: /health is auth-exempt, so a bare visit to a REMOTE=1 server gets a 200 here
  // and used to be read as "local, no token needed" — after which every /api call 401'd
  // and the WS upgrade was refused, with no dialog to recover through. The flag is the
  // one bit a caller with no token is allowed to learn, and it names nothing secret.
  if (url.pathname === '/health' && req.method === 'GET') {
    return jsonResponse({ status: 'ok', remote: IS_REMOTE });
  }

  // What is running, and in which shape. Deliberately a REST route rather than a
  // `yaar://` resource: the version is what an app wants first, and a verb would
  // cost every such app a permission in its app.json. On PUBLIC_ENDPOINTS (the
  // iframe allowlist) with no permission check, exactly like /api/apps — it names
  // nothing of the user's, and a caller that can reach this server can already
  // fingerprint the build from the assets it serves.
  //
  // `bundled` is the field that matters to a caller deciding whether an update is
  // even applicable: only the standalone exe can be replaced by re-running the
  // installer. A git checkout updates with `git pull`, and platform/arch are here
  // so the caller can name the release asset without guessing from a user agent.
  if (url.pathname === '/api/version' && req.method === 'GET') {
    return jsonResponse({
      version: YAAR_VERSION,
      bundled: IS_BUNDLED_EXE,
      platform: process.platform,
      arch: process.arch,
    });
  }

  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const providers = await getAvailableProviders();
    const warmPoolStats = getWarmPool().getStats();
    return jsonResponse({
      providers,
      activeProvider: warmPoolStats.preferredProvider,
    });
  }

  if (url.pathname === '/api/apps' && req.method === 'GET') {
    try {
      const [apps, settings] = await Promise.all([listApps(), readSettings()]);
      return jsonResponse({
        apps,
        onboardingCompleted: settings.onboardingCompleted,
        userName: settings.userName,
        language: settings.language,
        provider: settings.provider,
        wallpaper: settings.wallpaper,
        accentColor: settings.accentColor,
        iconSize: settings.iconSize,
        theme: settings.theme,
      });
    } catch {
      return errorResponse('Failed to list apps');
    }
  }

  // ── Host-only routes ──
  // None of these is a resource an app could hold a permission for: a native folder
  // dialog on the user's machine, the remote access token itself, process-wide agent
  // stats, and the iframe-token mint. They belong to the desktop.
  const HOST_ONLY = [
    '/api/pick-directory',
    '/api/remote-info',
    '/api/agents/stats',
    '/api/iframe-token',
    '/api/embeddable',
  ];
  if (HOST_ONLY.includes(url.pathname)) {
    const principal = resolvePrincipal(req, url);
    if (principal instanceof Response) return principal;
    const denied = requireHost(principal);
    if (denied) return denied;
  }

  if (url.pathname === '/api/pick-directory' && req.method === 'POST') {
    try {
      const path = await pickDirectory();
      if (path) {
        return jsonResponse({ path });
      } else {
        return jsonResponse({ path: null, cancelled: true });
      }
    } catch {
      return errorResponse('Failed to open directory picker');
    }
  }

  // Remote connection info (QR code data)
  if (url.pathname === '/api/remote-info' && req.method === 'GET') {
    const info = getRemoteInfo();
    if (!info) return jsonResponse({ remote: false });
    return jsonResponse({ remote: true, ...info });
  }

  if (url.pathname === '/api/agents/stats' && req.method === 'GET') {
    const limiterStats = getAgentLimiter().getStats();
    const broadcastStats = getBroadcastCenter().getStats();
    const warmPoolStats = getWarmPool().getStats();
    return jsonResponse({
      agents: limiterStats,
      connections: broadcastStats,
      warmPool: warmPoolStats,
    });
  }

  // May the desktop frame this URL? Host-only (see HOST_ONLY above): the desktop asks
  // before it opens a window around an iframe, and the answer is only meaningful for
  // the desktop's own origin, which is the ancestor the browser would check.
  //
  // An app has no business here — it cannot open a window itself, and `yaar:open-url`
  // already routes its links through the desktop, which asks on its behalf.
  if (url.pathname === '/api/embeddable' && req.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) return errorResponse('Missing "url" query parameter', 400);
    // The desktop document's origin. `Origin` is absent on a same-origin GET in most
    // browsers, so the request URL — which is the origin the desktop reached us on —
    // is the fallback, and it is the same answer in every mode but origin isolation.
    const ancestorOrigin = req.headers.get('origin') || url.origin;
    try {
      return jsonResponse(await checkEmbeddable(target, ancestorOrigin));
    } catch (err) {
      // Only validateUrl throws — a scheme we won't fetch, or a private-network target.
      return errorResponse(err instanceof Error ? err.message : 'Invalid URL', 400);
    }
  }

  // Generate an iframe token for client-side window creation (e.g. desktop icon click).
  //
  // Host-only (see HOST_ONLY above), because the caller names the `appId` and gets back
  // a token carrying *that app's* permissions and its systemApp flag. Reachable by apps,
  // it is a privilege-escalation oracle: any app mints itself a bundled system app's
  // token and walks into yaar://session/*.
  if (url.pathname === '/api/iframe-token' && req.method === 'POST') {
    const body = await parseJsonBody<{
      windowId?: string;
      sessionId?: string;
      appId?: string;
      monitorId?: string;
    }>(req);
    if (body instanceof Response) return body;

    const { windowId, sessionId, appId, monitorId } = body;
    if (!windowId || !sessionId) {
      return errorResponse('windowId and sessionId are required', 400);
    }
    try {
      const token = await generateAppIframeToken(windowId, sessionId, { appId, monitorId });
      return jsonResponse({ token });
    } catch {
      return errorResponse('Failed to generate iframe token');
    }
  }

  return null;
}
