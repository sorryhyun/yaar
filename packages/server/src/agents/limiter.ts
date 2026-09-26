/**
 * AgentLimiter - Semaphore-pattern global agent limit enforcement.
 *
 * Ensures a system-wide limit on total agents across all connections. Non-blocking only:
 * production calls `tryAcquire()`/`release()` and never blocks a caller waiting for a
 * slot to free up (an `acquire()` that queued a waiter used to exist here, but nothing
 * called it outside tests — see the audit at `backend_report.md` §2F — and a wait queue
 * on a *process-global* semaphore is a hazard waiting to be reached: reject-on-shutdown
 * for one session's waiters would have rejected every other session's too).
 */

import { getEnvInt } from '../config.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AgentLimiter');

export class AgentLimiter {
  private maxAgents: number;
  private currentCount = 0;

  constructor(maxAgents?: number) {
    this.maxAgents = maxAgents ?? getEnvInt('MAX_AGENTS', 10);
  }

  /**
   * Get the maximum number of agents allowed.
   */
  getMaxAgents(): number {
    return this.maxAgents;
  }

  /**
   * Get the current number of active agents.
   */
  getCurrentCount(): number {
    return this.currentCount;
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): { maxAgents: number; currentCount: number } {
    return {
      maxAgents: this.maxAgents,
      currentCount: this.currentCount,
    };
  }

  /**
   * Attempt to acquire an agent slot without blocking.
   * Returns true if acquired, false if at limit.
   */
  tryAcquire(): boolean {
    if (this.currentCount < this.maxAgents) {
      this.currentCount++;
      return true;
    }
    return false;
  }

  /**
   * Release an agent slot.
   */
  release(): void {
    if (this.currentCount <= 0) {
      log.warn('release() called when currentCount is 0');
      return;
    }
    this.currentCount--;
  }

  /**
   * Reset the limiter (for testing).
   */
  reset(): void {
    this.currentCount = 0;
  }
}

// Global singleton instance
let globalLimiter: AgentLimiter | null = null;

/**
 * Get the global agent limiter instance.
 */
export function getAgentLimiter(): AgentLimiter {
  if (!globalLimiter) {
    globalLimiter = new AgentLimiter();
  }
  return globalLimiter;
}

/**
 * Reset the global limiter (for testing).
 */
export function resetAgentLimiter(): void {
  if (globalLimiter) {
    globalLimiter.reset();
  }
  globalLimiter = null;
}
