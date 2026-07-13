/**
 * REST API routes — health, providers, apps, agents/stats, remote-info,
 * iframe-token, pick-directory.
 */

import { getAvailableProviders, getWarmPool } from '../../providers/factory.js';
import { getAgentLimiter } from '../../agents/index.js';
import { listApps } from '../../features/apps/discovery.js';
import { getBroadcastCenter } from '../../session/broadcast-center.js';
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';
import { readSettings } from '../../storage/settings.js';
import { pickDirectory } from '../../lib/pick-directory.js';
import { getRemoteInfo } from '../../lifecycle.js';
import { generateAppIframeToken } from '../iframe-tokens.js';
import { requireHost, resolvePrincipal } from '../access.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/apps',
    response: '`{ apps: AppInfo[] }`',
    description: 'List all installed apps',
  },
];

export async function handleApiRoutes(req: Request, url: URL): Promise<Response | null> {
  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    return jsonResponse({ status: 'ok' });
  }

  // List available providers + active provider info
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const providers = await getAvailableProviders();
    const warmPoolStats = getWarmPool().getStats();
    return jsonResponse({
      providers,
      activeProvider: warmPoolStats.preferredProvider,
    });
  }

  // List available apps
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
  ];
  if (HOST_ONLY.includes(url.pathname)) {
    const principal = resolvePrincipal(req, url);
    if (principal instanceof Response) return principal;
    const denied = requireHost(principal);
    if (denied) return denied;
  }

  // Pick directory (native folder dialog)
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

  // Agent stats endpoint
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

  // Generate an iframe token for client-side window creation (e.g. desktop icon click).
  //
  // Host-only (see HOST_ONLY above), because the caller names the `appId` and gets back
  // a token carrying *that app's* permissions and its systemApp flag. Reachable by apps,
  // it is a privilege-escalation oracle: any app mints itself a bundled system app's
  // token and walks into yaar://session/*.
  if (url.pathname === '/api/iframe-token' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { windowId, sessionId, appId, monitorId } = body as {
        windowId?: string;
        sessionId?: string;
        appId?: string;
        monitorId?: string;
      };
      if (!windowId || !sessionId) {
        return errorResponse('windowId and sessionId are required', 400);
      }
      const token = await generateAppIframeToken(windowId, sessionId, { appId, monitorId });
      return jsonResponse({ token });
    } catch {
      return errorResponse('Invalid request body', 400);
    }
  }

  return null;
}
