/**
 * MCP HTTP Server for YAAR.
 *
 * Provides HTTP endpoints for MCP tool calls across namespaced servers,
 * allowing multiple agents to connect independently without state corruption issues.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { runWithAgentContext } from '../agents/session.js';
import { getSessionHub } from '../session/live-session.js';
import { registerSystemTools, SYSTEM_TOOL_NAMES } from './system/index.js';
import { registerWindowTools, WINDOW_TOOL_NAMES } from './window/index.js';
import { registerStorageTools, STORAGE_TOOL_NAMES } from './storage/index.js';
import { registerAppsTools, APPS_TOOL_NAMES } from './apps/index.js';
import { registerHttpTools, HTTP_TOOL_NAMES } from './http/index.js';
import { registerAppDevTools, DEV_TOOL_NAMES } from './dev/index.js';
import { registerSkillTools, SKILL_TOOL_NAMES } from './skills/index.js';
import { registerReloadTools, RELOAD_TOOL_NAMES } from '../reload/tools.js';
import type { WindowStateRegistry } from './window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { registerUserTools, USER_TOOL_NAMES } from './user/index.js';
import { registerBrowserTools, BROWSER_TOOL_NAMES } from './browser/index.js';

/** MCP server categories. */
export const MCP_SERVERS = [
  'system',
  'window',
  'storage',
  'apps',
  'user',
  'dev',
  'browser',
] as const;
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
 * Register all YAAR tools on their respective MCP servers.
 */
function registerAllTools(servers: Record<McpServerName, McpServer>): void {
  const getWindowState = (): WindowStateRegistry => {
    const session = getSessionHub().getDefault();
    if (!session) throw new Error('No active session — connect via WebSocket first.');
    return session.windowState;
  };
  const getReloadCache = (): ReloadCache => {
    const session = getSessionHub().getDefault();
    if (!session) throw new Error('No active session — connect via WebSocket first.');
    return session.reloadCache;
  };

  registerSystemTools(servers.system);
  registerSkillTools(servers.system);
  registerHttpTools(servers.system);
  registerWindowTools(servers.window, getWindowState);
  registerStorageTools(servers.storage);
  registerAppsTools(servers.apps);
  registerUserTools(servers.user);
  registerAppDevTools(servers.dev);
  registerReloadTools(servers.system, getReloadCache, getWindowState);

  // Browser tools (conditional — only if Chrome/Edge is available)
  registerBrowserTools(servers.browser).catch(() => {
    // Chrome not found — browser tools unavailable
  });
}

/**
 * Initialize all MCP servers with their respective tools.
 */
export async function initMcpServer(): Promise<void> {
  // Generate auth token for this session
  mcpToken = randomUUID();

  const servers: Record<McpServerName, McpServer> = {} as Record<McpServerName, McpServer>;

  for (const name of MCP_SERVERS) {
    const server = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
    servers[name] = server;
  }

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

  console.log(
    `[MCP] HTTP servers initialized (${MCP_SERVERS.join(', ')})${skipAuth ? ' (auth disabled)' : ''}`,
  );
}

/**
 * Handle incoming MCP HTTP requests.
 * Routes to the correct server based on the sub-path.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serverName: McpServerName,
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

  // Restore agent context so tools can resolve the active session.
  // X-Agent-Id is set by the Claude provider; Codex calls omit it.
  const agentId = (req.headers['x-agent-id'] as string | undefined) ?? 'unknown';
  const sessionId = getSessionHub().getDefault()?.sessionId;
  await runWithAgentContext({ agentId, sessionId }, () => entry.transport.handleRequest(req, res));
}

/**
 * Format a raw MCP tool name for CLI display.
 * "mcp__apps__read_ts" → "apps:read_ts"
 */
export function formatToolDisplay(raw: string): string {
  const m = raw.match(/^mcp__(\w+)__(.+)$/);
  if (m) return `${m[1]}:${m[2]}`;
  return raw;
}

/**
 * Get the list of MCP tool names for YAAR.
 */
export function getToolNames(): string[] {
  return [
    'WebSearch',
    ...SYSTEM_TOOL_NAMES,
    ...SKILL_TOOL_NAMES,
    ...HTTP_TOOL_NAMES,
    ...WINDOW_TOOL_NAMES,
    ...STORAGE_TOOL_NAMES,
    ...APPS_TOOL_NAMES,
    ...USER_TOOL_NAMES,
    ...DEV_TOOL_NAMES,
    ...RELOAD_TOOL_NAMES,
    ...BROWSER_TOOL_NAMES,
  ];
}
