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
import { runWithAgentContext } from '../agents/agent-context.js';
import { getSessionHub } from '../session/session-hub.js';
import { SYSTEM_TOOL_NAMES } from './system/index.js';
import { registerReloadTools } from './system/reload.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { probeBrowserAvailability } from '../features/browser/availability.js';
import { resolveAgentToken } from './agent-tokens.js';
import { registerVerbTools, VERB_TOOL_NAMES } from '../handlers/index.js';
import { getActiveSession } from '../handlers/utils.js';
import { registerAppAgentTools } from './app-agent/index.js';
import { registerMessagingTools, MESSAGING_TOOL_NAMES } from './messaging/index.js';
import { registerSubAgentTools } from './sub-agent/index.js';
import { SUB_AGENT_MCP_SERVER } from '../agents/profiles/sub-agent.js';

/**
 * Core MCP servers (always active).
 *
 * `subagent` is active like the rest but empty for almost everyone: its tools are
 * whatever the *calling* sub-agent was spawned with, so it registers nothing for a
 * caller that is not one — or is one that was spawned with no tools (see
 * `mcp/sub-agent/`). No other agent's tool allowlist names it, so no other agent
 * connects it in the first place.
 */
export const CORE_SERVERS = ['system', 'verbs', 'app', 'messaging', SUB_AGENT_MCP_SERVER] as const;
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

/**
 * The SDK's internal id for the standalone server→client SSE stream — the GET
 * "common stream" that a streamable-HTTP client (rmcp/codex) holds open for
 * server-pushed messages. Matches
 * `WebStandardStreamableHTTPServerTransport._standaloneSseStreamId`.
 */
const STANDALONE_GET_STREAM_ID = '_GET_stream';

/** Minimal view of one entry in the SDK transport's private stream registry. */
interface StandaloneStreamHandle {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
}

/**
 * Return the live standalone GET SSE stream for a transport, or null when the
 * client isn't currently holding one open.
 *
 * Reaches into an SDK-private field (`_streamMapping`) — verified against
 * @modelcontextprotocol/sdk 1.29.0. Guarded with optional chaining so a future
 * shape change degrades to "no keep-alive / eligible for eviction" rather than
 * throwing.
 */
function getOpenGetStream(
  transport: WebStandardStreamableHTTPServerTransport,
): StandaloneStreamHandle | null {
  const mapping = (transport as unknown as { _streamMapping?: Map<string, StandaloneStreamHandle> })
    ._streamMapping;
  return mapping?.get(STANDALONE_GET_STREAM_ID) ?? null;
}

/**
 * Evict idle MCP sessions every 5 minutes — but never one whose client still
 * holds the GET common stream open. Such a session is live even if it hasn't
 * made a tool call recently (e.g. the agent is busy driving the browser);
 * reaping it would drop the stream and make rmcp log "fail to get common
 * stream" on its next reconnect.
 */
const MCP_SESSION_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of mcpSessions) {
    if (getOpenGetStream(entry.transport)) continue;
    if (now - entry.lastUsed > MCP_SESSION_TTL_MS) {
      mcpSessions.delete(key);
      void entry.server.close();
    }
  }
}, MCP_SESSION_TTL_MS).unref();

/**
 * Keep the standalone GET stream warm. rmcp holds one GET SSE stream open per
 * server for server→client messages, but YAAR pushes almost nothing over it, so
 * it sits idle — and Bun closes idle sockets at TRANSPORT_IDLE_TIMEOUT_S (255s).
 * A periodic SSE comment (`:`-prefixed, ignored by any spec-compliant client)
 * keeps the socket active so the stream never has to be reconnected, and
 * refreshes `lastUsed` as a belt-and-suspenders alongside the eviction skip
 * above. 60s gives a comfortable margin under the 255s ceiling.
 */
const MCP_KEEPALIVE_MS = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const entry of mcpSessions.values()) {
    const stream = getOpenGetStream(entry.transport);
    if (!stream) continue;
    try {
      stream.controller.enqueue(stream.encoder.encode(': keepalive\n\n'));
      entry.lastUsed = now;
    } catch {
      // Controller already closed/errored — the transport's own cancel handler
      // removes it from `_streamMapping`; nothing to clean up here.
    }
  }
}, MCP_KEEPALIVE_MS).unref();

// Bearer token for MCP authentication (generated at startup)
let mcpToken: string | null = null;

// Skip auth in dev mode (set MCP_SKIP_AUTH=1)
const skipAuth = process.env.MCP_SKIP_AUTH === '1';

// Track whether the module has been initialized
let initialized = false;

/**
 * Whether MCP auth is skipped (MCP_SKIP_AUTH=1 at module load time).
 * @internal — exposed for testing.
 */
export function isMcpAuthSkipped(): boolean {
  return skipAuth;
}

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

  const getWindowState = (): WindowStateRegistry => getActiveSession().windowState;
  const getReloadCache = (): ReloadCache => getActiveSession().reloadCache;

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
    case 'messaging':
      registerMessagingTools(server);
      break;
    case SUB_AGENT_MCP_SERVER:
      registerSubAgentTools(server);
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

  // Restore agent context so tools can resolve the active session/window.
  //
  // The caller proves which agent it is by presenting the token minted for that agent
  // (see mcp/agent-tokens.ts). It used to *assert* it, in an `x-agent-id` header that
  // anyone behind the shared bearer token could set to any value they liked — which
  // made the whole role-based access tier, `session-principal` included, advisory.
  //
  // Every turn stamps this token: Claude sends it as `X-Agent-Token`, Codex bakes it
  // into the thread's `mcp_servers` header (providers/codex, buildMcpScope). There is
  // no header-less provider left, so a request with no resolvable token is 'unknown'
  // rather than borrowing a process-global "current agent".
  const presented = req.headers.get('x-agent-token');
  if (presented && !resolveAgentToken(presented)) {
    return Response.json({ error: 'Unknown agent token' }, { status: 403 });
  }
  const agentId = (presented && resolveAgentToken(presented)) ?? 'unknown';
  const hub = getSessionHub();
  const yaarSessionId = hub.findSessionByAgent(agentId) ?? hub.getDefault()?.sessionId;
  const monitorId = hub.findMonitorForAgent(agentId);
  const windowId = hub.findWindowForAgent(agentId);
  const role = hub.findRoleForAgent(agentId);

  return runWithAgentContext(
    { agentId, sessionId: yaarSessionId, monitorId, windowId, role },
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
  return ['WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES, ...MESSAGING_TOOL_NAMES];
}
