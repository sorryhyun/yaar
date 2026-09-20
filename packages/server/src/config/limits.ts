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
export const MAX_QUEUE_SIZE = 20;
export const MONITOR_MAX_CONCURRENT = getEnvInt('MONITOR_MAX_CONCURRENT', 4);
export const MONITOR_MAX_ACTIONS_PER_MIN = getEnvInt('MONITOR_MAX_ACTIONS_PER_MIN', 60);
export const MONITOR_MAX_OUTPUT_PER_MIN = getEnvInt('MONITOR_MAX_OUTPUT_PER_MIN', 100000);

/**
 * How long an app agent may sit idle before the pool reclaims it. `0` disables the
 * reaper entirely.
 *
 * Closing an app's last window on a monitor retires its agent, which covers the app the
 * user is done with. This covers the one they left open: an app agent used to have no
 * reclaim path at all beyond `fresh:true`, monitor removal, explicit delete, or session
 * teardown, so eight apps opened once permanently held 8 of `MAX_AGENTS`' 10 slots, and
 * the ninth app (and every *other* session) got "Agent limit reached" forever.
 *
 * The cost of reaping is that the app agent's memory goes with its provider session —
 * the same thing `fresh:true` and a last-window close both do deliberately. The default
 * is an hour rather than the fifteen minutes it started at, because the clock does not
 * measure what it reads as: an app agent is idle while *the user* is away, and on a phone
 * the user is away every time they switch apps. Fifteen minutes of another app was enough
 * to come back to an agent that remembered nothing, and a successor told only that a
 * predecessor existed re-did work that had already landed — the reported case was a
 * repository cloned a second time, under a new id, on top of the first.
 *
 * An hour is still far shorter than "never", which is the slot-exhaustion this exists to
 * prevent (see above). `0` disables it for a desktop that would rather keep the memory.
 */
export const APP_AGENT_IDLE_MS = getEnvInt('APP_AGENT_IDLE_MINUTES', 60) * 60_000;

/** How often the pool looks for expired app agents. Resolution, not policy. */
export const APP_AGENT_SWEEP_MS = 60_000;
