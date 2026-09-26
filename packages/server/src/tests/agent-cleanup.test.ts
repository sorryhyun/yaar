/**
 * Tests verifying that AgentPool releases limiter slots even when
 * agent cleanup/interrupt throws errors.
 *
 * These tests exercise the real AgentPool class with mocked dependencies
 * (AgentSession, limiter, warm pool) to ensure limiter slots are never leaked.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test';
import { installMockAgentSession } from './helpers/mock-agent-session.js';
import { createTestPoolHost } from './helpers/test-pool-host.js';

// ── Mocks ────────────────────────────────────────────────────────────────

const mockRelease = mock(() => {});
const mockTryAcquire = mock(() => true);

// Provide a real AgentLimiter class in the mock (needed by other test files that
// import from limiter.js, since mock.module persists across test files in bun).
class RealAgentLimiter {
  private maxAgents: number;
  private currentCount = 0;
  constructor(maxAgents?: number) {
    this.maxAgents = maxAgents ?? 10;
  }
  getMaxAgents() {
    return this.maxAgents;
  }
  getCurrentCount() {
    return this.currentCount;
  }
  getStats() {
    return { maxAgents: this.maxAgents, currentCount: this.currentCount };
  }
  tryAcquire() {
    if (this.currentCount < this.maxAgents) {
      this.currentCount++;
      return true;
    }
    return false;
  }
  release() {
    if (this.currentCount > 0) this.currentCount--;
  }
  reset() {
    this.currentCount = 0;
  }
}

mock.module('../agents/limiter.js', () => ({
  AgentLimiter: RealAgentLimiter,
  getAgentLimiter: () => ({
    tryAcquire: mockTryAcquire,
    release: mockRelease,
  }),
  resetAgentLimiter: mock(() => {}),
}));

const mockProviderDispose = mock(async () => {});
function fakeProvider() {
  return { name: 'fake', providerType: 'claude', dispose: mockProviderDispose };
}

mock.module('../providers/factory.js', () => ({
  getAvailableProviders: mock(async () => []),
  initWarmPool: mock(async () => {}),
  acquireWarmProvider: mock(() => Promise.resolve(fakeProvider())),
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
  storageWriteStream: mock(async () => ({
    success: true,
    stream: {
      write: async () => {},
      commit: async () => ({ success: true, bytes: 0 }),
      abort: async () => {},
    },
  })),
  storageList: mock(async () => ({ success: true, entries: [] })),
  storageDelete: mock(async () => ({ success: true })),
  storageGrep: mock(async () => ({ success: true, matches: [] })),
}));

const mockCleanup = mock(() => Promise.resolve() as Promise<void>);
const mockInterrupt = mock(() => Promise.resolve() as Promise<void>);
const mockIsRunning = mock(() => false);
const mockAttachProvider = mock((_provider: unknown) => {});

installMockAgentSession({
  cleanup: mockCleanup,
  interrupt: mockInterrupt,
  isRunning: mockIsRunning,
  attachProvider: mockAttachProvider,
  getMonitorId: () => '0',
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
  mockAttachProvider.mockClear();
  mockProviderDispose.mockClear();

  mockCleanup.mockResolvedValue(undefined);
  mockInterrupt.mockResolvedValue(undefined);
  mockIsRunning.mockReturnValue(false);
  mockAttachProvider.mockImplementation(() => {});
  mockTryAcquire.mockReturnValue(true);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('AgentPool limiter slot release on error', () => {
  it('disposeEphemeral releases limiter even when cleanup() throws', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
      createTestPoolHost(),
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
      createTestPoolHost(),
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
      createTestPoolHost(),
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

  it('createAgentCore returns its slot, and the provider, when attaching throws', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
      createTestPoolHost(),
    );

    // No caller in the pool's chain catches a throw out of agent construction, so the
    // slot was held with no agent to show for it.
    mockAttachProvider.mockImplementationOnce(() => {
      throw new Error('attach failed');
    });

    const err = await pool.createMonitorAgent('0').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(mockTryAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockProviderDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a supplied monitor provider when the agent limit refuses it', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
      createTestPoolHost(),
    );
    mockTryAcquire.mockReturnValueOnce(false);

    // `ContextPool` hands its monitor tier a provider it acquired itself, and used to
    // dispose it by hand at each of its four spawn sites.
    const agent = await pool.createMonitorAgent('1', fakeProvider() as never);
    expect(agent).toBeNull();
    expect(mockProviderDispose).toHaveBeenCalledTimes(1);
    expect(pool.getMonitorAgent('1')).toBeNull();
  });

  it('takes no slot and reports an error when no provider is available', async () => {
    const broadcast = mock((_event: unknown) => {});
    const pool = new AgentPool(
      'test-session' as SessionId,
      broadcast,
      createTestPoolHost(),
      async () => null,
    );

    expect(await pool.createEphemeral()).toBeNull();
    expect(mockTryAcquire).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ERROR' }));
  });
});

describe('AgentPool credential hygiene', () => {
  it('revokes the agent MCP token on dispose', async () => {
    const pool = new AgentPool(
      'test-session' as SessionId,
      mock(() => {}),
      createTestPoolHost(),
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
      createTestPoolHost(),
    );
    const poolB = new AgentPool(
      'session-b' as SessionId,
      mock(() => {}),
      createTestPoolHost(),
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
