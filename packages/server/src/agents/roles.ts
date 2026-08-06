/**
 * Agent role strings — the per-turn identity an agent runs under.
 *
 * A role is minted once per turn, handed to `AgentSession.handleMessage`, and read
 * back by prefix in three places that matter:
 *
 * - {@link principalRole} maps it to the URI access tier. **This is a security
 *   boundary** — `session-` is the user's deputy and the only tier that can reach
 *   `yaar://session/*`; everything else is a sandboxed worker.
 * - `assembleSystemPromptForRole` (`system-prompt.ts`) keys the scope section off it,
 *   and returns an `app-` role's prompt verbatim — no environment, no memory.
 * - `AgentPool.interruptByIdOrRole` matches a running agent by it.
 *
 * The minting used to be spelled inline at five call sites while the parsing lived
 * somewhere else entirely, so the prefixes the access gate keys on were an unwritten
 * convention that a new call site could get wrong in silence. Mint and parse live
 * together here: change a prefix and the tier that reads it is on the next screen.
 */

import type { AgentRole } from './agent-context.js';

/** The user's deputy. The only tier `access: 'session-principal'` admits. */
export const SESSION_ROLE_PREFIX = 'session-';
/** An app agent or one of its sub-agents. The unprivileged `app` tier. */
export const APP_ROLE_PREFIX = 'app-';
/** A monitor agent's turn. */
export const MONITOR_ROLE_PREFIX = 'monitor-';
/** A one-shot agent with a fresh provider and no context; tiers as `monitor`. */
export const EPHEMERAL_ROLE_PREFIX = 'ephemeral-';

/**
 * A monitor's stable identity, with no turn in it.
 *
 * Distinct from {@link monitorTurnRole}: this is what the prewarm runs under, what
 * `savedThreadIds` files a resumable provider thread under, and what a window
 * subscription records as its subscriber. All three outlive any one message, so
 * none of them may carry a messageId.
 */
export function monitorRole(monitorId: string): string {
  return `${MONITOR_ROLE_PREFIX}${monitorId}`;
}

/** One monitor-agent turn. */
export function monitorTurnRole(monitorId: string, messageId: string): string {
  return `${MONITOR_ROLE_PREFIX}${monitorId}-${messageId}`;
}

/** One ephemeral-agent turn. */
export function ephemeralRole(monitorId: string, messageId: string): string {
  return `${EPHEMERAL_ROLE_PREFIX}${monitorId}-${messageId}`;
}

/**
 * One session-agent turn. The suffix only has to make the role unique and readable
 * in a log — nothing parses it back out.
 */
export function sessionRole(suffix: string): string {
  return `${SESSION_ROLE_PREFIX}${suffix}`;
}

/**
 * The prefix every per-turn role of an app agent starts with.
 *
 * The monitor follows the appId — the opposite order from `appProcessingKey()`'s
 * queue key for the same pair (`app-task-processor.ts`). That looks like a typo and
 * is not: a prefix match here has to name one app on one monitor, and the two
 * spellings live in different keyspaces. They were both hand-built at call sites
 * until it bit; each has exactly one owner now.
 */
export function appRolePrefix(monitorId: string, appId: string): string {
  return `${APP_ROLE_PREFIX}${appId}-m${monitorId}`;
}

/**
 * Map a per-turn role string (`monitor-0-msg1`, `app-foo-m0-msg2`,
 * `session-audit-123`) to its principal tier.
 *
 * Default-deny by shape: anything not explicitly the session agent is an
 * unprivileged `monitor`-tier principal, so a role minted by some future call site
 * that forgets to use this module fails closed rather than open.
 */
export function principalRole(dynamicRole: string): AgentRole {
  if (dynamicRole.startsWith(SESSION_ROLE_PREFIX)) return 'session';
  if (dynamicRole.startsWith(APP_ROLE_PREFIX)) return 'app';
  return 'monitor';
}

/** True for a role built by {@link appRolePrefix} or any other `app-` tier role. */
export function isAppRole(role: string): boolean {
  return role.startsWith(APP_ROLE_PREFIX);
}

/** True for the session agent's roles — see {@link sessionRole}. */
export function isSessionRole(role: string): boolean {
  return role.startsWith(SESSION_ROLE_PREFIX);
}
