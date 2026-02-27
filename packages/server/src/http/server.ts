/**
 * HTTP fetch handler — CORS, auth, MCP dispatch, route dispatch.
 *
 * Returns a function compatible with Bun.serve({ fetch }).
 * WebSocket upgrade is handled here too: when path is /ws, we return undefined
 * to signal to the caller that server.upgrade() should be called instead.
 */

import { handleMcpRequest, MCP_SERVERS, type McpServerName } from '../mcp/server.js';
import { PORT, IS_REMOTE } from '../config.js';
import { checkHttpAuth } from './auth.js';
import { prepareWsData, type WsData } from '../websocket/server.js';
import {
  handleApiRoutes,
  handleFileRoutes,
  handleProxyRoutes,
  handleStaticRoutes,
} from './routes/index.js';

export function createFetchHandler() {
  return async (req: Request, server: import('bun').Server<WsData>) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

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
        corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
        corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      }
    } else {
      // Local mode: whitelist localhost origins
      const allowedOrigins = ['http://localhost:5173', 'http://localhost:3000'];
      if (origin && allowedOrigins.includes(origin)) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
        corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
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

    // MCP endpoints for tool calls (/mcp/system, /mcp/window, /mcp/storage, /mcp/apps)
    const mcpMatch = url.pathname.match(/^\/mcp\/(\w+)$/);
    if (mcpMatch && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      const serverName = mcpMatch[1] as McpServerName;
      if ((MCP_SERVERS as readonly string[]).includes(serverName)) {
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
