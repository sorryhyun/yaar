/**
 * AgentLimiter - Semaphore-pattern global agent limit enforcement.
 *
 * Ensures system-wide limit on total agents across all connections.
 * Uses a waiting queue with optional timeout for graceful backpressure.
 */

interface WaitingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
}

export class AgentLimiter {
  private maxAgents: number;
  private currentCount = 0;
  private waitingQueue: WaitingRequest[] = [];

  constructor(maxAgents?: number) {
    this.maxAgents = maxAgents ?? parseInt(process.env.MAX_AGENTS ?? '10', 10);
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
   * Get the number of requests waiting in the queue.
   */
  getWaitingCount(): number {
    return this.waitingQueue.length;
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): { maxAgents: number; currentCount: number; waitingCount: number } {
    return {
      maxAgents: this.maxAgents,
      currentCount: this.currentCount,
      waitingCount: this.waitingQueue.length,
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
   * Acquire an agent slot, waiting if at limit.
   * Throws if timeout is reached while waiting.
   *
   * @param timeoutMs - Optional timeout in milliseconds. If not provided, waits indefinitely.
   */
  async acquire(timeoutMs?: number): Promise<void> {
    // Try immediate acquisition
    if (this.tryAcquire()) {
      return;
    }

    // At limit - wait in queue
    return new Promise<void>((resolve, reject) => {
      const request: WaitingRequest = {
        resolve: () => {
          this.currentCount++;
          resolve();
        },
        reject,
      };

      // Set up timeout if specified
      if (timeoutMs !== undefined && timeoutMs > 0) {
        request.timeoutId = setTimeout(() => {
          // Remove from queue
          const index = this.waitingQueue.indexOf(request);
          if (index !== -1) {
            this.waitingQueue.splice(index, 1);
          }
          reject(new Error(`Agent acquisition timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.waitingQueue.push(request);
    });
  }

  /**
   * Release an agent slot, signaling waiting requests.
   */
  release(): void {
    if (this.currentCount <= 0) {
      console.warn('[AgentLimiter] release() called when currentCount is 0');
      return;
    }

    this.currentCount--;

    // Signal next waiting request
    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift();
      if (next) {
        // Clear timeout if any
        if (next.timeoutId) {
          clearTimeout(next.timeoutId);
        }
        // resolve() increments currentCount
        next.resolve();
      }
    }
  }

  /**
   * Clear all waiting requests with an error.
   * Called during shutdown.
   */
  clearWaiting(error?: Error): void {
    const err = error ?? new Error('AgentLimiter shutting down');
    for (const request of this.waitingQueue) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject(err);
    }
    this.waitingQueue = [];
  }

  /**
   * Reset the limiter (for testing).
   */
  reset(): void {
    this.clearWaiting();
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
