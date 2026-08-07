/**
 * MCP HTTP Server for YAAR.
 *
 * Provides HTTP endpoints for MCP tool calls across namespaced servers,
 * allowing multiple agents to connect independently without state corruption issues.
 *
 * Serves both MCP protocol eras off the same endpoint, forked per request in
 * `handleMcpRequest` (the reasoning, and why one shape cannot serve both, is at
 * `getModernHandler`):
 *
 * - **2025-era (legacy)** — stateful. Each SDK client gets its own MCP session; the
 *   transport is created on that client's first `initialize` and reused for every later
 *   request carrying the same session ID. This is what Claude's CLI and a default-configured
 *   Codex speak, and it is unchanged.
 * - **2026-07-28 (modern)** — stateless, no `initialize` and no session ID. Reached by
 *   clients that negotiate up, which for Codex means the `CODEX_MCP_PROTOCOL_VERSION`
 *   opt-in; YAAR does not set it, so this leg is dormant until a client asks for it.
 */

import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
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
 * @modelcontextprotocol/server 2.0.0 (and previously @modelcontextprotocol/sdk
 * 1.29.0; the field name and the `{ controller, encoder }` shape survived the v2
 * package split unchanged, v2 only adds a `cleanup` key we don't read). Guarded
 * with optional chaining so a future shape change degrades to "no keep-alive /
 * eligible for eviction" rather than throwing.
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
 * keeps the socket active so the stream never has to be reconnected.
 *
 * This used to be a hand-rolled `setInterval` walking `mcpSessions` and writing
 * through `getOpenGetStream()`. @modelcontextprotocol/server 2.0.0 does it
 * itself (`keepAliveMs`, emitting the identical `: keepalive\n\n` frame), so the
 * value is now handed to the transport instead. The explicit 60s is kept over
 * the SDK's 15s default because the number is a deliberate margin under the 255s
 * ceiling, not a taste preference.
 *
 * One consequence: the old loop also refreshed `lastUsed` on every tick, and the
 * transport's own timer cannot. That was belt-and-suspenders — a session holding
 * the GET stream open is already skipped by the eviction loop above via
 * `getOpenGetStream()`, which is the load-bearing guard and is unaffected.
 */
const MCP_KEEPALIVE_MS = 60 * 1000;

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
 * Per-namespace handler for the **modern** (MCP revision 2026-07-28) era.
 *
 * The two eras are served by two different SDK shapes, and neither one can do the
 * other's job:
 *
 * - 2025-era ("legacy") is **stateful**: the client sends `initialize`, the transport
 *   mints an `mcp-session-id`, and every later request rides that session. That is
 *   `WebStandardStreamableHTTPServerTransport` and the `mcpSessions` map below.
 * - 2026-07-28 is **stateless**: there is no `initialize` and no session id. A client
 *   probes `server/discover`, then sends each request standalone, carrying a `_meta`
 *   envelope naming the revision. That is `createMcpHandler`, whose factory is called
 *   **per request** — which is why `createServerForName` being a factory already is the
 *   whole port, and why nothing here needs the keep-alive or eviction machinery.
 *
 * Adding `2026-07-28` to the `McpServer` `supportedProtocolVersions` list is *not* the
 * opt-in, despite registering a `server/discover` handler on the instance: the probe is
 * session-less, so it is refused by the "no session ID and not an initialize request"
 * branch below long before it reaches any instance, and the client silently falls back
 * to legacy. Measured — a negotiating client still lands on 2025-11-25.
 *
 * `legacy: 'reject'` because the classifier below already routed every legacy request to
 * the stateful path. This handler must never be the one to answer 2025-era traffic: it
 * would answer *statelessly*, quietly dropping the session and the GET common stream
 * that the keep-alive above exists to hold open. Rejecting turns a routing mistake into
 * a loud error instead of a subtle regression for Claude and legacy Codex alike.
 *
 * Memoized per namespace: the handler holds no per-connection state (the factory does),
 * so one is enough, and building it per request would allocate for nothing.
 */
const modernHandlers = new Map<McpServerName, McpHttpHandler>();

function getModernHandler(serverName: McpServerName): McpHttpHandler {
  let handler = modernHandlers.get(serverName);
  if (!handler) {
    handler = createMcpHandler(() => createServerForName(serverName), { legacy: 'reject' });
    modernHandlers.set(serverName, handler);
  }
  return handler;
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

      // Fork the two protocol eras (see getModernHandler). Only a session-less POST can
      // be modern — a 2026-07-28 connection is stateless, so anything carrying a session
      // id is legacy by construction and already returned above, which keeps the hot
      // path (every tool call rides a session id) off the classifier entirely.
      //
      // Handing the classifier the body we already parsed matters: given `parsedBody` it
      // inspects that instead of re-reading the request, so the stream is consumed once
      // and both eras are dispatched with the same object.
      if (!(await isLegacyRequest(req, body))) {
        return getModernHandler(serverName).fetch(req, { parsedBody: body });
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
        keepAliveMs: MCP_KEEPALIVE_MS,
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
