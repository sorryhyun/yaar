/**
 * The per-agent MCP server set both providers hand to their SDK.
 *
 * Every YAAR MCP server is an HTTP endpoint served by *this* process, and every
 * agent reaches it over the same shared bearer token — so a tool call arriving
 * over HTTP carries no inherent agent identity. The identity is the per-agent
 * token minted by `mcp/agent-tokens.ts`, which the server maps back to an agent
 * id. Neither provider may send an agent *id*: an agent that can name a
 * principal can become it.
 *
 * Both providers need the same two facts — the namespace→URL map and the
 * caller's token — and then reshape them differently (Claude: SDK `mcpServers`
 * with an `X-Agent-Token` header; Codex: a per-thread `mcp_servers` override
 * with an `x-agent-token` header and an env-var bearer). This module owns the
 * common half so the token plumbing has one audited home; the reshapes stay
 * with their providers.
 */

import { getActiveServers, getAgentToken } from '../mcp/index.js';
import { getPort } from '../config.js';

/** One MCP namespace and the endpoint this process serves it on. */
export interface McpServerEndpoint {
  /** MCP namespace — 'system', 'verbs', 'app', 'messaging'. */
  name: string;
  /** This process's HTTP MCP endpoint for that namespace. */
  url: string;
}

export interface McpServerSet {
  servers: McpServerEndpoint[];
  /**
   * The caller's per-agent credential, or undefined when the turn has no agent
   * id — in which case there is no principal to assert and the caller decides
   * what to do about it.
   */
  agentToken: string | undefined;
}

/**
 * Build the active MCP endpoints plus the calling agent's token.
 *
 * @param agentId - The agent this turn runs as; undefined mints no token.
 * @param include - Optional namespace filter. Omitted = every active server.
 */
export function buildMcpServerSet(
  agentId: string | undefined,
  include?: (name: string) => boolean,
): McpServerSet {
  const servers = getActiveServers()
    .filter((name) => include?.(name) ?? true)
    .map((name: string) => ({
      name,
      url: `http://127.0.0.1:${getPort()}/mcp/${name}`,
    }));

  return { servers, agentToken: agentId ? getAgentToken(agentId) : undefined };
}
