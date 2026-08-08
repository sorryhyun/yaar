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
 *   request carrying the same session ID. This is what a client that does not negotiate up
 *   speaks, and it is unchanged.
 * - **2026-07-28 (modern)** — stateless, no `initialize` and no session ID. Reached by
 *   clients that negotiate up, which **both** of YAAR's providers are now asked to do:
 *   Codex via `features.mcp_2026_07_28` (`ENABLED_FEATURES` in `config/providers/codex.ts`),
 *   Claude via `MCP_SDK_GENERATION` + `MCP_PROTOCOL_NEGOTIATION` (`config/providers/claude.ts`).
 *   Codex's `CODEX_MCP_PROTOCOL_VERSION` env var is **not** the gate for these servers — it
 *   applies to stdio MCP servers, and YAAR's are all HTTP; see the flag's comment for the
 *   measurement that separates the two.
 *
 * So the modern leg is where real traffic is *meant* to land, and the legacy leg is
 * **deprecated** — retained as a fallback, not as a supported path. It is not dead weight
 * behind the modern one: those provider opt-ins are undocumented CLI gates in binaries YAAR
 * does not pin, and a client that cannot negotiate up falls back to `initialize` silently.
 * The stateful path is what makes that fallback cost nothing. Deleting it converts any gate
 * rename — or one stale CLI on one machine — into every agent losing every tool at once.
 *
 * Everything the legacy leg needs is fenced into one section below, marked `@deprecated`
 * and bounded by banner comments, so the eventual deletion is a cut along a line that is
 * already drawn. Nothing outside that fence is era-specific.
 *
 * Because "is anything still on the legacy leg?" is the question that gates that deletion,
 * the fork is **counted**, not just documented: `getMcpEraStats()` reports requests served
 * per era plus legacy sessions minted, and the first legacy session in a process logs a
 * one-time deprecation warning naming the client. A run that never prints it and reports
 * `legacyRequestsServed: 0` is the evidence; see `docs/proposals/mcp_modern_only_proposal.md`
 * for the full exit criteria (the counters answer #3 and nothing else).
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

// ─── BEGIN deprecated: 2025-era stateful leg ──────────────────────────────────
//
// Everything from here to the END banner exists only to serve clients that did not
// negotiate 2026-07-28. It is scheduled for deletion once the exit criteria in
// `docs/proposals/mcp_modern_only_proposal.md` are met. Do not add to this section,
// and do not reach into it from the modern path — the modern handler holds no
// session, no stream, and no timer, and must keep needing none of them.

/**
 * Per-session MCP transport entry.
 * Each Claude SDK client gets its own McpServer + transport pair per server name.
 *
 * @deprecated 2025-era only. The modern leg is stateless and stores nothing per client.
 */
interface McpSessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
}

/**
 * Map of `${serverName}:${mcpSessionId}` -> McpSessionEntry.
 * Created on `initialize` requests, reused for subsequent calls.
 *
 * @deprecated 2025-era only. A stateless request needs no lookup, which is also why a
 * server restart stops orphaning sessions once this is gone.
 */
const mcpSessions = new Map<string, McpSessionEntry>();

/**
 * The SDK's internal id for the standalone server→client SSE stream — the GET
 * "common stream" that a streamable-HTTP client (rmcp/codex) holds open for
 * server-pushed messages. Matches
 * `WebStandardStreamableHTTPServerTransport._standaloneSseStreamId`.
 *
 * @deprecated 2025-era only.
 */
const STANDALONE_GET_STREAM_ID = '_GET_stream';

/**
 * Minimal view of one entry in the SDK transport's private stream registry.
 *
 * @deprecated 2025-era only.
 */
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
 *
 * @deprecated 2025-era only — and the single strongest reason to retire this leg. It is
 * the one place YAAR depends on an SDK-private field, so every SDK bump owes it a re-check
 * by hand. The modern handler holds no stream and needs none of this.
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
 *
 * @deprecated 2025-era only. Nothing accumulates on the stateless leg, so nothing has to
 * be reclaimed.
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
 *
 * @deprecated 2025-era only. This constant is the coupling between YAAR's MCP layer and
 * Bun's socket policy; a stateless endpoint holds no long-lived socket, so retiring this
 * leg removes the coupling outright rather than re-tuning the margin.
 */
const MCP_KEEPALIVE_MS = 60 * 1000;

/**
 * Per-era traffic counters — the evidence behind "is anything still on the legacy leg?".
 *
 * `legacyRequestsServed` is the number that gates deletion: it counts every request that
 * took the stateful path, including the `initialize` that mints a session. A window in
 * which it stays 0 while `modernRequestsServed` climbs is what criterion 3 of
 * `docs/proposals/mcp_modern_only_proposal.md` asks for.
 *
 * Deliberately a plain in-process counter, not a metrics backend: it exists to answer one
 * question once, and it dies with the leg it measures.
 */
const eraStats = {
  /** Requests dispatched to the stateless 2026-07-28 handler. */
  modernRequestsServed: 0,
  /** Requests dispatched to the deprecated stateful path (initialize + all follow-ups). */
  legacyRequestsServed: 0,
  /** `mcp-session-id`s minted — i.e. distinct legacy client connections. */
  legacySessionsCreated: 0,
};

/** Snapshot of the per-era traffic counters. See `eraStats`. */
export function getMcpEraStats(): Readonly<typeof eraStats> {
  return { ...eraStats };
}

/**
 * Zero the counters.
 * @internal — exposed for testing.
 */
export function resetMcpEraStats(): void {
  eraStats.modernRequestsServed = 0;
  eraStats.legacyRequestsServed = 0;
  eraStats.legacySessionsCreated = 0;
  legacyDeprecationWarned = false;
}

/**
 * One-time-per-process deprecation warning, emitted when a client actually lands on the
 * stateful leg. Once, not per session: five namespaces times every agent would bury it,
 * and the counters above already carry the volume. The client name comes from the
 * `initialize` body, since knowing *which* CLI failed to negotiate up is the whole
 * diagnostic value — a stale binary and a renamed gate look identical without it.
 */
let legacyDeprecationWarned = false;

function warnLegacyEra(serverName: McpServerName, clientLabel: string): void {
  if (legacyDeprecationWarned) return;
  legacyDeprecationWarned = true;
  console.warn(
    `[MCP] DEPRECATED protocol era: ${clientLabel} connected to "${serverName}" over the ` +
      `stateful 2025-era leg instead of negotiating 2026-07-28. YAAR asks both providers to ` +
      `negotiate up, so this means the client could not — a stale CLI, or a renamed opt-in ` +
      `gate (Claude: MCP_SDK_GENERATION/MCP_PROTOCOL_NEGOTIATION, Codex: ` +
      `features.mcp_2026_07_28). Tools still work; the fallback is why. See ` +
      `docs/proposals/mcp_modern_only_proposal.md.`,
  );
}

/** Best-effort client name from an `initialize` body, for the warning above. */
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

// ─── END deprecated: 2025-era stateful leg ────────────────────────────────────

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
          eraStats.legacyRequestsServed++;
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
        eraStats.modernRequestsServed++;
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

      // Past this point the request is on the deprecated stateful leg. Counted here rather
      // than at the top of the branch so a malformed body that never got served doesn't
      // read as legacy traffic — the counters gate a deletion, so they should undercount
      // rather than over.
      eraStats.legacyRequestsServed++;
      warnLegacyEra(serverName, clientLabelFrom(messages));

      // Create new McpServer + transport for this session
      const server = await createServerForName(serverName);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        keepAliveMs: MCP_KEEPALIVE_MS,
        onsessioninitialized: (newSessionId: string) => {
          const key = `${serverName}:${newSessionId}`;
          mcpSessions.set(key, { server, transport, lastUsed: Date.now() });
          eraStats.legacySessionsCreated++;
          console.log(`[MCP] New legacy-era session for ${serverName}: ${newSessionId}`);
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
