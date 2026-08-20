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
  configStatMtime: mock(async () => null),
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

// The real actionEmitter is used here on purpose. A partial stub of it leaks:
// mock.module is process-wide and is never restored between files, so every test
// that ran after this one saw an emitter missing `on`/`off`/`emitActionWithFeedback`,
// and `new LiveSession()` died on `actionEmitter.on(...)`. Whether that blew up
// depended on directory order — green on macOS, red on CI's Linux. The emitter is a
// plain EventEmitter with no side effects worth stubbing; nothing here touches it.

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
  turnOptionsFor: mock(() => ({ model: undefined, allowedTools: [] })),
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

// ── Test setup ─────────────────────────────────────────────────────────────

const { ContextPool } = await import('../agents/context-pool.js');
import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import type { Task } from '../agents/pool-types.js';
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
    expect(pool.agentPool.hasMonitorAgent('0')).toBe(true);
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(false);

    const created = await pool.createMonitorAgent('1');

    expect(created).toBe(true);
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(true);
    expect(pool.agentPool.getMonitorAgentCount()).toBe(2);
  });

  it('removeMonitorAgent cleans up the agent and queue', async () => {
    await pool.createMonitorAgent('1');
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(true);
    expect(pool.agentPool.getMonitorAgentCount()).toBe(2);

    await pool.removeMonitorAgent('1');

    expect(pool.agentPool.hasMonitorAgent('1')).toBe(false);
    expect(pool.agentPool.getMonitorAgentCount()).toBe(1);
    // Only default monitor should remain
    expect(pool.agentPool.hasMonitorAgent('0')).toBe(true);
  });

  it('multiple monitors can coexist independently', async () => {
    await pool.createMonitorAgent('1');

    expect(pool.agentPool.hasMonitorAgent('0')).toBe(true);
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(true);
    expect(pool.agentPool.getMonitorAgentCount()).toBe(2);

    // Removing default monitor should not affect monitor 1
    await pool.removeMonitorAgent('0');

    expect(pool.agentPool.hasMonitorAgent('0')).toBe(false);
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(true);
    expect(pool.agentPool.getMonitorAgentCount()).toBe(1);
  });

  it('hasMonitorAgent returns false after removal', async () => {
    await pool.createMonitorAgent('1');
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(true);

    await pool.removeMonitorAgent('1');
    expect(pool.agentPool.hasMonitorAgent('1')).toBe(false);

    // Verify a never-created monitor also returns false
    expect(pool.agentPool.hasMonitorAgent('99')).toBe(false);
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
    const onZero = await pool.agentPool.appAgents.getOrCreate('0', 'storage');
    const onOne = await pool.agentPool.appAgents.getOrCreate('1', 'storage');

    expect(onZero).not.toBeNull();
    expect(onOne).not.toBeNull();
    expect(onOne!.instanceId).not.toBe(onZero!.instanceId);
    expect(pool.agentPool.appAgents.size).toBe(2);
  });

  it('reuses one agent per (monitor, app) pair', async () => {
    const first = await pool.agentPool.appAgents.getOrCreate('1', 'storage');
    const again = await pool.agentPool.appAgents.getOrCreate('1', 'storage');

    expect(again!.instanceId).toBe(first!.instanceId);
    expect(pool.agentPool.appAgents.size).toBe(1);
  });

  it('a monitor cannot see another monitor’s app agent', async () => {
    await pool.agentPool.appAgents.getOrCreate('0', 'storage');

    expect(pool.agentPool.appAgents.has('0', 'storage')).toBe(true);
    expect(pool.agentPool.appAgents.has('1', 'storage')).toBe(false);
    expect(pool.agentPool.appAgents.get('1', 'storage')).toBeUndefined();
  });

  it('removing a monitor disposes only its own app agents', async () => {
    const onZero = await pool.agentPool.appAgents.getOrCreate('0', 'storage');
    await pool.agentPool.appAgents.getOrCreate('1', 'storage');
    await pool.agentPool.appAgents.getOrCreate('1', 'dock');
    expect(pool.agentPool.appAgents.size).toBe(3);

    await pool.removeMonitorAgent('1');

    expect(pool.agentPool.appAgents.size).toBe(1);
    expect(pool.agentPool.appAgents.has('1', 'storage')).toBe(false);
    expect(pool.agentPool.appAgents.has('1', 'dock')).toBe(false);
    expect(pool.agentPool.appAgents.get('0', 'storage')!.instanceId).toBe(onZero!.instanceId);
  });

  it('findMonitorForAgent reports an app agent’s owning monitor', async () => {
    // Every MCP request scopes its window lookups by getMonitorId(), which is fed
    // from here. If app agents were absent, they'd all default to monitor 0 and an
    // app agent on monitor 1 would look for its own window on monitor 0.
    const onOne = await pool.agentPool.appAgents.getOrCreate('1', 'devtools');
    const onZero = await pool.agentPool.appAgents.getOrCreate('0', 'devtools');

    expect(pool.agentPool.findMonitorForAgent(onOne!.instanceId)).toBe('1');
    expect(pool.agentPool.findMonitorForAgent(onZero!.instanceId)).toBe('0');
  });

  it('reports the owning monitor on the roster and resolves it back from an instanceId', async () => {
    const onOne = await pool.agentPool.appAgents.getOrCreate('1', 'storage');

    const entry = pool.agentPool.listAgents().find((a) => a.id === onOne!.instanceId);
    expect(entry).toMatchObject({ type: 'app', appId: 'storage', monitorId: '1' });

    expect(pool.agentPool.appAgents.findByAgentId(onOne!.instanceId)).toEqual({
      monitorId: '1',
      appId: 'storage',
    });
  });
});

describe('App events reach only their own monitor’s subscribers', () => {
  let pool: InstanceType<typeof ContextPool>;
  let windowState: WindowStateRegistry;
  let delivered: Task[];

  /** An app window for `appId` — the raw id is the appId, so both monitors share it. */
  function appWindow(appId: string): OSAction {
    return {
      type: 'window.create',
      windowId: appId,
      title: appId,
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      content: { renderer: 'iframe', data: `yaar://apps/${appId}` },
      appId,
    } as OSAction;
  }

  beforeEach(async () => {
    windowState = new WindowStateRegistry();
    // The same app open on both monitors — the case where a raw-keyed index collides.
    windowState.handleAction(appWindow('ai-chat'), '0');
    windowState.handleAction(appWindow('ai-chat'), '1');

    pool = new ContextPool(
      'test-session' as SessionId,
      windowState as any,
      createMockReloadCache() as any,
      mock(() => {}),
    );
    await pool.initialize();
    await pool.createMonitorAgent('1');

    delivered = [];
    // Deliver tasks straight into an array instead of running an agent turn.
    (pool as any).handleTask = async (task: Task) => {
      delivered.push(task);
    };
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  /** Subscribe monitor 0's agent to ai-chat's "dialog" channel on monitor 0's window. */
  function subscribeMonitorZero(): void {
    pool.windowSubscriptionPolicy.subscribeChannels({
      subscriberAgentKey: 'monitor-0',
      subscriberType: 'monitor',
      subscriberMonitorId: '0',
      targetWindowId: '0/ai-chat',
      channels: ['dialog'],
      mode: 'wake',
      debounceMs: 10,
    });
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('does not deliver monitor 1’s app event to monitor 0’s subscriber', async () => {
    subscribeMonitorZero();

    // The frontend reports the scoped key of the window that emitted.
    pool.notifyAppChannel('1/ai-chat', 'dialog', { message: 'from monitor 1' });
    await settle();

    expect(delivered).toEqual([]);
  });

  it('delivers monitor 0’s app event to monitor 0’s subscriber', async () => {
    subscribeMonitorZero();

    pool.notifyAppChannel('0/ai-chat', 'dialog', { message: 'from monitor 0' });
    await settle();

    expect(delivered.length).toBe(1);
    expect(delivered[0].content).toContain('from monitor 0');
  });

  it('clears only the closed window’s subscriptions', async () => {
    subscribeMonitorZero();

    // Monitor 1's copy of the app closing must not tear down monitor 0's subscription.
    pool.handleWindowClose('1/ai-chat', 'ai-chat', '1');

    pool.notifyAppChannel('0/ai-chat', 'dialog', { message: 'still listening' });
    await settle();

    expect(delivered.length).toBe(1);
  });
});

/**
 * `app.emit(channel, payload, { wakeAgent: true })` — the one recipient the
 * subscription table cannot express, because an app agent holds no verb tools and
 * so can never subscribe to anything. The emitting iframe asks for its own agent
 * instead, per emit: the same event raised by the app's UI rather than by work the
 * agent started must wake nobody.
 *
 * The gate under test is "an agent that already exists". Delivery routes through
 * AppTaskProcessor, which creates an app agent on demand — so without it, an app
 * that emitted while its agent was retired would spawn one, and pay a model turn,
 * to report work nobody asked for.
 */
describe('wakeAgent wakes the emitting app’s own agent', () => {
  let pool: InstanceType<typeof ContextPool>;
  let windowState: WindowStateRegistry;
  let delivered: Task[];

  function appWindow(appId: string): OSAction {
    return {
      type: 'window.create',
      windowId: appId,
      title: appId,
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      content: { renderer: 'iframe', data: `yaar://apps/${appId}` },
      appId,
    } as OSAction;
  }

  beforeEach(async () => {
    windowState = new WindowStateRegistry();
    windowState.handleAction(appWindow('ai-chat'), '0');
    windowState.handleAction(appWindow('ai-chat'), '1');

    pool = new ContextPool(
      'test-session' as SessionId,
      windowState as any,
      createMockReloadCache() as any,
      mock(() => {}),
    );
    await pool.initialize();
    await pool.createMonitorAgent('1');

    delivered = [];
    (pool as any).handleTask = async (task: Task) => {
      delivered.push(task);
    };
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('delivers the event to the app agent that is running', async () => {
    await pool.agentPool.appAgents.getOrCreate('0', 'ai-chat');

    pool.notifyAppChannel('0/ai-chat', 'worker', { answer: 'done' }, undefined, {
      wakeAgent: true,
    });
    await settle();

    expect(delivered.length).toBe(1);
    expect(delivered[0].requestedType).toBe('app');
    expect(delivered[0].windowId).toBe('0/ai-chat');
    expect(delivered[0].monitorId).toBe('0');
    expect(delivered[0].content).toContain('done');
  });

  it('delivers nothing when the app has no agent running', async () => {
    expect(pool.agentPool.appAgents.has('0', 'ai-chat')).toBe(false);

    pool.notifyAppChannel('0/ai-chat', 'worker', { answer: 'done' }, undefined, {
      wakeAgent: true,
    });
    await settle();

    expect(delivered).toEqual([]);
  });

  it('leaves an emit without the flag delivering to subscribers only', async () => {
    await pool.agentPool.appAgents.getOrCreate('0', 'ai-chat');

    pool.notifyAppChannel('0/ai-chat', 'worker', { answer: 'done' });
    await settle();

    expect(delivered).toEqual([]);
  });

  it('wakes the agent on the emitting window’s own monitor', async () => {
    // Both monitors run their own copy of the app and its own agent. The raw window
    // id is shared, so an unscoped lookup would wake whichever was found first.
    await pool.agentPool.appAgents.getOrCreate('0', 'ai-chat');
    await pool.agentPool.appAgents.getOrCreate('1', 'ai-chat');

    pool.notifyAppChannel('1/ai-chat', 'worker', { answer: 'from monitor 1' }, undefined, {
      wakeAgent: true,
    });
    await settle();

    expect(delivered.length).toBe(1);
    expect(delivered[0].monitorId).toBe('1');
    expect(delivered[0].windowId).toBe('1/ai-chat');
  });
});
