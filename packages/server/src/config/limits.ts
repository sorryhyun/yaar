/**
 * Queue and monitor budget limits.
 */

import { getEnvInt } from './env.js';

/**
 * How many tasks may wait on a monitor's queue before new ones are refused.
 *
 * Single-sourced: `context-pool.ts` sizes the queue with it and
 * `monitor-task-processor.ts` reports it in the refusal, so two copies could
 * disagree about the number in the error the user actually reads.
 */
export const MAX_QUEUE_SIZE = 10;
export const MONITOR_MAX_CONCURRENT = getEnvInt('MONITOR_MAX_CONCURRENT', 2);
export const MONITOR_MAX_ACTIONS_PER_MIN = getEnvInt('MONITOR_MAX_ACTIONS_PER_MIN', 30);
export const MONITOR_MAX_OUTPUT_PER_MIN = getEnvInt('MONITOR_MAX_OUTPUT_PER_MIN', 50000);

/**
 * How long an app agent may sit idle before the pool reclaims it. `0` disables the
 * reaper entirely.
 *
 * App agents are the one tier with no other reclaim path — not window close, not
 * anything but `fresh:true`, monitor removal, explicit delete, or session teardown. So
 * eight apps opened once permanently held 8 of `MAX_AGENTS`' 10 slots, and the ninth
 * app (and every *other* session) got "Agent limit reached" forever.
 *
 * The cost of reaping is that the app agent's memory goes with its provider session —
 * the same thing `fresh:true` does deliberately. Fifteen minutes is chosen to make that
 * a rare surprise while still being far shorter than "never".
 */
export const APP_AGENT_IDLE_MS = getEnvInt('APP_AGENT_IDLE_MINUTES', 15) * 60_000;

/** How often the pool looks for expired app agents. Resolution, not policy. */
export const APP_AGENT_SWEEP_MS = 60_000;
