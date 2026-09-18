/**
 * The per-turn context of the hosted Remote Control session.
 *
 * A pooled monitor turn is prefixed with what happened on the desktop since the last one
 * (`<timeline>`) and the windows now open (`<open_windows>`) — `ContextAssemblyPolicy`
 * builds that prompt because YAAR is the one handing the turn to the provider. A remote
 * turn is not: the user's message goes from claude.ai straight into the CLI, and YAAR
 * never sees it. The one point where the CLI asks anybody before a turn is a
 * `UserPromptSubmit` hook, so `agent-config.ts` registers an HTTP hook pointing here and
 * this answers with the same prefix as `additionalContext`.
 *
 * The session reads its own follower timeline (`ContextPool.followTimeline`), never the
 * monitor agent's: that one is drained on read, and draining it here would take the
 * entries away from the desktop's next turn. The follower is created on the first call,
 * so the first turn is told the open windows and every later one what changed.
 *
 * Auth is the MCP endpoint's: the transport bearer, then the agent token — which must be
 * an external principal's, since a pooled agent's turns already carry this context.
 */

import { getExternalPrincipal } from '../../mcp/external-principals.js';
import { resolveAgentToken } from '../../mcp/agent-tokens.js';
import { getMcpToken, isMcpAuthSkipped } from '../../mcp/server.js';
import { TURN_CONTEXT_PATH } from './agent-config.js';
import { getSessionHub } from '../../session/session-hub.js';
import type { SessionId } from '../../session/types.js';

export { TURN_CONTEXT_PATH };

export async function handleTurnContextRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (!isMcpAuthSkipped() && req.headers.get('authorization') !== `Bearer ${getMcpToken()}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const presented = req.headers.get('x-agent-token');
  const agentId = presented ? resolveAgentToken(presented) : null;
  const principal = agentId ? getExternalPrincipal(agentId) : undefined;
  if (!agentId || !principal) {
    return Response.json({ error: 'Not an external principal' }, { status: 403 });
  }

  const hub = getSessionHub();
  const session = principal.sessionId ? hub.get(principal.sessionId) : hub.getDefault();
  // No pool yet is a session nobody has spoken to: nothing has happened to report.
  const context = session?.getPool()?.followerTurnContext(principal.monitorId, agentId) ?? '';
  if (!context) return Response.json({});
  return Response.json({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  });
}

/** Detach the agent's follower timeline, once its process is gone. */
export function releaseTurnContext(agentId: string, sessionId: SessionId | undefined): void {
  const hub = getSessionHub();
  const session = sessionId ? hub.get(sessionId) : hub.getDefault();
  session?.getPool()?.unfollowTimeline(agentId);
}
