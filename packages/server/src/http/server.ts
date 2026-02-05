/**
 * HTTP server factory — CORS, MCP dispatch, route dispatch.
 */

import { createServer, type Server } from 'http';
import { handleMcpRequest, MCP_SERVERS, type McpServerName } from '../mcp/server.js';
import { PORT } from '../config.js';
import { sendJson } from './utils.js';
import { handleApiRoutes, handleFileRoutes, handleStaticRoutes } from './routes/index.js';

export function createHttpServer(): Server {
  return createServer(async (req, res) => {
    // CORS headers
    const origin = req.headers.origin;
    const allowedOrigins = ['http://localhost:5173', 'http://localhost:3000'];

    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    // MCP endpoints for tool calls (/mcp/system, /mcp/window, /mcp/storage, /mcp/apps)
    const mcpMatch = url.pathname.match(/^\/mcp\/(\w+)$/);
    if (mcpMatch && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      const serverName = mcpMatch[1] as McpServerName;
      if ((MCP_SERVERS as readonly string[]).includes(serverName)) {
        await handleMcpRequest(req, res, serverName);
        return;
      }
    }

    // Route dispatch — short-circuit on first match
    if (await handleApiRoutes(req, res, url)) return;
    if (await handleFileRoutes(req, res, url)) return;
    if (await handleStaticRoutes(req, res, url)) return;

    // 404 for unknown routes
    sendJson(res, { error: 'Not found' }, 404);
  });
}
