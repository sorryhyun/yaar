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

/**
 * Principal tier of an agent — the identity that access control is keyed on.
 * Only the session agent acts as the user's deputy; monitor/app agents are
 * sandboxed workers. See docs/session_agent_browser_design.md.
 */
export type AgentRole = 'session' | 'monitor' | 'app';

interface AgentContext {
  agentId: string;
  connectionId: ConnectionId;
  sessionId: SessionId;
  monitorId?: string;
  windowId?: string;
  /** Principal tier for URI access control (undefined → treated as non-session). */
  role?: AgentRole;
}

/**
 * Map a dynamic per-turn role string (e.g. "monitor-0-msg1", "app-foo-msg2",
 * "session-audit-123") to its principal tier. Anything that is not explicitly
 * the session agent (monitor, ephemeral, window workers) is a non-privileged
 * 'monitor'-tier principal.
 */
export function principalRole(dynamicRole: string): AgentRole {
  if (dynamicRole.startsWith('session-')) return 'session';
  if (dynamicRole.startsWith('app-')) return 'app';
  return 'monitor';
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

export function getAgentRole(): AgentRole | undefined {
  return agentContext.getStore()?.role;
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
  ctx: {
    agentId: string;
    sessionId?: SessionId;
    monitorId?: string;
    windowId?: string;
    role?: AgentRole;
  },
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
      role: ctx.role ?? existing?.role,
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
