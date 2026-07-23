/**
 * Per-agent MCP credentials.
 *
 * The agent id decides the principal's `role`, and the role decides the
 * `session-principal` gate — so identity can't be taken from a caller-supplied
 * header (an agent could set it to the session agent's id and inherit
 * `yaar://session/*` and the user's real browser). Each agent instead gets its
 * own unguessable token, bound to its id here, on the server. The token *is*
 * the identity — an agent presenting one is whoever it was minted for, and it
 * cannot mint or guess another agent's.
 *
 * The shared bearer token stays, but only as *transport* auth ("you are a process
 * YAAR spawned"). It no longer says anything about which agent is calling.
 */

const byAgent = new Map<string, string>();
const byToken = new Map<string, string>();

/**
 * The token for an agent, minted on first request and stable thereafter.
 *
 * Stability matters: providers rebuild their MCP config across turns (Claude on a
 * prompt/tool change, Codex per thread), and a token that changed each time would
 * churn the config — for Codex, the config signature is what decides whether the
 * thread has to be re-created.
 */
export function getAgentToken(agentId: string): string {
  const existing = byAgent.get(agentId);
  if (existing) return existing;

  const token = crypto.randomUUID();
  byAgent.set(agentId, token);
  byToken.set(token, agentId);
  return token;
}

export function resolveAgentToken(token: string): string | null {
  return byToken.get(token) ?? null;
}

export function revokeAgentToken(agentId: string): void {
  const token = byAgent.get(agentId);
  if (!token) return;
  byToken.delete(token);
  byAgent.delete(agentId);
}
