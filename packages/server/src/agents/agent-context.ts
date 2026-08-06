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
 * sandboxed workers. `roles.ts` maps a per-turn role string onto this
 * (`principalRole`) and owns the prefixes that decide it.
 */
export type AgentRole = 'session' | 'monitor' | 'app';

interface AgentContext {
  agentId: string;
  connectionId: ConnectionId;
  sessionId: SessionId;
  monitorId?: string;
  windowId?: string;
  /**
   * The app this context is acting as, when it was entered from an app iframe.
   *
   * `agentId` encodes it as `iframe:{appId}`, but that is a display string — a
   * handler that needs the real id (to key an app-scoped resource such as the
   * HTTP cookie jar) must not parse it back out.
   */
  appId?: string;
  /** Principal tier for URI access control (undefined → treated as non-session). */
  role?: AgentRole;
  /**
   * This context was entered from a **bundled `kind: "system"` app's** iframe token.
   *
   * Set only from a validated token (`routes/verb.ts`), never from a request body — an
   * app cannot self-grant it (`getAppMeta` sets it for bundled system apps only), so it
   * is exactly as forgeable as the token, which is to say not at all.
   *
   * Widens `access: 'session-principal'` past `role === 'session'`: a system app carries
   * no agent role at all, and the HTTP gate has always let it through `yaar://session/*`
   * (`isSessionUri` in http/access.ts). Without this the two gates answer in different
   * currencies and a system app is admitted by one door and refused by the other.
   */
  systemApp?: boolean;
}

/**
 * Who is calling, as the URI access gate needs to know it.
 *
 * The two fields are alternatives, not a hierarchy: an agent turn carries a `role` and
 * no `systemApp`; a system app's iframe carries `systemApp` and no role. See
 * `ResourceRegistry.execute`'s gate for what satisfies `access: 'session-principal'`.
 */
export interface AccessPrincipal {
  role?: AgentRole;
  systemApp?: boolean;
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

/** The app id this context is acting as, if it was entered from an app iframe. */
export function getAppId(): string | undefined {
  return agentContext.getStore()?.appId;
}

/**
 * The monitor of whoever is running — required. Every agent turn carries its monitor,
 * and every iframe verb call carries the monitor of the window that made it.
 */
export function requireMonitorId(): string {
  const monitorId = agentContext.getStore()?.monitorId;
  if (!monitorId) {
    throw new Error(
      'No monitor in context. Anything that acts on a monitor must run inside an agent ' +
        'turn or an iframe verb call, both of which carry one.',
    );
  }
  return monitorId;
}

export function getWindowId(): string | undefined {
  return agentContext.getStore()?.windowId;
}

export function getAgentRole(): AgentRole | undefined {
  return agentContext.getStore()?.role;
}

/**
 * The current caller as the URI access gate sees it. Wired into
 * `setAccessPrincipalResolver` in lifecycle.ts.
 */
export function getAccessPrincipal(): AccessPrincipal {
  const store = agentContext.getStore();
  return { role: store?.role, systemApp: store?.systemApp };
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
    appId?: string;
    role?: AgentRole;
    systemApp?: boolean;
  },
  fn: () => T,
): T {
  const existing = agentContext.getStore();
  // Rebuilt field by field on purpose — anything not listed here is dropped, so a
  // new AgentContext field must be added in both places or it silently vanishes.
  return agentContext.run(
    {
      agentId: ctx.agentId,
      connectionId: existing?.connectionId ?? ('' as ConnectionId),
      sessionId: ctx.sessionId ?? existing?.sessionId ?? ('' as SessionId),
      monitorId: ctx.monitorId ?? existing?.monitorId,
      windowId: ctx.windowId ?? existing?.windowId,
      appId: ctx.appId ?? existing?.appId,
      role: ctx.role ?? existing?.role,
      systemApp: ctx.systemApp ?? existing?.systemApp,
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
