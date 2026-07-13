/**
 * Tests for multi-monitor lifecycle in ContextPool.
 *
 * Validates createMonitorAgent, removeMonitorAgent, hasMonitorAgent,
 * and independent coexistence of multiple monitors.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AITransport } from '../providers/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

function createMockProvider(): AITransport {
  return {
    name: 'mock',
    providerType: 'claude',
    systemPrompt: '',
    dispose: mock(async () => {}),
    isAvailable: async () => true,
    query: mock(() => {}),
    interrupt: mock(() => {}),
  } as unknown as AITransport;
}

mock.module('../providers/factory.js', () => ({
  providerRegistry: {},
  getAvailableProviders: mock(async () => []),
  createProvider: mock(async () => null),
  getFirstAvailableProvider: mock(async () => null),
  getProviderInfo: mock(() => undefined),
  getAllProviderInfo: mock(() => []),
  initWarmPool: mock(async () => {}),
  acquireWarmProvider: mock(async () => createMockProvider()),
  getWarmPool: () => ({ resetCodexProviders: mock(() => {}) }),
}));

mock.module('../logging/session-logger.js', () => {
  class MockSessionLogger {
    logUserMessage = mock(() => {});
    logAgentMessage = mock(() => {});
    logAction = mock(() => {});
    logThreadId = mock(() => {});
    registerAgent = mock(() => {});
    close = mock(() => {});
    setLogger = mock(() => {});
  }
  return {
    createSession: mock(async () => ({
      sessionId: 'test-session',
      logPath: '/tmp/test',
      directory: '/tmp/test',
    })),
    SessionLogger: MockSessionLogger,
  };
});

// Provide a real AgentLimiter class (mock.module persists across files).
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
    tryAcquire: () => true,
    release: mock(() => {}),
    clearWaiting: mock(() => {}),
  }),
  resetAgentLimiter: mock(() => {}),
}));

mock.module('../storage/storage-manager.js', () => ({
  configRead: mock(async () => ({ success: false })),
  configWrite: mock(async () => {}),
  resolvePath: (path: string) => ({ absolutePath: `/mock-storage/${path}`, readOnly: false }),
  resolvePathAsync: async (path: string) => ({
    absolutePath: `/mock-storage/${path}`,
    readOnly: false,
  }),
  getConfigDir: () => '/tmp/mock-config',
  ensureStorageDir: async () => {},
  storageRead: mock(async () => ({ success: false })),
  storageWrite: mock(async () => ({ success: true })),
  storageList: mock(async () => ({ success: true, entries: [] })),
  storageDelete: mock(async () => ({ success: true })),
  storageGrep: mock(async () => ({ success: true, matches: [] })),
}));

mock.module('../providers/environment.js', () => ({
  buildEnvironmentSection: mock(async () => ''),
}));

mock.module('../session/action-emitter.js', () => ({
  actionEmitter: {
    onAction: mock(() => mock(() => {})),
    emitAction: mock(() => {}),
    resolveFeedback: mock(() => {}),
  },
}));

mock.module('../agents/profiles/index.js', () => ({
  DEVELOPER_PROFILE: { id: 'developer', systemPrompt: '', allowedTools: [] },
  SESSION_AGENT_PROFILE: { id: 'session', systemPrompt: '', allowedTools: [] },
  VERB_TOOL_NAMES: [],
  VERB_TOOLS: [],
  APP_AGENT_TOOL_NAMES: [],
  buildAppAgentProfile: mock(() => ({ id: 'app', systemPrompt: '', allowedTools: [] })),
  ORCHESTRATOR_PROMPT: '',
  getOrchestratorPrompt: mock(() => ''),
  getDeveloperAllowedTools: mock(() => []),
  claudeModelToCodex: mock(() => undefined),
  getMonitorTurnOptions: mock(() => ({ model: undefined, allowedTools: [] })),
  CODEX_AGENT_ROLES: {},
  codexRoleToToml: mock(() => ''),
}));

// Mock AgentSession so we don't need real providers
mock.module('../agents/agent-session.js', () => {
  class MockAgentSession {
    initialize = mock(async () => true);
    handleMessage = mock(async () => {});
    isRunning = mock(() => false);
    interrupt = mock(async () => {});
    cleanup = mock(async () => {});
    getRawSessionId = mock(() => null);
    getRecordedActions = mock(() => []);
    setOutputCallback = mock(() => {});
    getInstanceId = mock(() => `agent-${Date.now()}`);
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

// ── Test setup ─────────────────────────────────────────────────────────────

const { ContextPool } = await import('../agents/context-pool.js');
import type { SessionId } from '../session/types.js';

function createMockWindowState() {
  return {
    listWindows: () => [],
    clear: mock(() => {}),
    getWindow: mock(() => {}),
    setWindow: mock(() => {}),
    removeWindow: mock(() => {}),
    setAppProtocol: mock(() => {}),
  };
}

function createMockReloadCache() {
  return {
    findMatches: () => [],
    record: () => {},
    clear: mock(() => {}),
  };
}

describe('Multi-monitor lifecycle', () => {
  let pool: InstanceType<typeof ContextPool>;

  beforeEach(async () => {
    pool = new ContextPool(
      'test-session' as SessionId,
      createMockWindowState() as any,
      createMockReloadCache() as any,
      mock(() => {}), // broadcast callback
    );
    // Initialize creates the default default monitor agent
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  it('createMonitorAgent creates a new agent for a monitor', async () => {
    expect(pool.hasMonitorAgent('0')).toBe(true);
    expect(pool.hasMonitorAgent('1')).toBe(false);

    const created = await pool.createMonitorAgent('1');

    expect(created).toBe(true);
    expect(pool.hasMonitorAgent('1')).toBe(true);
    expect(pool.getMonitorAgentCount()).toBe(2);
  });

  it('removeMonitorAgent cleans up the agent and queue', async () => {
    await pool.createMonitorAgent('1');
    expect(pool.hasMonitorAgent('1')).toBe(true);
    expect(pool.getMonitorAgentCount()).toBe(2);

    await pool.removeMonitorAgent('1');

    expect(pool.hasMonitorAgent('1')).toBe(false);
    expect(pool.getMonitorAgentCount()).toBe(1);
    // Only default monitor should remain
    expect(pool.hasMonitorAgent('0')).toBe(true);
  });

  it('multiple monitors can coexist independently', async () => {
    await pool.createMonitorAgent('1');

    expect(pool.hasMonitorAgent('0')).toBe(true);
    expect(pool.hasMonitorAgent('1')).toBe(true);
    expect(pool.getMonitorAgentCount()).toBe(2);

    // Removing default monitor should not affect monitor 1
    await pool.removeMonitorAgent('0');

    expect(pool.hasMonitorAgent('0')).toBe(false);
    expect(pool.hasMonitorAgent('1')).toBe(true);
    expect(pool.getMonitorAgentCount()).toBe(1);
  });

  it('hasMonitorAgent returns false after removal', async () => {
    await pool.createMonitorAgent('1');
    expect(pool.hasMonitorAgent('1')).toBe(true);

    await pool.removeMonitorAgent('1');
    expect(pool.hasMonitorAgent('1')).toBe(false);

    // Verify a never-created monitor also returns false
    expect(pool.hasMonitorAgent('99')).toBe(false);
  });
});

describe('App agents are scoped to their monitor', () => {
  let pool: InstanceType<typeof ContextPool>;

  beforeEach(async () => {
    pool = new ContextPool(
      'test-session' as SessionId,
      createMockWindowState() as any,
      createMockReloadCache() as any,
      mock(() => {}),
    );
    await pool.initialize();
    await pool.createMonitorAgent('1');
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  it('the same app on two monitors gets two distinct agents', async () => {
    const onZero = await pool.agentPool.getOrCreateAppAgent('0', 'storage');
    const onOne = await pool.agentPool.getOrCreateAppAgent('1', 'storage');

    expect(onZero).not.toBeNull();
    expect(onOne).not.toBeNull();
    expect(onOne!.instanceId).not.toBe(onZero!.instanceId);
    expect(pool.agentPool.getAppAgentCount()).toBe(2);
  });

  it('reuses one agent per (monitor, app) pair', async () => {
    const first = await pool.agentPool.getOrCreateAppAgent('1', 'storage');
    const again = await pool.agentPool.getOrCreateAppAgent('1', 'storage');

    expect(again!.instanceId).toBe(first!.instanceId);
    expect(pool.agentPool.getAppAgentCount()).toBe(1);
  });

  it('a monitor cannot see another monitor’s app agent', async () => {
    await pool.agentPool.getOrCreateAppAgent('0', 'storage');

    expect(pool.agentPool.hasAppAgent('0', 'storage')).toBe(true);
    expect(pool.agentPool.hasAppAgent('1', 'storage')).toBe(false);
    expect(pool.agentPool.getAppAgent('1', 'storage')).toBeUndefined();
  });

  it('removing a monitor disposes only its own app agents', async () => {
    const onZero = await pool.agentPool.getOrCreateAppAgent('0', 'storage');
    await pool.agentPool.getOrCreateAppAgent('1', 'storage');
    await pool.agentPool.getOrCreateAppAgent('1', 'dock');
    expect(pool.agentPool.getAppAgentCount()).toBe(3);

    await pool.removeMonitorAgent('1');

    expect(pool.agentPool.getAppAgentCount()).toBe(1);
    expect(pool.agentPool.hasAppAgent('1', 'storage')).toBe(false);
    expect(pool.agentPool.hasAppAgent('1', 'dock')).toBe(false);
    expect(pool.agentPool.getAppAgent('0', 'storage')!.instanceId).toBe(onZero!.instanceId);
  });

  it('reports the owning monitor on the roster and resolves it back from an instanceId', async () => {
    const onOne = await pool.agentPool.getOrCreateAppAgent('1', 'storage');

    const entry = pool.agentPool.listAgents().find((a) => a.id === onOne!.instanceId);
    expect(entry).toMatchObject({ type: 'app', appId: 'storage', monitorId: '1' });

    expect(pool.agentPool.findAppForAgent(onOne!.instanceId)).toEqual({
      monitorId: '1',
      appId: 'storage',
    });
  });
});
