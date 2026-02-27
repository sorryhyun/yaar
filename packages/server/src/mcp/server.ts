/**
 * MCP HTTP Server for YAAR.
 *
 * Provides HTTP endpoints for MCP tool calls across namespaced servers,
 * allowing multiple agents to connect independently without state corruption issues.
 *
 * Uses stateful mode (sessionIdGenerator) so each SDK client gets its own MCP
 * session. The transport is created on the first `initialize` request from each
 * client and reused for subsequent requests carrying the same session ID.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
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
import { registerBrowserTools, BROWSER_TOOL_NAMES, isBrowserAvailable } from './browser/index.js';

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

/**
 * Per-session MCP transport entry.
 * Each Claude SDK client gets its own McpServer + transport pair per server name.
 */
interface McpSessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

/**
 * Map of `${serverName}:${mcpSessionId}` -> McpSessionEntry.
 * Created on `initialize` requests, reused for subsequent calls.
 */
const mcpSessions = new Map<string, McpSessionEntry>();

// Bearer token for MCP authentication (generated at startup)
let mcpToken: string | null = null;

// Skip auth in dev mode (set MCP_SKIP_AUTH=1)
const skipAuth = process.env.MCP_SKIP_AUTH === '1';

// Track whether the module has been initialized
let initialized = false;

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
 * Create a fresh McpServer for a single namespace and register its tools.
 * Called per-session so each SDK client gets its own server instance.
 */
async function createServerForName(name: McpServerName): Promise<McpServer> {
  const server = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });

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

  switch (name) {
    case 'system':
      registerSystemTools(server);
      registerSkillTools(server);
      registerHttpTools(server);
      registerReloadTools(server, getReloadCache, getWindowState);
      break;
    case 'window':
      registerWindowTools(server, getWindowState);
      break;
    case 'storage':
      registerStorageTools(server);
      break;
    case 'apps':
      registerAppsTools(server);
      break;
    case 'user':
      registerUserTools(server);
      break;
    case 'dev':
      registerAppDevTools(server);
      break;
    case 'browser':
      await registerBrowserTools(server);
      break;
  }

  return server;
}

/**
 * Initialize MCP subsystem.
 * Generates the auth token and probes browser availability.
 * Actual per-session McpServer instances are created on demand in handleMcpRequest.
 */
export async function initMcpServer(): Promise<void> {
  // Generate auth token for this session
  mcpToken = randomUUID();

  // Probe browser availability once at startup so isBrowserAvailable() is set.
  // We create a temporary server just for the probe, then discard it.
  const probeServer = new McpServer(
    { name: 'browser', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  await registerBrowserTools(probeServer);

  initialized = true;
  console.log(
    `[MCP] HTTP server initialized (${MCP_SERVERS.join(', ')})${skipAuth ? ' (auth disabled)' : ''}`,
  );
}

/**
 * Handle incoming MCP HTTP requests using web-standard Request/Response.
 *
 * Uses the stateful-per-session pattern from the MCP SDK:
 * - On `initialize` requests: create a new McpServer + transport, store by session ID
 * - On subsequent requests: look up the transport by the `mcp-session-id` header
 */
export async function handleMcpRequest(req: Request, serverName: McpServerName): Promise<Response> {
  if (!mcpToken || !initialized) {
    return Response.json({ error: 'MCP server not initialized' }, { status: 503 });
  }

  if (!(MCP_SERVERS as readonly string[]).includes(serverName)) {
    return Response.json({ error: `Unknown MCP server: ${serverName}` }, { status: 404 });
  }

  // Validate bearer token (skip in dev mode)
  if (!skipAuth) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${mcpToken}`) {
      console.log(`[MCP] Unauthorized request (invalid or missing token)`);
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Debug: log browser MCP requests to verify SDK tool discovery
  if (serverName === 'browser') {
    console.log(
      `[MCP] browser server request from agent=${req.headers.get('x-agent-id') ?? 'unknown'}`,
    );
  }

  // Restore agent context so tools can resolve the active session.
  // X-Agent-Id is set by the Claude provider; Codex calls omit it.
  const agentId = req.headers.get('x-agent-id') ?? 'unknown';
  const yaarSessionId = getSessionHub().getDefault()?.sessionId;

  return runWithAgentContext({ agentId, sessionId: yaarSessionId }, async () => {
    // Check for existing MCP session
    const mcpSessionId = req.headers.get('mcp-session-id') ?? undefined;

    if (mcpSessionId) {
      // Existing session — look up transport
      const key = `${serverName}:${mcpSessionId}`;
      const entry = mcpSessions.get(key);
      if (entry) {
        return entry.transport.handleRequest(req);
      }
      // Session not found — return 404 per MCP spec
      return Response.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found' },
          id: null,
        },
        { status: 404 },
      );
    }

    // No session ID — must be an initialize request (or invalid).
    if (req.method !== 'POST') {
      return Response.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        },
        { status: 405 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        },
        { status: 400 },
      );
    }

    // Validate it is an initialize request
    const messages = Array.isArray(body) ? body : [body];
    const isInit = messages.some((m) => isInitializeRequest(m));

    if (!isInit) {
      return Response.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Bad Request: No session ID and not an initialize request',
          },
          id: null,
        },
        { status: 400 },
      );
    }

    // Create new McpServer + transport for this session
    const server = await createServerForName(serverName);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId: string) => {
        const key = `${serverName}:${newSessionId}`;
        mcpSessions.set(key, { server, transport });
        console.log(`[MCP] New session for ${serverName}: ${newSessionId}`);
      },
    });

    // Clean up session when transport closes
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        const key = `${serverName}:${sid}`;
        mcpSessions.delete(key);
      }
    };

    await server.connect(transport);
    return transport.handleRequest(req, { parsedBody: body });
  });
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
 * Browser tools are only included when Chrome/Edge was detected at startup.
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
    ...(isBrowserAvailable() ? BROWSER_TOOL_NAMES : []),
  ];
}
