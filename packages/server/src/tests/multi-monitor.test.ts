/**
 * Tests for multi-monitor lifecycle in ContextPool.
 *
 * Validates createMonitorAgent, removeMonitorAgent, hasMainAgent,
 * and independent coexistence of multiple monitors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AITransport } from '../providers/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

function createMockProvider(): AITransport {
  return {
    name: 'mock',
    providerType: 'claude',
    systemPrompt: '',
    dispose: vi.fn(async () => {}),
    isAvailable: async () => true,
    query: vi.fn(),
    interrupt: vi.fn(),
  };
}

vi.mock('../providers/factory.js', () => ({
  acquireWarmProvider: vi.fn(async () => createMockProvider()),
  getWarmPool: () => ({ resetCodexProviders: vi.fn() }),
}));

vi.mock('../session/broadcast-center.js', () => ({
  getBroadcastCenter: () => ({
    publishToSession: vi.fn(),
  }),
}));

vi.mock('../logging/index.js', () => {
  class MockSessionLogger {
    logUserMessage = vi.fn();
    logAgentMessage = vi.fn();
    logAction = vi.fn();
    logThreadId = vi.fn();
    registerAgent = vi.fn();
    close = vi.fn();
    setLogger = vi.fn();
  }
  return {
    createSession: vi.fn(async () => ({
      sessionId: 'test-session',
      logPath: '/tmp/test',
      directory: '/tmp/test',
    })),
    SessionLogger: MockSessionLogger,
  };
});

vi.mock('../agents/limiter.js', () => ({
  getAgentLimiter: () => ({
    tryAcquire: () => true,
    release: vi.fn(),
    clearWaiting: vi.fn(),
  }),
}));

vi.mock('../storage/storage-manager.js', () => ({
  configRead: vi.fn(async () => ({ success: false })),
}));

vi.mock('../providers/environment.js', () => ({
  buildEnvironmentSection: vi.fn(async () => ''),
}));

vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    onAction: vi.fn(() => vi.fn()),
    emitAction: vi.fn(),
    resolveFeedback: vi.fn(),
  },
}));

vi.mock('../agents/profiles.js', () => ({
  getProfile: vi.fn(() => ({ id: 'default', systemPrompt: '', allowedTools: [] })),
  ORCHESTRATOR_PROFILE: { id: 'orchestrator', systemPrompt: '', allowedTools: [] },
}));

// Mock AgentSession so we don't need real providers
vi.mock('../agents/session.js', () => {
  class MockAgentSession {
    initialize = vi.fn(async () => true);
    handleMessage = vi.fn(async () => {});
    isRunning = vi.fn(() => false);
    interrupt = vi.fn(async () => {});
    cleanup = vi.fn(async () => {});
    getRawSessionId = vi.fn(() => null);
    getRecordedActions = vi.fn(() => []);
    setOutputCallback = vi.fn();
    getInstanceId = vi.fn(() => `agent-${Date.now()}`);
    getConnectionId = vi.fn(() => 'test-conn');
    getCurrentRole = vi.fn(() => null);
    getCurrentMessageId = vi.fn(() => null);
    steer = vi.fn(async () => false);
  }
  return {
    AgentSession: MockAgentSession,
    getAgentId: vi.fn(),
    getCurrentConnectionId: vi.fn(),
    getSessionId: vi.fn(),
    getMonitorId: vi.fn(),
    runWithAgentId: vi.fn(),
  };
});

// ── Test setup ─────────────────────────────────────────────────────────────

import { ContextPool } from '../agents/context-pool.js';
import type { SessionId } from '../session/types.js';

function createMockWindowState() {
  return {
    listWindows: () => [],
    clear: vi.fn(),
    getWindow: vi.fn(),
    setWindow: vi.fn(),
    removeWindow: vi.fn(),
    setAppProtocol: vi.fn(),
  };
}

function createMockReloadCache() {
  return {
    findMatches: () => [],
    record: () => {},
    clear: vi.fn(),
  };
}

describe('Multi-monitor lifecycle', () => {
  let pool: ContextPool;

  beforeEach(async () => {
    pool = new ContextPool(
      'test-session' as SessionId,
      createMockWindowState() as any,
      createMockReloadCache() as any,
    );
    // Initialize creates the default monitor-0 agent
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  it('createMonitorAgent creates a new agent for a monitor', async () => {
    expect(pool.hasMainAgent('monitor-0')).toBe(true);
    expect(pool.hasMainAgent('monitor-1')).toBe(false);

    const created = await pool.createMonitorAgent('monitor-1');

    expect(created).toBe(true);
    expect(pool.hasMainAgent('monitor-1')).toBe(true);
    expect(pool.getMainAgentCount()).toBe(2);
  });

  it('removeMonitorAgent cleans up the agent and queue', async () => {
    await pool.createMonitorAgent('monitor-1');
    expect(pool.hasMainAgent('monitor-1')).toBe(true);
    expect(pool.getMainAgentCount()).toBe(2);

    await pool.removeMonitorAgent('monitor-1');

    expect(pool.hasMainAgent('monitor-1')).toBe(false);
    expect(pool.getMainAgentCount()).toBe(1);
    // Only monitor-0 should remain
    expect(pool.hasMainAgent('monitor-0')).toBe(true);
  });

  it('multiple monitors can coexist independently', async () => {
    await pool.createMonitorAgent('monitor-1');

    expect(pool.hasMainAgent('monitor-0')).toBe(true);
    expect(pool.hasMainAgent('monitor-1')).toBe(true);
    expect(pool.getMainAgentCount()).toBe(2);

    // Removing monitor-0 should not affect monitor-1
    await pool.removeMonitorAgent('monitor-0');

    expect(pool.hasMainAgent('monitor-0')).toBe(false);
    expect(pool.hasMainAgent('monitor-1')).toBe(true);
    expect(pool.getMainAgentCount()).toBe(1);
  });

  it('hasMainAgent returns false after removal', async () => {
    await pool.createMonitorAgent('monitor-1');
    expect(pool.hasMainAgent('monitor-1')).toBe(true);

    await pool.removeMonitorAgent('monitor-1');
    expect(pool.hasMainAgent('monitor-1')).toBe(false);

    // Verify a never-created monitor also returns false
    expect(pool.hasMainAgent('monitor-99')).toBe(false);
  });
});
