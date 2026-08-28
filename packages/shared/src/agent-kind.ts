/**
 * Agent tiers, and how to read one off a per-turn role string.
 *
 * The server mints a role for every turn (`agents/roles.ts`) and puts it on the wire as
 * `agentId` on AGENT_THINKING / AGENT_RESPONSE / TOOL_PROGRESS. The prefixes live here
 * rather than in the server so the client can name the tier of an agent it is only ever
 * told the role of — the status bar colors one chip per live agent by exactly this.
 *
 * `AgentKind` is deliberately the same vocabulary `AgentEntry.type` uses in the pool's
 * roster (`agents/agent-roster.ts`), so the snapshot path — which reports instanceIds,
 * not roles, and therefore cannot parse — can hand the client the tier verbatim.
 */

/** The user's deputy. The only tier `access: 'session-principal'` admits. */
export const SESSION_ROLE_PREFIX = 'session-';
/** An app agent or one of its sub-agents. The unprivileged `app` tier. */
export const APP_ROLE_PREFIX = 'app-';
/** A monitor agent's turn. */
export const MONITOR_ROLE_PREFIX = 'monitor-';
/** A one-shot agent with a fresh provider and no context; tiers as `monitor`. */
export const EPHEMERAL_ROLE_PREFIX = 'ephemeral-';
/**
 * A sub-agent's turn. Extends `app-` on purpose — see `profiles/sub-agent.ts`, where
 * that containment is load-bearing in three places.
 */
export const SUB_AGENT_ROLE_PREFIX = `${APP_ROLE_PREFIX}persona-`;

/**
 * Which tier an agent belongs to. `persona` is the sub-agent tier's spelling — shipped
 * vocabulary, and the same word the URI segment and the spawn param use.
 */
export type AgentKind = 'session' | 'monitor' | 'app' | 'ephemeral' | 'persona';

/**
 * The tier a role string names — `app-persona-` before `app-`, since the first extends
 * the second.
 *
 * **Presentation only.** The access gate is `principalRole()` in the server's `roles.ts`
 * and nothing else: this function tells `persona` from `app`, which that gate
 * deliberately does not, so a caller who used this to decide a permission would be
 * splitting a tier the security boundary treats as one.
 *
 * Unrecognized roles read as `monitor`, matching `principalRole()`'s default — a role
 * minted by some future call site shows up as an ordinary agent rather than vanishing
 * from the bar.
 */
export function agentKindFromRole(role: string): AgentKind {
  if (role.startsWith(SUB_AGENT_ROLE_PREFIX)) return 'persona';
  if (role.startsWith(APP_ROLE_PREFIX)) return 'app';
  if (role.startsWith(SESSION_ROLE_PREFIX)) return 'session';
  if (role.startsWith(EPHEMERAL_ROLE_PREFIX)) return 'ephemeral';
  return 'monitor';
}
