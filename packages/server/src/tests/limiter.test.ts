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
    expect(limiter.getStats()).toEqual({ maxAgents: 3, currentCount: 0 });
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

  it('reset clears the count', () => {
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.reset();
    expect(limiter.getCurrentCount()).toBe(0);
  });
});
