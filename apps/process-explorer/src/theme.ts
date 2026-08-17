export {};

// Data-driven presentation: colours that depend on a runtime value and therefore
// cannot be a plain CSS class. Kept out of the row components so the two lookup
// tables sit side by side and a new agent tier or turn state is a one-line edit.

import { AGENT_TIER } from './constants';
import type { AgentEntry, AgentTurnState, BrowserSession } from './types';

/**
 * Badge colour per agent tier. A tier this app does not know about falls back to
 * the muted text colour rather than going unstyled — see {@link AgentTier}, the
 * server may grow a fifth tier at any time.
 */
const AGENT_TIER_COLOR: Record<string, string> = {
  [AGENT_TIER.monitor]: 'var(--yaar-accent)',
  [AGENT_TIER.app]: 'var(--yaar-success)',
  // An app's own persona — same family as its app agent, dimmer because a room
  // of four should read as one app's cast rather than four peers of it.
  [AGENT_TIER.persona]: 'color-mix(in srgb, var(--yaar-success) 55%, var(--yaar-text-muted))',
  [AGENT_TIER.ephemeral]: 'var(--yaar-text-muted)',
  [AGENT_TIER.session]: '#f5a623',
};

export function agentTierColor(type: AgentEntry['type']) {
  return AGENT_TIER_COLOR[type] ?? 'var(--yaar-text-muted)';
}

/**
 * Label + colour for a turn state. `done` is deliberately muted and `interrupted`
 * is not: a turn the user cut short is worth noticing, one that finished isn't.
 */
export const TURN_STATE_STYLE: Record<AgentTurnState, { label: string; color: string }> = {
  responding: { label: 'responding', color: 'var(--yaar-accent)' },
  'using-tool': { label: 'using tool', color: 'var(--yaar-accent)' },
  done: { label: 'done', color: 'var(--yaar-text-muted)' },
  error: { label: 'error', color: 'var(--yaar-error)' },
};

/**
 * The leading status dot. Two states only: something wants attention, or it
 * doesn't. Agent rows and app rows compute `attention` from different flags but
 * render the same two classes, so the mapping lives here once.
 */
export function statusDotClass(attention: boolean) {
  return attention ? 'y-dot y-dot-warn' : 'y-dot y-dot-ok';
}

/**
 * Badge colour per browser-session state. `suspended` is warned rather than
 * muted: a session whose socket is gone is not resting, it is a window that will
 * not paint until someone revives it.
 */
const BROWSER_STATE_COLOR: Record<string, string> = {
  live: 'var(--yaar-success)',
  suspended: 'var(--yaar-warning, #f5a623)',
  crashed: 'var(--yaar-error)',
};

export function browserStateColor(state: BrowserSession['state']) {
  return BROWSER_STATE_COLOR[state] ?? 'var(--yaar-text-muted)';
}
