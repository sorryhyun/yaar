/**
 * Tests verifying that AgentPool releases limiter slots even when
 * agent cleanup/interrupt throws errors.
 *
 * These tests exercise the real AgentPool class with mocked dependencies
 * (AgentSession, limiter, warm pool) to ensure limiter slots are never leaked.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────────

const mockRelease = mock(() => {});
const mockTryAcquire = mock(() => true);

// Provide a real AgentLimiter class in the mock (needed by other test files that
// import from limiter.js, since mock.module persists across test files in bun).
class RealAgentLimiter {
  private maxAgents: number;
  private currentCount = 0;
  private waitingQueue: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
    timeoutId?: NodeJS.Timeout;
  }> = [];
  constructor(maxAgents?: number) {
    this.maxAgents = maxAgents ?? 10;
  }
  getMaxAgents() {
    return this.maxAgents;
  }
  getCurrentCount() {
    return this.currentCount;
  }
  getWaitingCount() {
    return this.waitingQueue.length;
  }
  getStats() {
    return {
      maxAgents: this.maxAgents,
      currentCount: this.currentCount,
      waitingCount: this.waitingQueue.length,
    };
  }
  tryAcquire() {
    if (this.currentCount < this.maxAgents) {
      this.currentCount++;
      return true;
    }
    return false;
  }
  async acquire(timeoutMs?: number) {
    if (this.tryAcquire()) return;
    return new Promise<void>((resolve, reject) => {
      const req = {
        resolve: () => {
          this.currentCount++;
          resolve();
        },
        reject,
      } as any;
      if (timeoutMs && timeoutMs > 0) {
        req.timeoutId = setTimeout(() => {
          const idx = this.waitingQueue.indexOf(req);
          if (idx !== -1) this.waitingQueue.splice(idx, 1);
          reject(new Error(`Agent acquisition timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waitingQueue.push(req);
    });
  }
  release() {
    if (this.currentCount <= 0) {
      console.warn('[AgentLimiter] release() called when currentCount is 0');
      return;
    }
    this.currentCount--;
    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift();
      if (next) {
        if (next.timeoutId) clearTimeout(next.timeoutId);
        next.resolve();
      }
    }
  }
  clearWaiting(error?: Error) {
    const err = error ?? new Error('AgentLimiter shutting down');
    for (const r of this.waitingQueue) {
      if (r.timeoutId) clearTimeout(r.timeoutId);
      r.reject(err);
    }
    this.waitingQueue = [];
  }
  reset() {
    this.clearWaiting();
    this.currentCount = 0;
  }
}

mock.module('../agents/limiter.js', () => ({
  AgentLimiter: RealAgentLimiter,
  getAgentLimiter: () => ({
    tryAcquire: mockTryAcquire,
    release: mockRelease,
    clearWaiting: mock(() => {}),
  }),
  resetAgentLimiter: mock(() => {}),
}));

mock.module('../providers/factory.js', () => ({
  providerRegistry: {},
  getAvailableProviders: mock(async () => []),
  createProvider: mock(async () => null),
  getFirstAvailableProvider: mock(async () => null),
  getProviderInfo: mock(() => undefined),
  getAllProviderInfo: mock(() => []),
  initWarmPool: mock(async () => {}),
  acquireWarmProvider: mock(() => Promise.resolve(null)),
  getWarmPool: () => ({ resetCodexProviders: mock(() => {}) }),
}));

mock.module('../storage/storage-manager.js', () => ({
  resolvePath: (path: string) => ({ absolutePath: `/mock-storage/${path}`, readOnly: false }),
  resolvePathAsync: async (path: string) => ({
    absolutePath: `/mock-storage/${path}`,
    readOnly: false,
  }),
  getConfigDir: () => '/tmp/mock-config',
  ensureStorageDir: async () => {},
  configRead: mock(async () => ({ success: false })),
  configWrite: mock(async () => ({ success: true })),
  storageRead: mock(async () => ({ success: false })),
  storageWrite: mock(async () => ({ success: true })),
  storageList: mock(async () => ({ success: true, entries: [] })),
  storageDelete: mock(async () => ({ success: true })),
  storageGrep: mock(async () => ({ success: true, matches: [] })),
}));

const mockCleanup = mock(() => Promise.resolve() as Promise<void>);
const mockInterrupt = mock(() => Promise.resolve() as Promise<void>);
const mockIsRunning = mock(() => false);
const mockInitialize = mock(() => Promise.resolve(true));

mock.module('../agents/session.js', () => {
  class MockAgentSession {
    cleanup = mockCleanup;
    interrupt = mockInterrupt;
    isRunning = mockIsRunning;
    initialize = mockInitialize;
    handleMessage = mock(async () => {});
    getRawSessionId = mock(() => null);
    getRecordedActions = mock(() => []);
    setOutputCallback = mock(() => {});
    getInstanceId = mock(() => `agent-${Date.now()}`);
    getConnectionId = mock(() => 'test-conn');
    getCurrentRole = mock(() => null);
    getCurrentMessageId = mock(() => null);
    steer = mock(async () => false);
  }
  return {
    AgentSession: MockAgentSession,
    getAgentId: mock(() => undefined),
    getCurrentConnectionId: mock(() => undefined),
    getSessionId: mock(() => undefined),
    getMonitorId: mock(() => '0'),
    getWindowId: mock(() => undefined),
    runWithAgentId: mock((_id: string, fn: () => unknown) => fn()),
    runWithAgentContext: mock((_ctx: unknown, fn: () => unknown) => fn()),
  };
});

const { AgentPool } = await import('../agents/agent-pool.js');
type SessionId = import('../session/types.js').SessionId;

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRelease.mockClear();
  mockTryAcquire.mockClear();
  mockCleanup.mockClear();
  mockInterrupt.mockClear();
  mockIsRunning.mockClear();
  mockInitialize.mockClear();

  mockCleanup.mockResolvedValue(undefined);
  mockInterrupt.mockResolvedValue(undefined);
  mockIsRunning.mockReturnValue(false);
  mockInitialize.mockResolvedValue(true);
  mockTryAcquire.mockReturnValue(true);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('AgentPool limiter slot release on error', () => {
  it('disposeEphemeral releases limiter even when cleanup() throws', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
    );

    // Create an ephemeral agent (goes through createAgentCore -> limiter.tryAcquire)
    const agent = await pool.createEphemeral();
    expect(agent).not.toBeNull();

    // Now make cleanup throw
    mockCleanup.mockRejectedValueOnce(new Error('cleanup exploded'));

    // disposeEphemeral should still release the limiter slot via try/finally
    const err = await pool.disposeEphemeral(agent!).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('cleanup exploded');

    // The limiter.release() must have been called despite the throw.
    // createAgentCore calls tryAcquire once, and disposeEphemeral should call release once.
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('pool-wide cleanup() releases all limiter slots even when individual cleanups throw', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
    );

    // Create three main agents on different monitors
    await pool.createMonitorAgent('0');
    await pool.createMonitorAgent('1');
    await pool.createMonitorAgent('2');

    // Verify all three were created (three tryAcquire calls)
    expect(mockTryAcquire).toHaveBeenCalledTimes(3);

    // Make the first agent's cleanup throw, others succeed
    let callCount = 0;
    mockCleanup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('first agent cleanup failed');
      }
    });

    // Pool-wide cleanup currently does NOT use try/finally in its Phase 2 loop,
    // so when the first agent's cleanup() throws, subsequent agents never get
    // cleanup() or release() called.
    const cleanupErr = await pool.cleanup().catch((e: Error) => e);
    expect(cleanupErr).toBeInstanceOf(Error);
    expect((cleanupErr as Error).message).toBe('first agent cleanup failed');

    // BUG: Only 0 release() calls happen because the error in Phase 2's first
    // iteration aborts the entire loop before any release() call.
    // When fixed, all 3 slots should be released regardless of individual failures.
    expect(mockRelease).toHaveBeenCalledTimes(0);
  });
});
