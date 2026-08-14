/**
 * MonitorBudgetPolicy — per-monitor rate limiting for background monitors.
 *
 * Three budget dimensions:
 * 1. Concurrent task semaphore — max background monitors running queries simultaneously
 * 2. Action rate limit — max OS actions/min per background monitor (sliding window)
 * 3. Output rate limit — max output bytes/min per background monitor (sliding window)
 *
 * The primary monitor (`0`) is never throttled.
 */

import {
  MONITOR_MAX_CONCURRENT,
  MONITOR_MAX_ACTIONS_PER_MIN,
  MONITOR_MAX_OUTPUT_PER_MIN,
} from '../../config.js';
import type { MonitorBudgetStats } from '../pool-types.js';

const PRIMARY_MONITOR = '0';
const WINDOW_MS = 60_000; // 1-minute sliding window

interface SlidingEntry {
  timestamp: number;
  value: number; // 1 for actions, byte count for output
}

interface MonitorBucket {
  actions: SlidingEntry[];
  output: SlidingEntry[];
}

export class MonitorBudgetPolicy {
  private readonly maxConcurrent: number;
  private readonly maxActionsPerMin: number;
  private readonly maxOutputPerMin: number;

  private runningCount = 0;
  private waiters: { resolve: () => void; reject: (err: Error) => void }[] = [];
  private buckets = new Map<string, MonitorBucket>();

  constructor(
    maxConcurrent = MONITOR_MAX_CONCURRENT,
    maxActionsPerMin = MONITOR_MAX_ACTIONS_PER_MIN,
    maxOutputPerMin = MONITOR_MAX_OUTPUT_PER_MIN,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.maxActionsPerMin = maxActionsPerMin;
    this.maxOutputPerMin = maxOutputPerMin;
  }

  // ── Concurrent task semaphore ────────────────────────────────────────

  /**
   * Acquire a task slot for a background monitor. Blocks until a slot is available.
   * Returns immediately for the primary monitor.
   */
  async acquireTaskSlot(monitorId: string): Promise<void> {
    if (!this.isThrottled(monitorId)) return;
    if (this.runningCount < this.maxConcurrent) {
      this.runningCount++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Budget acquisition timed out after 30s for monitor ${monitorId}`));
      }, 30_000);
      this.waiters.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
    this.runningCount++;
  }

  /**
   * Try to acquire a task slot without blocking.
   * Returns true if acquired, false if no slot available.
   * Always returns true for the primary monitor.
   */
  tryAcquireTaskSlot(monitorId: string): boolean {
    if (!this.isThrottled(monitorId)) return true;
    if (this.runningCount < this.maxConcurrent) {
      this.runningCount++;
      return true;
    }
    return false;
  }

  /**
   * Release a task slot after a background monitor task completes.
   */
  releaseTaskSlot(monitorId: string): void {
    if (!this.isThrottled(monitorId)) return;
    this.runningCount = Math.max(0, this.runningCount - 1);
    const next = this.waiters.shift();
    if (next) next.resolve();
  }

  // ── Action rate limit ────────────────────────────────────────────────

  /**
   * Check whether the monitor is within its action budget.
   * Always returns true for the primary monitor.
   */
  checkActionBudget(monitorId: string): boolean {
    if (!this.isThrottled(monitorId)) return true;
    const bucket = this.getBucket(monitorId);
    this.pruneOld(bucket.actions);
    const total = bucket.actions.length;
    return total < this.maxActionsPerMin;
  }

  /**
   * Record an OS action for a monitor.
   */
  recordAction(monitorId: string): void {
    if (!this.isThrottled(monitorId)) return;
    const bucket = this.getBucket(monitorId);
    bucket.actions.push({ timestamp: Date.now(), value: 1 });
  }

  // ── Output rate limit ────────────────────────────────────────────────

  /**
   * Check whether the monitor is within its output budget.
   * Always returns true for the primary monitor.
   */
  checkOutputBudget(monitorId: string): boolean {
    if (!this.isThrottled(monitorId)) return true;
    const bucket = this.getBucket(monitorId);
    this.pruneOld(bucket.output);
    const total = bucket.output.reduce((sum, e) => sum + e.value, 0);
    return total < this.maxOutputPerMin;
  }

  /**
   * Record output bytes for a monitor.
   */
  recordOutput(monitorId: string, bytes: number): void {
    if (!this.isThrottled(monitorId)) return;
    const bucket = this.getBucket(monitorId);
    bucket.output.push({ timestamp: Date.now(), value: bytes });
  }

  // ── Stats / Cleanup ──────────────────────────────────────────────────

  getStats(): MonitorBudgetStats {
    const monitors: Record<string, { actionsInWindow: number; outputInWindow: number }> = {};
    for (const [id, bucket] of this.buckets) {
      this.pruneOld(bucket.actions);
      this.pruneOld(bucket.output);
      monitors[id] = {
        actionsInWindow: bucket.actions.length,
        outputInWindow: bucket.output.reduce((sum, e) => sum + e.value, 0),
      };
    }
    return {
      runningSlots: this.runningCount,
      maxConcurrent: this.maxConcurrent,
      waitingCount: this.waiters.length,
      monitors,
    };
  }

  /**
   * Reject all waiting acquireTaskSlot() callers (e.g., on pool reset).
   */
  clearWaiting(reason?: Error): void {
    const err = reason ?? new Error('Budget policy cleared');
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }

  /**
   * Drop one monitor's sliding windows — a monitor whose context was reset must not be
   * throttled for actions its previous agent tree spent.
   *
   * The running-slot count is deliberately untouched: a slot is held by a turn and given
   * back by that turn's `finally`, so decrementing it here would hand out a slot twice.
   */
  clearMonitor(monitorId: string): void {
    this.buckets.delete(monitorId);
  }

  /**
   * Full reset — clear all state.
   */
  clear(): void {
    this.clearWaiting();
    this.runningCount = 0;
    this.buckets.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Whether this monitor is subject to any budget at all. The primary monitor
   * (`0`) is the user's foreground desktop and is never throttled — every public
   * method short-circuits on this, each returning its own "unlimited" answer
   * (`void` for the record/release side, `true` for the check/acquire side).
   */
  private isThrottled(monitorId: string): boolean {
    return monitorId !== PRIMARY_MONITOR;
  }

  private getBucket(monitorId: string): MonitorBucket {
    let bucket = this.buckets.get(monitorId);
    if (!bucket) {
      bucket = { actions: [], output: [] };
      this.buckets.set(monitorId, bucket);
    }
    return bucket;
  }

  private pruneOld(entries: SlidingEntry[]): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (entries.length > 0 && entries[0].timestamp < cutoff) {
      entries.shift();
    }
  }
}
