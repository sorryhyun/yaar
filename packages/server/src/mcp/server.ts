/**
 * MCP HTTP Server for ClaudeOS.
 *
 * Provides an HTTP endpoint for MCP tool calls, allowing multiple agents
 * to connect independently without state corruption issues.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { registerAllTools } from './tools/index.js';

let mcpServer: McpServer | null = null;
let transport: StreamableHTTPServerTransport | null = null;

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
 * Initialize the MCP server with all ClaudeOS tools.
 */
export async function initMcpServer(): Promise<void> {
  // Generate auth token for this session
  mcpToken = randomUUID();

  mcpServer = new McpServer(
    { name: 'claudeos', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Register all tools
  registerAllTools(mcpServer);

  // Create HTTP transport in stateless mode
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  await mcpServer.connect(transport);
  console.log(`[MCP] HTTP server initialized${skipAuth ? ' (auth disabled)' : ''}`);
}

/**
 * Handle incoming MCP HTTP requests.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!transport || !mcpToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MCP server not initialized' }));
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
  await transport.handleRequest(req, res);
}
