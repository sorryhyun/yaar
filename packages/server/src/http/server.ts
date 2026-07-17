/**
 * HTTP fetch handler — CORS, auth, MCP dispatch, route dispatch.
 *
 * Returns a function compatible with Bun.serve({ fetch }).
 * WebSocket upgrade is handled here too: when path is /ws, we return undefined
 * to signal to the caller that server.upgrade() should be called instead.
 */

import { handleMcpRequest, CORE_SERVERS, type McpServerName } from '../mcp/server.js';
import { getPort, IS_REMOTE } from '../config.js';

// ── Dev reload SSE handler (set by dev-bundler.ts) ──────────────────
let _devReloadHandler: (() => Response) | null = null;

/** Register the SSE handler for dev live-reload. Called by dev-bundler.ts. */
export function registerDevReloadHandler(handler: () => Response): void {
  _devReloadHandler = handler;
}
import { checkHttpAuth, checkWsAuth } from './auth.js';
import { prepareWsData, type WsData } from '../websocket/server.js';
import { generateConnectionId } from '../session/broadcast-center.js';
import {
  handleApiRoutes,
  handleAuthRoutes,
  handleBridgeRoutes,
  handleBrowserRoutes,
  handleDevRoutes,
  handleFileRoutes,
  handleMlRuntimeRoutes,
  handleProxyRoutes,
  handleSessionRoutes,
  handleSettingsRoutes,
  handleShortcutRoutes,
  handleStaticRoutes,
  handleVerbRoutes,
} from './routes/index.js';
import { validateIframeToken } from './iframe-tokens.js';
import { PUBLIC_ENDPOINTS as API_PUBLIC } from './routes/api.js';
import { PUBLIC_ENDPOINTS as AUTH_PUBLIC } from './routes/auth.js';
import { PUBLIC_ENDPOINTS as BRIDGE_PUBLIC } from './routes/bridge.js';
import { PUBLIC_ENDPOINTS as BROWSER_PUBLIC } from './routes/browser.js';
import { PUBLIC_ENDPOINTS as DEV_PUBLIC } from './routes/dev.js';
import { PUBLIC_ENDPOINTS as FILES_PUBLIC } from './routes/files.js';
import { PUBLIC_ENDPOINTS as ML_RUNTIME_PUBLIC } from './routes/ml-runtime.js';
import { PUBLIC_ENDPOINTS as PROXY_PUBLIC } from './routes/proxy.js';
import { PUBLIC_ENDPOINTS as SESSIONS_PUBLIC } from './routes/sessions.js';
import { PUBLIC_ENDPOINTS as SETTINGS_PUBLIC } from './routes/settings.js';
import { PUBLIC_ENDPOINTS as SHORTCUTS_PUBLIC } from './routes/shortcuts.js';
import { PUBLIC_ENDPOINTS as VERB_PUBLIC } from './routes/verb.js';

// ── Public endpoint matcher ──────────────────────────────────────────
// Build a set of { method, regex } from all route files' PUBLIC_ENDPOINTS.
// Path patterns like `/api/storage/{path}` become `/api/storage/.+`.
// Static routes (/health, frontend assets) are always allowed.

interface PublicRoute {
  method: string;
  pattern: RegExp;
}

function buildPublicRoutes(): PublicRoute[] {
  const all = [
    ...API_PUBLIC,
    ...AUTH_PUBLIC,
    ...BRIDGE_PUBLIC,
    ...BROWSER_PUBLIC,
    ...DEV_PUBLIC,
    ...FILES_PUBLIC,
    ...ML_RUNTIME_PUBLIC,
    ...PROXY_PUBLIC,
    ...SESSIONS_PUBLIC,
    ...SETTINGS_PUBLIC,
    ...SHORTCUTS_PUBLIC,
    ...VERB_PUBLIC,
  ];
  return all.map((ep) => {
    // Strip query string from path pattern
    const pathOnly = ep.path.split('?')[0];
    // Convert {param} placeholders to .+ and anchor
    const regexStr = '^' + pathOnly.replace(/\{[^}]+\}/g, '[^/]+') + '(/.*)?$';
    return { method: ep.method, pattern: new RegExp(regexStr) };
  });
}

const publicRoutes = buildPublicRoutes();

function isPublicRoute(method: string, pathname: string): boolean {
  // Health and static assets are always public
  if (pathname === '/health') return true;
  // Frontend static files (served by static.ts) are always public
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/mcp/')) return true;

  return publicRoutes.some((r) => r.method === method && r.pattern.test(pathname));
}

export function createFetchHandler() {
  return async (req: Request, server: import('bun').Server<WsData>) => {
    const url = new URL(req.url, `http://localhost:${getPort()}`);

    // WebSocket upgrade — auth + upgrade happen here, handlers in websocket config
    if (url.pathname === '/ws') {
      const { authorized, data } = prepareWsData(url);
      if (!authorized) {
        return new Response('Unauthorized', { status: 401 });
      }
      const success = server.upgrade(req, { data });
      if (success) return undefined; // Bun handles the rest
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // YAAR Bridge WebSocket — the companion extension dials out to here (see extension/).
    if (url.pathname === '/bridge') {
      if (!checkWsAuth(url)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const data: WsData = {
        kind: 'bridge',
        connectionId: generateConnectionId(),
        sessionId: null,
        monitorId: null,
      };
      const success = server.upgrade(req, { data });
      if (success) return undefined;
      return new Response('Bridge upgrade failed', { status: 500 });
    }

    // CORS headers
    const origin = req.headers.get('origin');
    const corsHeaders: Record<string, string> = {};

    if (IS_REMOTE) {
      // Remote mode: allow any requesting origin
      if (origin) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
        corsHeaders['Access-Control-Allow-Headers'] =
          'Content-Type, Authorization, X-Iframe-Token, X-Yaar-Client';
        corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      }
    } else {
      // Local mode: whitelist localhost origins (same-origin requests won't have Origin header)
      const allowedOrigins = [`http://localhost:${getPort()}`];
      if (origin && allowedOrigins.includes(origin)) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
        corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type, X-Iframe-Token, X-Yaar-Client';
        corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      }
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth gate (no-op when !IS_REMOTE; /health always exempt)
    const authResponse = checkHttpAuth(req, url);
    if (authResponse) return withCors(authResponse, corsHeaders);

    // ── Iframe route restriction ───────────────────────────────────────
    // Phase A: Sec-Fetch-Dest check — browser-enforced, cannot be spoofed.
    // Catches iframe document loads (initial page load in <iframe>).
    const secFetchDest = req.headers.get('sec-fetch-dest');
    if (secFetchDest === 'iframe' && !isPublicRoute(req.method, url.pathname)) {
      return withCors(
        Response.json({ error: 'Route not available to iframe apps' }, { status: 403 }),
        corsHeaders,
      );
    }

    // Phase B: Iframe-scoped token check — catches fetch() calls from within iframes.
    // A route not on the iframe allowlist is refused outright; the routes that *are*
    // on it then run the permission check in http/access.ts. This is the coarse gate,
    // not the only one.
    const iframeToken = req.headers.get('x-iframe-token');
    if (iframeToken) {
      const tokenEntry = validateIframeToken(iframeToken);

      // An invalid or expired token used to fall through here and be handled as a
      // *host* request — so an app whose token had merely aged out silently gained
      // full access instead of losing it. Presenting a token is a claim of identity;
      // a claim that doesn't check out is refused, not promoted.
      if (!tokenEntry) {
        return withCors(
          Response.json({ error: 'Invalid or expired iframe token' }, { status: 403 }),
          corsHeaders,
        );
      }

      if (!isPublicRoute(req.method, url.pathname)) {
        return withCors(
          Response.json({ error: 'Route not available to iframe apps' }, { status: 403 }),
          corsHeaders,
        );
      }
      // Per-app route scoping: block cross-app static file access
      if (tokenEntry.appId && url.pathname.startsWith('/api/apps/')) {
        const appsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\//);
        if (appsMatch && appsMatch[1] !== tokenEntry.appId) {
          return withCors(
            Response.json({ error: 'Cross-app access denied' }, { status: 403 }),
            corsHeaders,
          );
        }
      }
    }

    // MCP endpoints for tool calls (/mcp/system, /mcp/window, /mcp/apps, /mcp/basic, ...)
    const mcpMatch = url.pathname.match(/^\/mcp\/(\w+)$/);
    if (mcpMatch && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      const serverName = mcpMatch[1] as McpServerName;
      if ((CORE_SERVERS as readonly string[]).includes(serverName)) {
        const response = await handleMcpRequest(req, serverName);
        return withCors(response, corsHeaders);
      }
    }

    // Dev live-reload SSE endpoint
    if (_devReloadHandler && url.pathname === '/dev-reload') {
      return _devReloadHandler();
    }

    // Route dispatch — short-circuit on first match
    const apiResponse = await handleApiRoutes(req, url);
    if (apiResponse) return withCors(apiResponse, corsHeaders);

    const googleAuthResponse = await handleAuthRoutes(req, url);
    if (googleAuthResponse) return withCors(googleAuthResponse, corsHeaders);

    const shortcutResponse = await handleShortcutRoutes(req, url);
    if (shortcutResponse) return withCors(shortcutResponse, corsHeaders);

    const sessionResponse = await handleSessionRoutes(req, url);
    if (sessionResponse) return withCors(sessionResponse, corsHeaders);

    const settingsResponse = await handleSettingsRoutes(req, url);
    if (settingsResponse) return withCors(settingsResponse, corsHeaders);

    const proxyResponse = await handleProxyRoutes(req, url);
    if (proxyResponse) return withCors(proxyResponse, corsHeaders);

    const bridgeResponse = await handleBridgeRoutes(req, url);
    if (bridgeResponse) return withCors(bridgeResponse, corsHeaders);

    const browserResponse = await handleBrowserRoutes(req, url);
    if (browserResponse) return withCors(browserResponse, corsHeaders);

    const devResponse = await handleDevRoutes(req, url);
    if (devResponse) return withCors(devResponse, corsHeaders);

    const verbResponse = await handleVerbRoutes(req, url);
    if (verbResponse) return withCors(verbResponse, corsHeaders);

    const mlRuntimeResponse = await handleMlRuntimeRoutes(req, url);
    if (mlRuntimeResponse) return withCors(mlRuntimeResponse, corsHeaders);

    const fileResponse = await handleFileRoutes(req, url);
    if (fileResponse) return withCors(fileResponse, corsHeaders);

    const staticResponse = await handleStaticRoutes(req, url);
    if (staticResponse) return withCors(staticResponse, corsHeaders);

    // 404 for unknown routes
    return withCors(Response.json({ error: 'Not found' }, { status: 404 }), corsHeaders);
  };
}

/** Append CORS headers to a Response. */
function withCors(response: Response, corsHeaders: Record<string, string>): Response {
  if (Object.keys(corsHeaders).length === 0) return response;
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
