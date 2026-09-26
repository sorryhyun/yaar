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
import { installMockAgentSession } from './helpers/mock-agent-session.js';
import { createTestPoolHost } from './helpers/test-pool-host.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
// The set shared with multi-monitor.test.ts / monitor-identity.test.ts: enough to
// build a real ContextPool + AgentPool with no provider, logger, or disk. The real
// actionEmitter is used on purpose (see the note in multi-monitor.test.ts).

function createMockProvider(): AITransport {
  return {
    name: 'mock',
    providerType: 'claude',
    dispose: mock(async () => {}),
    isAvailable: async () => true,
    query: mock(() => {}),
    interrupt: mock(() => {}),
  } as unknown as AITransport;
}

mock.module('../providers/factory.js', () => ({
  getAvailableProviders: mock(async () => []),
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

mock.module('../agents/environment.js', () => ({
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
  REMOTE_MESSAGE_CONTEXT: '',
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

// A depth, not a boolean: a parallel (`actionId`) turn can overlap a held main turn,
// and the first one to finish must not make the other read as stopped.
let runningTurns = 0;

installMockAgentSession({
  handleMessage: async (_prompt: string, _opts: unknown) => {
    runningTurns++;
    try {
      if (!blockTurns) return;
      await new Promise<void>((resolve) => held.push(resolve));
    } finally {
      runningTurns--;
    }
  },
  isRunning: () => runningTurns > 0,
  steer: async () => true,
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

    pool = new ContextPool({
      sessionId: SESSION,
      host: createTestPoolHost(),
      windowState: windowState as never,
      reloadCache: createMockReloadCache() as never,
      broadcast: mock(() => {}),
    });
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
    session: { isRunning(): boolean; steer: unknown; interrupt: unknown; handleMessage: unknown };
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

    // No wait needed to prove this: `handleAppTask`'s `!task.fresh && (await …steer(...))`
    // short-circuits on `task.fresh`, so the steer call is never *evaluated* for this
    // task — not a race the code could lose under load, a branch it cannot reach. That
    // holds whenever `second`'s dispatch runs, however long queuing takes it to get
    // there, which is exactly what letting it run all the way out below (via
    // `Promise.all`) exercises.
    expect(incumbent.session.steer).not.toHaveBeenCalled();

    // It waits its turn rather than interrupting: `fresh` says the *next* request
    // needs no history, not that the running one should be abandoned. (Same
    // guarantee — `releaseAgent` for a fresh task never calls `session.interrupt()`;
    // that only happens on window close, which this test never triggers.)
    expect(incumbent.session.interrupt).not.toHaveBeenCalled();

    releaseHeldTurns();
    await Promise.all([first, second]);

    // Re-assert now that both turns have fully run: still true after the fresh task
    // actually queued, waited, and got its replacement agent — not just true before
    // any of that had a chance to happen.
    expect(incumbent.session.steer).not.toHaveBeenCalled();
    expect(incumbent.session.interrupt).not.toHaveBeenCalled();

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

  it('keeps the app busy when a parallel action finishes under a running turn', async () => {
    // A parallel (`actionId`) task skips the processing flag on the way in, so it must
    // leave it alone on the way out. When it cleared the flag unconditionally, a button
    // click finishing mid-turn marked the app idle, and the next message started a second
    // main turn on the same agent instead of steering into the one still running.
    blockTurns = true;
    const first = message('m1');
    const incumbent = await runningAgent();

    blockTurns = false;
    await pool.handleTask({
      requestedType: 'app',
      kind: 'user',
      messageId: 'click',
      windowId: WINDOW,
      monitorId: MONITOR,
      actionId: 'a1',
      content: 'clicked',
    });
    const handleMessage = incumbent.session.handleMessage as unknown as {
      mock: { calls: unknown[] };
    };
    expect(handleMessage.mock.calls.length).toBe(2);

    await message('m2');
    expect(incumbent.session.steer).toHaveBeenCalled();
    // Steered, not run: no third turn started on the agent.
    expect(handleMessage.mock.calls.length).toBe(2);

    releaseHeldTurns();
    await first;
  });

  it('keeps the app busy after a stop, until the stopped turn has unwound', async () => {
    // "Stop all" drops the queues. It used to drop the processing flags with them, so an
    // app whose turn was still unwinding read as idle, and the next message started a
    // second main turn on the agent that turn was still standing on.
    blockTurns = true;
    const first = message('m1');
    await runningAgent();

    await pool.interruptAll();
    expect(pool.hasActiveAppAgentTurn(WINDOW)).toBe(true);

    releaseHeldTurns();
    await first;
    expect(pool.hasActiveAppAgentTurn(WINDOW)).toBe(false);
  });

  it('never lands two agents for one key when creations overlap', async () => {
    // Both calls find the map empty and both await `acquireProvider`. Without the
    // reservation the loser is set into `appAgents` and then overwritten — an agent
    // in no collection, invisible to every dispose path and to cleanup(), holding a
    // provider process and a limiter slot for the life of the session.
    //
    // The overlap here is forced, not hoped for: `getOrCreate` runs synchronously up
    // to its first real `await` (inside `createAgentCore`, past `acquireWarmProvider`),
    // and `SpawnReservations.reserve` writes the reservation into `inFlight`
    // synchronously too — before `create()`'s own first await, per its rule 1
    // ("Reserved before the first await"). So the *first* array element below runs to
    // that reservation write, synchronously, before the JS engine ever constructs the
    // *second* call — there is no tick in which both calls could see an empty
    // reservation map. The second call is therefore guaranteed to find the first's
    // reservation already in place and join it, deterministically, every run.
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
