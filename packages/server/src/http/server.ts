/**
 * HTTP fetch handler — CORS, auth, MCP dispatch, route dispatch.
 *
 * Returns a function compatible with Bun.serve({ fetch }).
 * WebSocket upgrade is handled here too: when path is /ws, we return undefined
 * to signal to the caller that server.upgrade() should be called instead.
 */

import { handleMcpRequest, CORE_SERVERS, type McpServerName } from '../mcp/server.js';
import { getPort, IS_REMOTE } from '../config.js';
import { checkHttpAuth } from './auth.js';
import { prepareWsData, type WsData } from '../websocket/server.js';
import {
  handleApiRoutes,
  handleFileRoutes,
  handleProxyRoutes,
  handleStaticRoutes,
} from './routes/index.js';
import { validateIframeToken } from './iframe-tokens.js';
import { PUBLIC_ENDPOINTS as API_PUBLIC } from './routes/api.js';
import { PUBLIC_ENDPOINTS as FILES_PUBLIC } from './routes/files.js';
import { PUBLIC_ENDPOINTS as PROXY_PUBLIC } from './routes/proxy.js';

// ── Public endpoint matcher ──────────────────────────────────────────
// Build a set of { method, regex } from all route files' PUBLIC_ENDPOINTS.
// Path patterns like `/api/storage/{path}` become `/api/storage/.+`.
// Static routes (/health, frontend assets) are always allowed.

interface PublicRoute {
  method: string;
  pattern: RegExp;
}

function buildPublicRoutes(): PublicRoute[] {
  const all = [...API_PUBLIC, ...FILES_PUBLIC, ...PROXY_PUBLIC];
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
      // Local mode: whitelist localhost origins
      const allowedOrigins = ['http://localhost:5173', 'http://localhost:3000'];
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
    // If X-Iframe-Token is present and valid, restrict to public routes only.
    const iframeToken = req.headers.get('x-iframe-token');
    if (iframeToken) {
      const tokenEntry = validateIframeToken(iframeToken);
      if (tokenEntry && !isPublicRoute(req.method, url.pathname)) {
        return withCors(
          Response.json({ error: 'Route not available to iframe apps' }, { status: 403 }),
          corsHeaders,
        );
      }
      // Per-app route scoping: block cross-app static file access
      if (tokenEntry?.appId) {
        const appsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\//);
        if (appsMatch && appsMatch[1] !== tokenEntry.appId) {
          return withCors(
            Response.json({ error: 'Cross-app access denied' }, { status: 403 }),
            corsHeaders,
          );
        }
      }
      // Invalid/expired token — treat as host request (don't block)
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

    // Route dispatch — short-circuit on first match
    const apiResponse = await handleApiRoutes(req, url);
    if (apiResponse) return withCors(apiResponse, corsHeaders);

    const proxyResponse = await handleProxyRoutes(req, url);
    if (proxyResponse) return withCors(proxyResponse, corsHeaders);

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
