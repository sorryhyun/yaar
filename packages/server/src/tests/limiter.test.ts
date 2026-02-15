import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLimiter } from '../agents/limiter.js';

describe('AgentLimiter', () => {
  let limiter: AgentLimiter;

  beforeEach(() => {
    limiter = new AgentLimiter(3);
  });

  afterEach(() => {
    limiter.reset();
  });

  it('reports stats correctly', () => {
    expect(limiter.getStats()).toEqual({ maxAgents: 3, currentCount: 0, waitingCount: 0 });
  });

  describe('tryAcquire', () => {
    it('acquires up to max', () => {
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      expect(limiter.getCurrentCount()).toBe(3);
    });
  });

  describe('release', () => {
    it('decrements count', () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.release();
      expect(limiter.getCurrentCount()).toBe(1);
    });

    it('warns on underflow but does not go negative', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      limiter.release();
      expect(limiter.getCurrentCount()).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('async acquire', () => {
    it('resolves immediately when under limit', async () => {
      await limiter.acquire();
      expect(limiter.getCurrentCount()).toBe(1);
    });

    it('waits and resolves when slot freed', async () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      let acquired = false;
      const promise = limiter.acquire().then(() => {
        acquired = true;
      });

      expect(acquired).toBe(false);
      expect(limiter.getWaitingCount()).toBe(1);

      limiter.release();
      await promise;

      expect(acquired).toBe(true);
      expect(limiter.getCurrentCount()).toBe(3);
    });

    it('rejects on timeout', async () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      await expect(limiter.acquire(10)).rejects.toThrow('timed out');
    });
  });

  describe('clearWaiting', () => {
    it('rejects all waiting requests', async () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      const p1 = limiter.acquire();
      const p2 = limiter.acquire();

      limiter.clearWaiting();

      await expect(p1).rejects.toThrow();
      await expect(p2).rejects.toThrow();
      expect(limiter.getWaitingCount()).toBe(0);
    });
  });

  it('reset clears everything', () => {
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.reset();
    expect(limiter.getCurrentCount()).toBe(0);
    expect(limiter.getWaitingCount()).toBe(0);
  });
});
