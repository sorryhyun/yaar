/**
 * MCP HTTP Server for YAAR.
 *
 * Provides HTTP endpoints for MCP tool calls across 4 namespaced servers,
 * allowing multiple agents to connect independently without state corruption issues.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { registerAllTools } from './register.js';
import { runWithAgentId } from '../agents/session.js';

/** MCP server categories. */
export const MCP_SERVERS = ['system', 'window', 'storage', 'apps', 'dev'] as const;
export type McpServerName = (typeof MCP_SERVERS)[number];

interface McpServerEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const mcpServers = new Map<McpServerName, McpServerEntry>();

// Bearer token for MCP authentication (generated at startup)
let mcpToken: string | null = null;

// Skip auth in dev mode (set MCP_SKIP_AUTH=1)
const skipAuth = process.env.MCP_SKIP_AUTH === '1';

/**
 * Get the MCP authentication token.
 * Must be called after initMcpServer().
 */
export function getMcpToken(): string {
  if (!mcpToken) {
    throw new Error('MCP server not initialized');
  }
  return mcpToken;
}

/**
 * Initialize all 4 MCP servers with their respective tools.
 */
export async function initMcpServer(): Promise<void> {
  // Generate auth token for this session
  mcpToken = randomUUID();

  // Create all 4 servers
  const servers: Record<McpServerName, McpServer> = {} as Record<McpServerName, McpServer>;

  for (const name of MCP_SERVERS) {
    const server = new McpServer(
      { name, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    servers[name] = server;
  }

  // Register tools on their respective servers
  registerAllTools(servers);

  // Create transports and connect
  for (const name of MCP_SERVERS) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    await servers[name].connect(transport);

    mcpServers.set(name, {
      server: servers[name],
      transport,
    });
  }

  console.log(`[MCP] HTTP servers initialized (${MCP_SERVERS.join(', ')})${skipAuth ? ' (auth disabled)' : ''}`);
}

/**
 * Handle incoming MCP HTTP requests.
 * Routes to the correct server based on the sub-path.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serverName: McpServerName
): Promise<void> {
  if (!mcpToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MCP server not initialized' }));
    return;
  }

  const entry = mcpServers.get(serverName);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown MCP server: ${serverName}` }));
    return;
  }

  // Validate bearer token (skip in dev mode)
  if (!skipAuth) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${mcpToken}`) {
      console.log(`[MCP] Unauthorized request (invalid or missing token)`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  console.log(`[MCP] ${req.method} ${req.url}`);

  // Restore agent context from X-Agent-Id header (set by Claude provider)
  const agentId = req.headers['x-agent-id'];
  if (typeof agentId === 'string') {
    await runWithAgentId(agentId, () => entry.transport.handleRequest(req, res));
  } else {
    await entry.transport.handleRequest(req, res);
  }
}
