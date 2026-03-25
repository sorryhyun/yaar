import { spyOn, describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
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

      const result = await limiter.acquire(10).catch((e: Error) => e);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('timed out');
    });
  });

  describe('clearWaiting', () => {
    it('rejects all waiting requests', async () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      const p1 = limiter.acquire().catch((e: Error) => e);
      const p2 = limiter.acquire().catch((e: Error) => e);

      limiter.clearWaiting();

      const r1 = await p1;
      const r2 = await p2;
      expect(r1).toBeInstanceOf(Error);
      expect(r2).toBeInstanceOf(Error);
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
