/**
 * `fresh: true` on a window message — start the app agent over.
 *
 * An app agent is persistent per (monitor, app) and remembers every turn it has run
 * this session, which is what makes "now do the same for the other file" work. When the
 * next request has nothing to do with that history, the monitor agent passes
 * `fresh: true` and the task is answered by a new agent instead.
 *
 * What that has to mean, and what these tests pin:
 *
 *   1. the turn runs on a *different* agent instance, and the old one is gone
 *   2. without the flag nothing changes — the same agent answers, as before
 *   3. a `fresh` task never steers into the running turn it asked not to be answered
 *      from; it waits, and gets its new agent when it reaches the front
 *   4. two creations for one key never both land — the loser would be an agent in no
 *      collection, holding a provider and a limiter slot until the session ends
 *
 * (4) is not about `fresh` as such: parallel button actions already skip the processing
 * lock, so two tasks for one app can overlap inside `acquireProvider`. But `fresh`
 * empties the map on purpose and then asks for a replacement, so it turns a narrow
 * window into the ordinary path — which is why the reservation went in with it.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AITransport } from '../providers/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
// The set shared with multi-monitor.test.ts / monitor-identity.test.ts: enough to
// build a real ContextPool + AgentPool with no provider, logger, or disk. The real
// actionEmitter is used on purpose (see the note in multi-monitor.test.ts).

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
    dispose = mock(async () => {});
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

mock.module('../agents/limiter.js', () => ({
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

mock.module('../providers/environment.js', () => ({
  buildEnvironmentSection: mock(async () => ''),
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
  turnOptionsFor: mock(() => ({ model: undefined, allowedTools: [] })),
  CODEX_AGENT_ROLES: {},
  codexRoleToToml: mock(() => ''),
}));

/**
 * A session whose turn can be held open, so a second task really does arrive while
 * the first is still running — that is the whole subject of the steering tests.
 *
 * Two knobs, deliberately: `blockTurns` decides whether the *next* turn to start will
 * hold, and `held` collects the turns already holding. One variable doing both jobs
 * loses the running turn's resolver the moment a test stops blocking new ones, and the
 * suite hangs on a turn nothing can release.
 */
let blockTurns = false;
let held: (() => void)[] = [];

function releaseHeldTurns(): void {
  const resolvers = held;
  held = [];
  for (const resolve of resolvers) resolve();
}

mock.module('../agents/agent-session.js', () => {
  class MockAgentSession {
    private running = false;
    initialize = mock(async () => true);
    handleMessage = mock(async (_prompt: string, _opts: unknown) => {
      this.running = true;
      try {
        if (!blockTurns) return;
        await new Promise<void>((resolve) => held.push(resolve));
      } finally {
        this.running = false;
      }
    });
    isRunning = () => this.running;
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
    wasInterrupted = mock(() => false);
    steer = mock(async () => true);
    prewarm = mock(async () => {});
  }
  return {
    AgentSession: MockAgentSession,
    getAgentId: mock(() => undefined),
    getCurrentConnectionId: mock(() => undefined),
    getSessionId: mock(() => undefined),
    getMonitorId: mock(() => undefined),
    getWindowId: mock(() => undefined),
    runWithAgentId: mock((_id: string, fn: () => unknown) => fn()),
    runWithAgentContext: mock((_ctx: unknown, fn: () => unknown) => fn()),
  };
});

// ── Imports under test (after mocks) ───────────────────────────────────────

const { ContextPool } = await import('../agents/context-pool.js');

import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'test-session' as SessionId;
const MONITOR = '0';
const APP = 'notes';
/** The monitor-scoped handle WindowStateRegistry files the window under. */
const WINDOW = `${MONITOR}/${APP}`;

function createMockReloadCache() {
  return { findMatches: () => [], record: () => {}, clear: mock(() => {}) };
}

/** An app window — carries an appId, so its tasks route to the app agent. */
function appWindow(appId: string): OSAction {
  return {
    type: 'window.create',
    windowId: appId,
    title: appId,
    appId,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'iframe', data: '' },
  } as OSAction;
}

describe('a window message answered on a fresh app agent', () => {
  let pool: InstanceType<typeof ContextPool>;

  beforeEach(async () => {
    blockTurns = false;
    held = [];
    const windowState = new WindowStateRegistry();
    windowState.handleAction(appWindow(APP), MONITOR);

    pool = new ContextPool(
      SESSION,
      windowState as never,
      createMockReloadCache() as never,
      mock(() => {}),
    );
    await pool.initialize();
  });

  afterEach(async () => {
    blockTurns = false;
    releaseHeldTurns();
    await pool.cleanup();
  });

  function message(messageId: string, extra: { fresh?: boolean } = {}) {
    return pool.handleTask({
      requestedType: 'app',
      kind: 'user',
      messageId,
      windowId: WINDOW,
      monitorId: MONITOR,
      content: 'do the thing',
      ...extra,
    });
  }

  function currentAgentId(): string | undefined {
    return pool.agentPool.appAgents.get(MONITOR, APP)?.instanceId;
  }

  /**
   * The agent, once it is created and streaming.
   *
   * Not a fixed number of microtask ticks: `handleAppTask` awaits the window queue,
   * the provider, and the profile before the turn starts, and a test that guesses how
   * many awaits that is becomes a test about the call stack.
   */
  async function runningAgent(): Promise<{
    instanceId: string;
    session: { isRunning(): boolean; steer: unknown; interrupt: unknown };
  }> {
    for (let i = 0; i < 100; i++) {
      const agent = pool.agentPool.appAgents.get(MONITOR, APP);
      if (agent?.session.isRunning()) return agent as never;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('app agent never started a turn');
  }

  it('reuses the same agent when the flag is absent', async () => {
    await message('m1');
    const first = currentAgentId();
    await message('m2');

    expect(first).toBeDefined();
    expect(currentAgentId()).toBe(first!);
    expect(pool.agentPool.appAgents.size).toBe(1);
  });

  it('runs on a new agent, and retires the old one, when the flag is set', async () => {
    await message('m1');
    const first = pool.agentPool.appAgents.get(MONITOR, APP)!;

    await message('m2', { fresh: true });
    const second = pool.agentPool.appAgents.get(MONITOR, APP)!;

    expect(second.instanceId).not.toBe(first.instanceId);
    // The predecessor's provider is ended, which is where its memory of the session
    // lived — a `fresh` agent that shared the old provider would remember everything.
    expect(first.session.cleanup).toHaveBeenCalled();
    // Retired, not accumulated: one agent per (monitor, app) still.
    expect(pool.agentPool.appAgents.size).toBe(1);
  });

  it('leaves the app agent in place when there was none to begin with', async () => {
    // The first-ever message to an app carries no history to drop. `fresh` on it is
    // a no-op, not an error and not a wasted create-then-destroy.
    await message('m1', { fresh: true });

    expect(currentAgentId()).toBeDefined();
    expect(pool.agentPool.appAgents.size).toBe(1);
  });

  it('does not steer a fresh task into the turn it asked not to inherit', async () => {
    blockTurns = true;
    const first = message('m1');
    const incumbent = await runningAgent();

    // Arrives while the incumbent is mid-turn. Steering would inject it into that
    // turn — the exact memory it asked to be free of — and the mock steers happily.
    blockTurns = false; // the replacement's turn runs to completion
    const second = message('m2', { fresh: true });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(incumbent.session.steer).not.toHaveBeenCalled();

    // It waits its turn rather than interrupting: `fresh` says the *next* request
    // needs no history, not that the running one should be abandoned.
    expect(incumbent.session.interrupt).not.toHaveBeenCalled();

    releaseHeldTurns();
    await Promise.all([first, second]);

    expect(pool.agentPool.appAgents.get(MONITOR, APP)!.instanceId).not.toBe(incumbent.instanceId);
  });

  it('steers a plain task into the running turn, as before', async () => {
    blockTurns = true;
    const first = message('m1');
    const incumbent = await runningAgent();

    await message('m2');
    expect(incumbent.session.steer).toHaveBeenCalled();

    releaseHeldTurns();
    await first;
  });

  it('never lands two agents for one key when creations overlap', async () => {
    // Both calls find the map empty and both await `acquireProvider`. Without the
    // reservation the loser is set into `appAgents` and then overwritten — an agent
    // in no collection, invisible to every dispose path and to cleanup(), holding a
    // provider process and a limiter slot for the life of the session.
    const [a, b] = await Promise.all([
      pool.agentPool.appAgents.getOrCreate(MONITOR, APP),
      pool.agentPool.appAgents.getOrCreate(MONITOR, APP),
    ]);

    expect(a).not.toBeNull();
    expect(b!.instanceId).toBe(a!.instanceId);
    expect(pool.agentPool.appAgents.size).toBe(1);
    expect(pool.agentPool.listAgents().filter((e) => e.type === 'app').length).toBe(1);
  });

  it('disposes an agent whose creation is still in flight', async () => {
    // The dispose arrives while the create is inside `acquireProvider`, so the agent
    // is in no collection to be found. Settling the reservation first is what keeps
    // it from landing seconds after the thing that owns it stopped existing.
    const creating = pool.agentPool.appAgents.getOrCreate(MONITOR, APP);
    const disposing = pool.agentPool.appAgents.dispose(MONITOR, APP);

    await Promise.all([creating, disposing]);

    expect(pool.agentPool.appAgents.has(MONITOR, APP)).toBe(false);
    expect(pool.agentPool.appAgents.size).toBe(0);
    expect(pool.agentPool.listAgents().filter((e) => e.type === 'app').length).toBe(0);
  });
});
