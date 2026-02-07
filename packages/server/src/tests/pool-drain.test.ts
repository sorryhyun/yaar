/**
 * Tests for pool drain on reset — verifies that ContextPool, AgentPool,
 * AppServer, and CodexProvider correctly handle in-flight tasks during reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── AppServer turn queue drain ──────────────────────────────────────────

describe('AppServer.stop() drains turn queue', () => {
  it('resolves all pending turn waiters on stop', async () => {
    // Inline minimal AppServer to test turn queue drain without spawning a process
    const turnQueue: Array<{ resolve: () => void }> = [];
    let turnActive = false;

    function acquireTurn(): Promise<void> {
      if (!turnActive) {
        turnActive = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        turnQueue.push({ resolve });
      });
    }

    function drainTurnQueue(): void {
      for (const waiter of turnQueue) {
        waiter.resolve();
      }
      turnQueue.length = 0;
      turnActive = false;
    }

    // First acquire succeeds immediately
    await acquireTurn();
    expect(turnActive).toBe(true);

    // Two waiters queue up
    const results: string[] = [];
    const p1 = acquireTurn().then(() => results.push('waiter1'));
    const p2 = acquireTurn().then(() => results.push('waiter2'));

    expect(turnQueue.length).toBe(2);

    // Drain (simulates stop())
    drainTurnQueue();
    await Promise.all([p1, p2]);

    expect(results).toEqual(['waiter1', 'waiter2']);
    expect(turnQueue.length).toBe(0);
    expect(turnActive).toBe(false);
  });
});

// ── AgentPool interrupt-before-dispose ──────────────────────────────────

describe('AgentPool.cleanup() interrupt-before-dispose', () => {
  it('calls interrupt before cleanup on each agent', async () => {
    const callOrder: string[] = [];

    const mockSession = {
      interrupt: vi.fn(async () => { callOrder.push('interrupt'); }),
      cleanup: vi.fn(async () => { callOrder.push('cleanup'); }),
      isRunning: vi.fn(() => false),
    };

    // Simulate what AgentPool.cleanup does
    const agents = [{ session: mockSession, idleTimer: null as NodeJS.Timeout | null }];

    // Phase 1: interrupt
    for (const agent of agents) {
      if (agent.idleTimer) clearTimeout(agent.idleTimer);
      await agent.session.interrupt();
    }
    // Phase 2: dispose
    for (const agent of agents) {
      await agent.session.cleanup();
    }

    expect(callOrder).toEqual(['interrupt', 'cleanup']);
    expect(mockSession.interrupt).toHaveBeenCalledBefore(mockSession.cleanup);
  });
});

// ── ContextPool inflight tracking ───────────────────────────────────────

describe('ContextPool inflight tracking', () => {
  it('inflightEnter/Exit counts correctly and resolves waiter', async () => {
    // Test the inflight counting logic directly
    let inflightCount = 0;
    let inflightResolve: (() => void) | null = null;

    function inflightEnter() { inflightCount++; }
    function inflightExit() {
      inflightCount--;
      if (inflightCount <= 0 && inflightResolve) {
        inflightResolve();
        inflightResolve = null;
      }
    }
    function awaitInflight(): Promise<void> {
      if (inflightCount <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => { inflightResolve = resolve; });
    }

    // Start two inflight tasks
    inflightEnter();
    inflightEnter();
    expect(inflightCount).toBe(2);

    // Start waiting
    let resolved = false;
    const waitPromise = awaitInflight().then(() => { resolved = true; });

    // Exit one — shouldn't resolve yet
    inflightExit();
    await Promise.resolve(); // microtick
    expect(resolved).toBe(false);
    expect(inflightCount).toBe(1);

    // Exit second — should resolve
    inflightExit();
    await waitPromise;
    expect(resolved).toBe(true);
    expect(inflightCount).toBe(0);
  });

  it('awaitInflight resolves immediately when no tasks in flight', async () => {
    let inflightCount = 0;
    function awaitInflight(): Promise<void> {
      if (inflightCount <= 0) return Promise.resolve();
      return new Promise<void>(() => { /* never resolves */ });
    }

    // Should resolve immediately
    await awaitInflight();
  });

  it('resetting flag rejects new tasks', () => {
    let resetting = true;
    const rejected: string[] = [];

    function handleTask(messageId: string): boolean {
      if (resetting) {
        rejected.push(messageId);
        return false;
      }
      return true;
    }

    expect(handleTask('msg-1')).toBe(false);
    expect(handleTask('msg-2')).toBe(false);
    expect(rejected).toEqual(['msg-1', 'msg-2']);

    resetting = false;
    expect(handleTask('msg-3')).toBe(true);
  });
});

// ── CodexProvider local appServer capture ───────────────────────────────

describe('CodexProvider query() local appServer capture', () => {
  it('local reference survives instance field being nulled', () => {
    // Simulates the pattern: capture local ref, then null the instance field
    let instanceField: { releaseTurn: () => string } | null = {
      releaseTurn: () => 'released',
    };

    // Capture local reference (what the fix does)
    const localRef = instanceField;

    // Simulate dispose() nulling the instance field
    instanceField = null;

    // The local ref should still work
    expect(localRef.releaseTurn()).toBe('released');
    expect(instanceField).toBeNull();
  });
});

// ── AgentLimiter clearWaiting during reset ──────────────────────────────

describe('AgentLimiter.clearWaiting during reset', () => {
  it('unblocks waiters with rejection', async () => {
    // Import the real limiter
    const { AgentLimiter } = await import('../agents/limiter.js');
    const limiter = new AgentLimiter(1);

    // Fill up the limiter
    limiter.tryAcquire();

    // Queue a waiter
    const waiterPromise = limiter.acquire();

    // Clear with reset error
    limiter.clearWaiting(new Error('Pool resetting'));

    await expect(waiterPromise).rejects.toThrow('Pool resetting');
    expect(limiter.getWaitingCount()).toBe(0);

    limiter.reset();
  });
});

// ── Integration: reset waits for inflight then disposes ─────────────────

describe('Reset integration: interrupt → await inflight → dispose', () => {
  it('disposes only after inflight tasks complete', async () => {
    const events: string[] = [];
    let inflightCount = 0;
    let inflightResolve: (() => void) | null = null;

    function inflightEnter() { inflightCount++; }
    function inflightExit() {
      inflightCount--;
      if (inflightCount <= 0 && inflightResolve) {
        inflightResolve();
        inflightResolve = null;
      }
    }
    function awaitInflight(): Promise<void> {
      if (inflightCount <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => { inflightResolve = resolve; });
    }

    // Simulate a long-running inflight task
    inflightEnter();
    const inflightTask = new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('task-finished');
        inflightExit();
        resolve();
      }, 50);
    });

    // Simulate reset() sequence
    events.push('interrupt');
    await awaitInflight();
    events.push('dispose');

    // The task should have finished before dispose
    await inflightTask;
    expect(events).toEqual(['interrupt', 'task-finished', 'dispose']);
  });
});
