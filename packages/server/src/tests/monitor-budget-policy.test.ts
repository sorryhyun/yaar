import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  MONITOR_MAX_CONCURRENT: 2,
  MONITOR_MAX_ACTIONS_PER_MIN: 10,
  MONITOR_MAX_OUTPUT_PER_MIN: 10000,
}));

import { MonitorBudgetPolicy } from '../agents/context-pool-policies/monitor-budget-policy.js';

describe('MonitorBudgetPolicy', () => {
  let policy: MonitorBudgetPolicy;

  beforeEach(() => {
    policy = new MonitorBudgetPolicy(2, 5, 1000);
  });

  // ── Primary monitor bypass ──────────────────────────────────────────

  describe('primary monitor bypass', () => {
    it('acquireTaskSlot returns immediately for monitor-0', async () => {
      // Fill up all slots first
      policy.tryAcquireTaskSlot('monitor-1');
      policy.tryAcquireTaskSlot('monitor-2');
      // monitor-0 should still succeed without blocking
      await policy.acquireTaskSlot('monitor-0');
    });

    it('tryAcquireTaskSlot always returns true for monitor-0', () => {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.tryAcquireTaskSlot('monitor-2');
      expect(policy.tryAcquireTaskSlot('monitor-0')).toBe(true);
      expect(policy.tryAcquireTaskSlot('monitor-0')).toBe(true);
    });

    it('releaseTaskSlot is a no-op for monitor-0', () => {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.releaseTaskSlot('monitor-0');
      // monitor-1 still holds its slot, so second acquire should succeed (count=1 < max=2)
      expect(policy.tryAcquireTaskSlot('monitor-3')).toBe(true);
      // Now at capacity
      expect(policy.tryAcquireTaskSlot('monitor-4')).toBe(false);
    });

    it('checkActionBudget always returns true for monitor-0', () => {
      for (let i = 0; i < 20; i++) policy.recordAction('monitor-0');
      expect(policy.checkActionBudget('monitor-0')).toBe(true);
    });

    it('recordAction is a no-op for monitor-0', () => {
      for (let i = 0; i < 20; i++) policy.recordAction('monitor-0');
      // If records were actually stored, stats would show them — but they shouldn't exist
      const stats = policy.getStats();
      expect(stats.monitors['monitor-0']).toBeUndefined();
    });

    it('checkOutputBudget always returns true for monitor-0', () => {
      for (let i = 0; i < 10; i++) policy.recordOutput('monitor-0', 500);
      expect(policy.checkOutputBudget('monitor-0')).toBe(true);
    });

    it('recordOutput is a no-op for monitor-0', () => {
      policy.recordOutput('monitor-0', 99999);
      const stats = policy.getStats();
      expect(stats.monitors['monitor-0']).toBeUndefined();
    });
  });

  // ── Semaphore ───────────────────────────────────────────────────────

  describe('semaphore', () => {
    it('tryAcquireTaskSlot succeeds up to maxConcurrent then returns false', () => {
      expect(policy.tryAcquireTaskSlot('monitor-1')).toBe(true);
      expect(policy.tryAcquireTaskSlot('monitor-2')).toBe(true);
      expect(policy.tryAcquireTaskSlot('monitor-3')).toBe(false);
    });

    it('acquireTaskSlot blocks when at capacity, resolves when slot released', async () => {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.tryAcquireTaskSlot('monitor-2');

      let acquired = false;
      const promise = policy.acquireTaskSlot('monitor-3').then(() => {
        acquired = true;
      });

      // Should still be waiting
      await Promise.resolve();
      expect(acquired).toBe(false);

      // Release a slot — waiter should resolve
      policy.releaseTaskSlot('monitor-1');
      await promise;
      expect(acquired).toBe(true);
    });

    it('acquireTaskSlot rejects with timeout after 30s', async () => {
      vi.useFakeTimers();
      try {
        policy.tryAcquireTaskSlot('monitor-1');
        policy.tryAcquireTaskSlot('monitor-2');

        const promise = policy.acquireTaskSlot('monitor-3');

        vi.advanceTimersByTime(30_000);

        await expect(promise).rejects.toThrow('Budget acquisition timed out after 30s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('FIFO ordering: first waiter gets released first', async () => {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.tryAcquireTaskSlot('monitor-2');

      const order: string[] = [];
      const p1 = policy.acquireTaskSlot('monitor-3').then(() => order.push('first'));
      const p2 = policy.acquireTaskSlot('monitor-4').then(() => order.push('second'));

      policy.releaseTaskSlot('monitor-1');
      await p1;

      policy.releaseTaskSlot('monitor-3');
      await p2;

      expect(order).toEqual(['first', 'second']);
    });
  });

  // ── Action rate limit ───────────────────────────────────────────────

  describe('action rate limit', () => {
    it('checkActionBudget returns true when under limit', () => {
      for (let i = 0; i < 3; i++) policy.recordAction('monitor-1');
      expect(policy.checkActionBudget('monitor-1')).toBe(true);
    });

    it('checkActionBudget returns false when at limit', () => {
      for (let i = 0; i < 5; i++) policy.recordAction('monitor-1');
      expect(policy.checkActionBudget('monitor-1')).toBe(false);
    });

    it('old entries expire after 60s sliding window', () => {
      vi.useFakeTimers();
      try {
        // Record 5 actions (at limit)
        for (let i = 0; i < 5; i++) policy.recordAction('monitor-1');
        expect(policy.checkActionBudget('monitor-1')).toBe(false);

        // Advance past the 60s window
        vi.advanceTimersByTime(60_001);

        // Old entries should be pruned, budget available again
        expect(policy.checkActionBudget('monitor-1')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Output rate limit ──────────────────────────────────────────────

  describe('output rate limit', () => {
    it('checkOutputBudget returns true when under limit, false when over', () => {
      policy.recordOutput('monitor-1', 400);
      expect(policy.checkOutputBudget('monitor-1')).toBe(true);

      policy.recordOutput('monitor-1', 600);
      // total = 1000, limit = 1000 — not less than limit
      expect(policy.checkOutputBudget('monitor-1')).toBe(false);
    });

    it('output entries expire after 60s sliding window', () => {
      vi.useFakeTimers();
      try {
        policy.recordOutput('monitor-1', 1000);
        expect(policy.checkOutputBudget('monitor-1')).toBe(false);

        vi.advanceTimersByTime(60_001);

        expect(policy.checkOutputBudget('monitor-1')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('clearWaiting rejects all pending waiters', async () => {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.tryAcquireTaskSlot('monitor-2');

      const p1 = policy.acquireTaskSlot('monitor-3');
      const p2 = policy.acquireTaskSlot('monitor-4');

      const customError = new Error('shutting down');
      policy.clearWaiting(customError);

      await expect(p1).rejects.toThrow('shutting down');
      await expect(p2).rejects.toThrow('shutting down');
    });

    it('clear resets running count and clears all buckets', () => {
      policy.tryAcquireTaskSlot('monitor-1');
      policy.tryAcquireTaskSlot('monitor-2');
      policy.recordAction('monitor-1');
      policy.recordOutput('monitor-1', 500);

      policy.clear();

      const stats = policy.getStats();
      expect(stats.runningSlots).toBe(0);
      expect(stats.waitingCount).toBe(0);
      expect(Object.keys(stats.monitors)).toHaveLength(0);

      // Slots should be available again
      expect(policy.tryAcquireTaskSlot('monitor-1')).toBe(true);
    });
  });
});
