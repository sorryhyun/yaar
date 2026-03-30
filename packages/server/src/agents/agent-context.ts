/**
 * Agent context — AsyncLocalStorage-based identity tracking.
 *
 * Provides getAgentId(), getSessionId(), getMonitorId(), getWindowId()
 * for any code running inside an agent turn, and runWithAgentContext()
 * for restoring identity from HTTP headers (e.g., MCP requests).
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { ConnectionId } from '../session/broadcast-center.js';
import type { SessionId } from '../session/types.js';

interface AgentContext {
  agentId: string;
  connectionId: ConnectionId;
  sessionId: SessionId;
  monitorId?: string;
  windowId?: string;
}

const agentContext = new AsyncLocalStorage<AgentContext>();

export function getAgentId(): string | undefined {
  return agentContext.getStore()?.agentId;
}

export function getCurrentConnectionId(): ConnectionId | undefined {
  return agentContext.getStore()?.connectionId;
}

export function getSessionId(): SessionId | undefined {
  return agentContext.getStore()?.sessionId;
}

export function getMonitorId(): string | undefined {
  return agentContext.getStore()?.monitorId;
}

export function getWindowId(): string | undefined {
  return agentContext.getStore()?.windowId;
}

/**
 * Run a function within a specific agent context.
 * Used to restore agent identity from HTTP headers (e.g., X-Agent-Id in MCP requests).
 */
export function runWithAgentId<T>(agentId: string, fn: () => T): T {
  return runWithAgentContext({ agentId }, fn);
}

/**
 * Run a function with a full agent context (agentId + optional sessionId).
 * Used by the MCP HTTP handler to restore both identity and session scope.
 */
export function runWithAgentContext<T>(
  ctx: { agentId: string; sessionId?: SessionId; monitorId?: string; windowId?: string },
  fn: () => T,
): T {
  const existing = agentContext.getStore();
  return agentContext.run(
    {
      agentId: ctx.agentId,
      connectionId: existing?.connectionId ?? ('' as ConnectionId),
      sessionId: ctx.sessionId ?? existing?.sessionId ?? ('' as SessionId),
      monitorId: ctx.monitorId ?? existing?.monitorId,
      windowId: ctx.windowId ?? existing?.windowId,
    },
    fn,
  );
}

/**
 * Internal: run a callback inside a full AgentContext.
 * Used by AgentSession.handleMessage() to set context for the provider turn.
 */
export function runInAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContext.run(context, fn);
}
