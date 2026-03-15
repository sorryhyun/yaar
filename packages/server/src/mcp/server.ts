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
import { runWithAgentContext, getSessionId } from '../agents/session.js';
import { getSessionHub } from '../session/session-hub.js';
import { SYSTEM_TOOL_NAMES } from './system/index.js';
import { registerReloadTools } from './system/reload.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { probeBrowserAvailability } from '../features/browser/availability.js';
import { registerVerbTools, VERB_TOOL_NAMES } from '../handlers/index.js';
import { registerAppAgentTools, APP_TOOL_NAMES } from './app-agent/index.js';

/** Core MCP servers (always active). */
export const CORE_SERVERS = ['system', 'verbs', 'app'] as const;
export type McpServerName = (typeof CORE_SERVERS)[number];

/**
 * Per-session MCP transport entry.
 * Each Claude SDK client gets its own McpServer + transport pair per server name.
 */
interface McpSessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
}

/**
 * Map of `${serverName}:${mcpSessionId}` -> McpSessionEntry.
 * Created on `initialize` requests, reused for subsequent calls.
 */
const mcpSessions = new Map<string, McpSessionEntry>();

/** Evict idle MCP sessions every 5 minutes. */
const MCP_SESSION_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of mcpSessions) {
    if (now - entry.lastUsed > MCP_SESSION_TTL_MS) {
      mcpSessions.delete(key);
      void entry.server.close();
    }
  }
}, MCP_SESSION_TTL_MS).unref();

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
    const sid = getSessionId();
    const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
    if (!session) throw new Error('No active session — connect via WebSocket first.');
    return session.windowState;
  };
  const getReloadCache = (): ReloadCache => {
    const sid = getSessionId();
    const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
    if (!session) throw new Error('No active session — connect via WebSocket first.');
    return session.reloadCache;
  };

  switch (name) {
    case 'system':
      registerReloadTools(server, getReloadCache, getWindowState);
      break;
    case 'verbs':
      registerVerbTools(server);
      break;
    case 'app':
      registerAppAgentTools(server);
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
  mcpToken = crypto.randomUUID();

  // Probe browser availability once at startup so isBrowserAvailable() is set.
  await probeBrowserAvailability();

  initialized = true;
  console.log(
    `[MCP] HTTP server initialized (${CORE_SERVERS.join(', ')})${skipAuth ? ' (auth disabled)' : ''}`,
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

  if (!(CORE_SERVERS as readonly string[]).includes(serverName)) {
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

  // Restore agent context so tools can resolve the active session.
  // X-Agent-Id is set by the Claude provider; Codex calls omit it.
  const agentId = req.headers.get('x-agent-id') ?? 'unknown';
  const hub = getSessionHub();
  const yaarSessionId = hub.findSessionByAgent(agentId) ?? hub.getDefault()?.sessionId;
  const monitorId = hub.findMonitorForAgent(agentId);
  const windowId = hub.findWindowForAgent(agentId);

  return runWithAgentContext(
    { agentId, sessionId: yaarSessionId, monitorId, windowId },
    async () => {
      // Check for existing MCP session
      const mcpSessionId = req.headers.get('mcp-session-id') ?? undefined;

      if (mcpSessionId) {
        // Existing session — look up transport
        const key = `${serverName}:${mcpSessionId}`;
        const entry = mcpSessions.get(key);
        if (entry) {
          entry.lastUsed = Date.now();
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
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId: string) => {
          const key = `${serverName}:${newSessionId}`;
          mcpSessions.set(key, { server, transport, lastUsed: Date.now() });
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
    },
  );
}

/**
 * Format a raw MCP tool name for CLI display.
 * "mcp__apps__read_ts" → "apps:read_ts"
 * "subagent:mcp__verbs__read" → "subagent:read"
 */
export function formatToolDisplay(raw: string): string {
  // subagent progress with nested MCP name: "subagent:mcp__verbs__read" → "subagent:read"
  const sub = raw.match(/^subagent:mcp__\w+__(.+)$/);
  if (sub) return `subagent:${sub[1]}`;
  const m = raw.match(/^mcp__(\w+)__(.+)$/);
  if (m) return `${m[1]}:${m[2]}`;
  return raw;
}

/**
 * Get the active MCP servers.
 */
export function getActiveServers(): McpServerName[] {
  return [...CORE_SERVERS];
}

/**
 * Get the list of MCP tool names for YAAR.
 */
export function getToolNames(): string[] {
  return ['WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES, ...APP_TOOL_NAMES];
}
