/**
 * Principals for MCP callers YAAR spawned but does not pool.
 *
 * `handleMcpRequest` turns an `X-Agent-Token` into an agent id and then asks the
 * `SessionHub` where that agent lives — which only the agent pool can answer. A
 * process outside the pool (the hosted `claude remote-control`) holds a real token
 * but would resolve to no session, no monitor and no role. This table answers for it.
 *
 * The role is fixed to `monitor` by the type: an external principal is a sandboxed
 * worker on one monitor, never the session principal. A pooled agent with the same
 * id still wins — the hub is consulted first.
 */

import type { SessionId } from '../session/types.js';

export interface ExternalPrincipal {
  sessionId: SessionId | undefined;
  monitorId: string;
  role: 'monitor';
}

const principals = new Map<string, ExternalPrincipal>();

export function registerExternalPrincipal(agentId: string, principal: ExternalPrincipal): void {
  principals.set(agentId, principal);
}

export function unregisterExternalPrincipal(agentId: string): void {
  principals.delete(agentId);
}

export function getExternalPrincipal(agentId: string): ExternalPrincipal | undefined {
  return principals.get(agentId);
}
