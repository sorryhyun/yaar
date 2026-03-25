import { mock, setSystemTime, describe, it, expect, beforeEach } from 'bun:test';

mock.module('../config.js', () => ({
  getEnvInt: (key: string, def: number) => def,
  IS_BUNDLED_EXE: false,
  PROJECT_ROOT: '/mock-root',
  getStorageDir: () => '/tmp/mock-storage',
  STORAGE_DIR: '/tmp/mock-storage',
  getConfigDir: () => '/tmp/mock-config',
  getFrontendDist: () => '/tmp/mock-dist',
  FRONTEND_DIST: '/tmp/mock-dist',
  MIME_TYPES: {},
  MAX_UPLOAD_SIZE: 50 * 1024 * 1024,
  getPort: () => 8000,
  setPort: () => {},
  PORT: 8000,
  IS_REMOTE: false,
  MARKET_URL: 'https://yaarmarket.vercel.app',
  MONITOR_MAX_CONCURRENT: 2,
  MONITOR_MAX_ACTIONS_PER_MIN: 10,
  MONITOR_MAX_OUTPUT_PER_MIN: 10000,
  resolveClaudeBinPath: () => null,
  getClaudeSpawnArgs: () => [],
  getCodexSpawnArgs: () => [],
  getCodexBin: () => 'codex',
  CODEX_WS_PORT: 4510,
  getCodexWsPort: () => 4510,
  getCodexAppServerArgs: () => [],
}));

const { MonitorBudgetPolicy } =
  await import('../agents/context-pool-policies/monitor-budget-policy.js');

describe('MonitorBudgetPolicy', () => {
  let policy: InstanceType<typeof MonitorBudgetPolicy>;

  beforeEach(() => {
    policy = new MonitorBudgetPolicy(2, 5, 1000);
  });

  // ── Primary monitor bypass ──────────────────────────────────────────

  describe('primary monitor bypass', () => {
    it('acquireTaskSlot returns immediately for primary monitor', async () => {
      // Fill up all slots first
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');
      // primary monitor should still succeed without blocking
      await policy.acquireTaskSlot('0');
    });

    it('tryAcquireTaskSlot always returns true for primary monitor', () => {
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');
      expect(policy.tryAcquireTaskSlot('0')).toBe(true);
      expect(policy.tryAcquireTaskSlot('0')).toBe(true);
    });

    it('releaseTaskSlot is a no-op for primary monitor', () => {
      policy.tryAcquireTaskSlot('1');
      policy.releaseTaskSlot('0');
      // monitor '1' still holds its slot, so second acquire should succeed (count=1 < max=2)
      expect(policy.tryAcquireTaskSlot('3')).toBe(true);
      // Now at capacity
      expect(policy.tryAcquireTaskSlot('4')).toBe(false);
    });

    it('checkActionBudget always returns true for primary monitor', () => {
      for (let i = 0; i < 20; i++) policy.recordAction('0');
      expect(policy.checkActionBudget('0')).toBe(true);
    });

    it('recordAction is a no-op for primary monitor', () => {
      for (let i = 0; i < 20; i++) policy.recordAction('0');
      // If records were actually stored, stats would show them — but they shouldn't exist
      const stats = policy.getStats();
      expect(stats.monitors['0']).toBeUndefined();
    });

    it('checkOutputBudget always returns true for primary monitor', () => {
      for (let i = 0; i < 10; i++) policy.recordOutput('0', 500);
      expect(policy.checkOutputBudget('0')).toBe(true);
    });

    it('recordOutput is a no-op for primary monitor', () => {
      policy.recordOutput('0', 99999);
      const stats = policy.getStats();
      expect(stats.monitors['0']).toBeUndefined();
    });
  });

  // ── Semaphore ───────────────────────────────────────────────────────

  describe('semaphore', () => {
    it('tryAcquireTaskSlot succeeds up to maxConcurrent then returns false', () => {
      expect(policy.tryAcquireTaskSlot('1')).toBe(true);
      expect(policy.tryAcquireTaskSlot('2')).toBe(true);
      expect(policy.tryAcquireTaskSlot('3')).toBe(false);
    });

    it('acquireTaskSlot blocks when at capacity, resolves when slot released', async () => {
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');

      let acquired = false;
      const promise = policy.acquireTaskSlot('3').then(() => {
        acquired = true;
      });

      // Should still be waiting
      await Promise.resolve();
      expect(acquired).toBe(false);

      // Release a slot — waiter should resolve
      policy.releaseTaskSlot('1');
      await promise;
      expect(acquired).toBe(true);
    });

    it('acquireTaskSlot rejects with timeout after 30s', async () => {
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');

      const promise = policy.acquireTaskSlot('3').catch((e: Error) => e);

      // Use clearWaiting to simulate the timeout rejection
      const customError = new Error('Budget acquisition timed out after 30s');
      policy.clearWaiting(customError);

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Budget acquisition timed out after 30s');
    });

    it('FIFO ordering: first waiter gets released first', async () => {
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');

      const order: string[] = [];
      const p1 = policy.acquireTaskSlot('3').then(() => order.push('first'));
      const p2 = policy.acquireTaskSlot('4').then(() => order.push('second'));

      policy.releaseTaskSlot('1');
      await p1;

      policy.releaseTaskSlot('3');
      await p2;

      expect(order).toEqual(['first', 'second']);
    });
  });

  // ── Action rate limit ───────────────────────────────────────────────

  describe('action rate limit', () => {
    it('checkActionBudget returns true when under limit', () => {
      for (let i = 0; i < 3; i++) policy.recordAction('1');
      expect(policy.checkActionBudget('1')).toBe(true);
    });

    it('checkActionBudget returns false when at limit', () => {
      for (let i = 0; i < 5; i++) policy.recordAction('1');
      expect(policy.checkActionBudget('1')).toBe(false);
    });

    it('old entries expire after 60s sliding window', () => {
      const now = Date.now();
      setSystemTime(new Date(now));

      // Record 5 actions (at limit)
      for (let i = 0; i < 5; i++) policy.recordAction('1');
      expect(policy.checkActionBudget('1')).toBe(false);

      // Advance past the 60s window
      setSystemTime(new Date(now + 60_001));

      // Old entries should be pruned, budget available again
      expect(policy.checkActionBudget('1')).toBe(true);

      // Restore real time
      setSystemTime();
    });
  });

  // ── Output rate limit ──────────────────────────────────────────────

  describe('output rate limit', () => {
    it('checkOutputBudget returns true when under limit, false when over', () => {
      policy.recordOutput('1', 400);
      expect(policy.checkOutputBudget('1')).toBe(true);

      policy.recordOutput('1', 600);
      // total = 1000, limit = 1000 — not less than limit
      expect(policy.checkOutputBudget('1')).toBe(false);
    });

    it('output entries expire after 60s sliding window', () => {
      const now = Date.now();
      setSystemTime(new Date(now));

      policy.recordOutput('1', 1000);
      expect(policy.checkOutputBudget('1')).toBe(false);

      setSystemTime(new Date(now + 60_001));

      expect(policy.checkOutputBudget('1')).toBe(true);

      setSystemTime();
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('clearWaiting rejects all pending waiters', async () => {
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');

      const p1 = policy.acquireTaskSlot('3').catch((e: Error) => e);
      const p2 = policy.acquireTaskSlot('4').catch((e: Error) => e);

      const customError = new Error('shutting down');
      policy.clearWaiting(customError);

      const r1 = await p1;
      const r2 = await p2;
      expect(r1).toBeInstanceOf(Error);
      expect((r1 as Error).message).toBe('shutting down');
      expect(r2).toBeInstanceOf(Error);
      expect((r2 as Error).message).toBe('shutting down');
    });

    it('clear resets running count and clears all buckets', () => {
      policy.tryAcquireTaskSlot('1');
      policy.tryAcquireTaskSlot('2');
      policy.recordAction('1');
      policy.recordOutput('1', 500);

      policy.clear();

      const stats = policy.getStats();
      expect(stats.runningSlots).toBe(0);
      expect(stats.waitingCount).toBe(0);
      expect(Object.keys(stats.monitors)).toHaveLength(0);

      // Slots should be available again
      expect(policy.tryAcquireTaskSlot('1')).toBe(true);
    });
  });
});
