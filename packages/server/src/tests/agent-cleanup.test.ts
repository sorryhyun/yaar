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
  configStatMtime: mock(async () => null),
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

mock.module('../agents/agent-session.js', () => {
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
    getUsage = mock(() => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
    getConnectionId = mock(() => 'test-conn');
    getCurrentRole = mock(() => null);
    getCurrentMessageId = mock(() => null);
    steer = mock(async () => false);
    prewarm = mock(async () => {});
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
import type { SessionId } from '../session/types.js';
import { getAgentToken, resolveAgentToken } from '../mcp/agent-tokens.js';

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

    // Pool-wide cleanup routes every agent through `disposeAgent` (try/finally on
    // the release) and logs rather than rethrows, so one agent's failure is not the
    // next agent's. It used to abort the whole Phase 2 loop on the first throw,
    // leaking that agent's slot and every slot after it for the life of the process.
    const cleanupErr = await pool.cleanup().catch((e: Error) => e);
    expect(cleanupErr).toBeUndefined();

    // All three cleanups were attempted...
    expect(mockCleanup).toHaveBeenCalledTimes(3);
    // ...and all three slots came back, including the one whose cleanup threw.
    expect(mockRelease).toHaveBeenCalledTimes(3);
  });

  it('cleanup() does not double-release a slot a concurrent disposer already took', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
    );

    await pool.createMonitorAgent('0');
    await pool.createMonitorAgent('1');
    expect(mockTryAcquire).toHaveBeenCalledTimes(2);

    // `MonitorRegistry.remove` never awaits this, so it interleaves with teardown.
    // Both paths reach the same agent; only one may release its slot, or the global
    // count under-runs and the process admits past MAX_AGENTS while agents are live.
    const racing = pool.removeMonitorAgent('0');
    await pool.cleanup();
    await racing;

    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it('createAgentCore returns its slot when initialize throws', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
    );

    // What `acquireWarmProvider()` does on an under-versioned Codex CLI. No caller in
    // the pool's chain catches it, so the slot was held with no agent to show for it.
    mockInitialize.mockRejectedValueOnce(new Error('CodexVersionError'));

    const err = await pool.createMonitorAgent('0').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(mockTryAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('AgentPool credential hygiene', () => {
  it('revokes the agent MCP token on dispose', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
    );

    const agent = await pool.createEphemeral();
    const token = getAgentToken(agent!.instanceId);
    expect(resolveAgentToken(token)).toBe(agent!.instanceId);

    await pool.disposeEphemeral(agent!);

    // `revokeAgentToken` was exported, documented, and called from nowhere: the two
    // maps grew for the process's life and a dead agent's `X-Agent-Token` stayed
    // resolvable, failing closed only by accident further downstream.
    expect(resolveAgentToken(token)).toBeNull();
  });
});

// Lives beside the cleanup tests because it needs the same mocked AgentPool
// scaffolding, and a second `mock.module` file would cost another test partition.
describe('AgentPool agent identity', () => {
  it('mints instance ids that do not collide across pools', async () => {
    // Per-pool counters both start at 0, so under the old
    // `agent-${counter}-${Date.now()}` these two pools minted the *same* id whenever
    // they created their first agent in the same millisecond — which is exactly what
    // two browser tabs connecting together do.
    const poolA = new AgentPool(
      'session-a' as SessionId,
      mock(() => {}),
    );
    const poolB = new AgentPool(
      'session-b' as SessionId,
      mock(() => {}),
    );

    const ids = new Set<string>();
    for (const pool of [poolA, poolB]) {
      for (const monitorId of ['0', '1', '2']) {
        const agent = await pool.createMonitorAgent(monitorId);
        expect(agent).not.toBeNull();
        ids.add(agent!.instanceId);
      }
    }

    expect(ids.size).toBe(6);
  });
});
