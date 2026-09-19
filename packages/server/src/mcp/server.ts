/**
 * MCP HTTP Server for YAAR.
 *
 * Provides HTTP endpoints for MCP tool calls across namespaced servers,
 * allowing multiple agents to connect independently without state corruption issues.
 *
 * **One protocol era: 2026-07-28, stateless.** No `initialize` handshake, no
 * `mcp-session-id`, nothing stored per client. A client probes `server/discover`, then
 * sends every request standalone, and `createMcpHandler` calls `createServerForName`
 * per request — which is why the namespace factory *is* the whole implementation
 * (see `getModernHandler`).
 *
 * Both providers are asked to negotiate that revision: Codex via `features.mcp_2026_07_28`
 * (`ENABLED_FEATURES` in `config/providers/codex.ts`), Claude via `MCP_SDK_GENERATION` +
 * `MCP_PROTOCOL_NEGOTIATION` (`config/providers/claude.ts`). Codex's
 * `CODEX_MCP_PROTOCOL_VERSION` env var is **not** the gate for these servers — it selects the
 * era for **stdio** MCP servers, and YAAR's are all HTTP; the measurement separating the two
 * is at that flag's comment.
 *
 * The 2025-era stateful leg that used to sit behind this one is **gone**, and with it the
 * per-client session map, the idle-eviction timer, the keep-alive that held the GET common
 * stream open under Bun's 255s socket timeout, and YAAR's one read of an SDK-private
 * `_streamMapping` field. A server restart no longer orphans anything either — a stateless
 * request is self-contained.
 *
 * What that leg also bought was a *silent* fallback: a client that could not negotiate up
 * re-handshook on 2025-era and kept every tool. Nothing absorbs that now. A client arriving
 * with a session id, or with a legacy `initialize`, is refused by `refuseLegacyEra` with a
 * message naming both opt-in gates. Recognise that refusal for what it is — a stale CLI, or a
 * gate renamed or withdrawn in a binary YAAR does not pin (Claude's pair is undocumented;
 * Codex's flag is still stage `under development`) — not a malformed tool call.
 */

import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
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
import { createLogger } from '../observability/log.js';

const log = createLogger('MCP');

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
 * Refuse a client that speaks the retired 2025-era protocol.
 *
 * This is the only place the removal of the stateful leg is visible from outside, and it is
 * deliberately chatty: without the fallback, "could not negotiate up" and "sent a bad
 * request" produce the same JSON-RPC error code, and only one of them is fixed by touching a
 * spawn config. The client name comes from the `initialize` body because knowing *which* CLI
 * failed to negotiate is the whole diagnostic — a stale binary and a withdrawn gate look
 * identical without it.
 *
 * Logged at error level every time rather than once per process: unlike the deprecation
 * warning this replaces, the request was not served, so there is no quiet-but-working state
 * for a rate limit to protect.
 */
function refuseLegacyEra(serverName: McpServerName, clientLabel: string): Response {
  const message =
    'This MCP endpoint serves revision 2026-07-28 only; the stateful 2025-era leg was ' +
    'removed. The client did not negotiate up — a stale CLI, or an opt-in gate that was ' +
    'renamed or withdrawn (Claude: MCP_SDK_GENERATION=v2 + MCP_PROTOCOL_NEGOTIATION=auto, ' +
    'Codex: features.mcp_2026_07_28=true).';
  log.error('refused legacy protocol era', { client: clientLabel, server: serverName });
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32600, message }, id: null },
    { status: 400 },
  );
}

/** Best-effort client name from an `initialize` body, for the refusal above. */
function clientLabelFrom(messages: unknown[]): string {
  for (const m of messages) {
    const info = (m as { params?: { clientInfo?: { name?: unknown; version?: unknown } } })?.params
      ?.clientInfo;
    if (typeof info?.name === 'string') {
      return typeof info.version === 'string' ? `${info.name} ${info.version}` : info.name;
    }
  }
  return 'an unidentified client';
}

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
 * Per-namespace handler for MCP revision 2026-07-28 — the only era this endpoint serves.
 *
 * The revision is **stateless**: no `initialize`, no session id. A client probes
 * `server/discover`, then sends each request standalone carrying a `_meta` envelope naming
 * the revision. `createMcpHandler` calls its factory **per request**, which is why
 * `createServerForName` being a factory already was the entire port from the stateful
 * transport this replaced, and why nothing here needs a keep-alive or an eviction timer.
 *
 * Two traps, both measured, both still live:
 *
 * - Adding `2026-07-28` to an `McpServer`'s `supportedProtocolVersions` is *not* how the
 *   revision gets served, despite that registering a `server/discover` handler on the
 *   instance. The probe is session-less; under the old fork it never reached an instance at
 *   all. The handler is the seam, not the server.
 * - `legacy: 'reject'` is load-bearing. `handleMcpRequest` classifies first and refuses
 *   2025-era traffic with a diagnostic, so this handler should never see any — but if a
 *   classifier change ever lets one through, answering it *statelessly* would look like it
 *   worked while silently dropping the session semantics the client expects. Rejecting keeps
 *   a routing mistake loud.
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
  log.info('HTTP server initialized', { servers: CORE_SERVERS.join(', '), authDisabled: skipAuth });
}

/**
 * Handle incoming MCP HTTP requests using web-standard Request/Response.
 *
 * Authenticates, restores the calling agent's context, then serves the request statelessly
 * through {@link getModernHandler}. Anything that could only have come from a 2025-era client
 * — a `mcp-session-id` header, or a legacy `initialize` — is refused by {@link refuseLegacyEra}
 * rather than served.
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
      log.warn('unauthorized request (invalid or missing token)');
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
      // A session id can only come from a client that handshook on the retired stateful
      // leg — a 2026-07-28 connection has none by construction. Checked before the body is
      // read because it is the cheap half of the classification.
      if (req.headers.get('mcp-session-id')) {
        return refuseLegacyEra(serverName, 'a client holding an mcp-session-id');
      }

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

      // Handing the classifier the body we already parsed matters: given `parsedBody` it
      // inspects that instead of re-reading the request, so the stream is consumed once and
      // the same object is passed on to the handler.
      if (await isLegacyRequest(req, body)) {
        const messages = Array.isArray(body) ? body : [body];
        return refuseLegacyEra(serverName, clientLabelFrom(messages));
      }

      return getModernHandler(serverName).fetch(req, { parsedBody: body });
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
