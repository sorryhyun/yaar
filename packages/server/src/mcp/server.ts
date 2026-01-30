/**
 * MCP HTTP Server for ClaudeOS.
 *
 * Provides an HTTP endpoint for MCP tool calls, allowing multiple agents
 * to connect independently without state corruption issues.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { registerAllTools } from './tools/index.js';

let mcpServer: McpServer | null = null;
let transport: StreamableHTTPServerTransport | null = null;

/**
 * Initialize the MCP server with all ClaudeOS tools.
 */
export async function initMcpServer(): Promise<void> {
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
  console.log('[MCP] HTTP server initialized');
}

/**
 * Handle incoming MCP HTTP requests.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!transport) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MCP server not initialized' }));
    return;
  }

  console.log(`[MCP] ${req.method} ${req.url}`);
  await transport.handleRequest(req, res);
}
