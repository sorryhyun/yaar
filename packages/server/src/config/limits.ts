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
