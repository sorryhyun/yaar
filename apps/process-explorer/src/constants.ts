export {};

// Every literal the app repeats more than once: URIs, tier names, tab ids and the
// thresholds behind the formatters. Nothing here imports app code, so any module
// may pull from it without a cycle.

/** This app's own id. Used for log prefixes; the protocol id lives in main.ts. */
export const APP_ID = 'process-explorer';

/** Prefix for every console line, so the app's output is greppable in a shared log. */
export const LOG_PREFIX = `[${APP_ID}]`;

/**
 * The verb-API roots this app reads. These must stay in sync with the
 * `permissions` array in app.json — a URI added here without a matching grant
 * there fails at runtime with a 403, not at compile time.
 */
export const URI = {
  /** Agent roster. Also the parent of the interrupt/kill targets. */
  agents: 'yaar://session/agents',
  windows: 'yaar://windows',
  /** Installed-app roster, for display names only. */
  apps: 'yaar://apps',
} as const;

/** One agent, as an interrupt (`invoke`) or kill (`del`) target. */
export const agentUri = (agentId: string) => `${URI.agents}/${agentId}`;

/** One window, as a close (`del`) target. */
export const windowUri = (windowId: string) => `${URI.windows}/${windowId}`;

/**
 * One agent's live activity feed. Note the root: `yaar://agents/`, NOT
 * `yaar://session/agents/` — streams hang off a different tree than the roster.
 */
export const agentStreamUri = (agentId: string) => `yaar://agents/${agentId}/stream`;

/**
 * Agent tiers this app treats specially: `app` joins a process row, `session` is
 * the one stream that must never be opened (shielded server-side, it would 403).
 * Named here because the checks live in two different modules.
 *
 * Not exhaustive by design — see {@link AgentTier}, the server owns the vocabulary.
 */
export const AGENT_TIER = {
  session: 'session',
  monitor: 'monitor',
  app: 'app',
  persona: 'persona',
  ephemeral: 'ephemeral',
} as const;

/** The three views, in tab order. Drives both the stat cards and the TabId union. */
export const TAB_IDS = ['agents', 'windows', 'apps'] as const;

/** Frame kinds worth folding into a row. `start` resets the row per turn and
 * `error` is a terminal the row would otherwise miss, so both are as load-bearing
 * as the content kinds. */
export const STREAM_KINDS = ['start', 'text', 'tool', 'usage', 'done', 'error'] as const;

/** Longest tail of streamed assistant text kept per agent. */
export const TEXT_TAIL_CHARS = 200;

/**
 * How often the freshness clock ticks. Freshness is the one readout that changes
 * with no frame arriving — "3s ago" has to become "4s ago" on its own — so a
 * second is the coarsest tick that still looks live.
 */
export const CLOCK_INTERVAL_MS = 1000;

/** Thresholds for {@link formatTokens}: exact below 1k, one decimal below 10k. */
export const TOKENS_K = 1_000;
export const TOKENS_M = 1_000_000;
export const TOKENS_DECIMAL_BELOW = 10_000;

/** Seconds per minute / minutes per hour, for {@link formatAge}'s ladder. */
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
