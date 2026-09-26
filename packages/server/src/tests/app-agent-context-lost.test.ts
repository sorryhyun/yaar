/**
 * What a replacement app agent is told about the one it replaced.
 *
 * An app agent is persistent per (monitor, app) and its memory is the provider session
 * it runs on. Three things end that session without the app tier asking: the idle
 * reaper, a `delete` on `yaar://agents/{appId}`, and a monitor going away. The first is
 * the one that bites, because it fires on a schedule nobody watched — a phone whose
 * browser tab went to the background for the TTL comes back to an app agent that was
 * reclaimed behind it.
 *
 * The successor was told nothing. It ran the user's next sentence believing it was the
 * same agent that had answered the last one, so work that had already landed was done
 * again: the reported case is three clone projects of one app, each made by an agent
 * that could not see the previous two (issue #109). Worse, the *handoff fingerprints*
 * outlived the agent that made them, so the successor was also handed
 * `<app_state_since_handoff changed="false" />` — an explicit claim of continuity with
 * a turn it had never run.
 *
 * Pinned here: a reclamation nobody asked for announces itself once, in front of the
 * successor's first turn; a reclamation the app tier *did* ask for (`fresh:true`, last
 * window closed) does not, because its caller already knows; and either way the
 * fingerprints die with the agent.
 *
 * The mock set is the one shared with `app-agent-fresh.test.ts` — enough to build a real
 * ContextPool + AgentPool with no provider, logger, or disk — plus a capture of every
 * prompt a turn is started with, which is the whole observable here.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AITransport } from '../providers/types.js';
import { APP_AGENT_IDLE_MS } from '../config.js';
import { installMockAgentSession } from './helpers/mock-agent-session.js';
import { createTestPoolHost } from './helpers/test-pool-host.js';

/** Every prompt handed to a turn, in order. Reset per test. */
let prompts: string[] = [];

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
  buildAppAgentProfile: mock(() => ({
    id: 'app',
    systemPrompt: '',
    allowedTools: [],
    // The app declares state, so the handoff notice is on the table — which is what
    // makes "the fingerprints went with the agent" an observable fact below.
    appStateKeys: ['selection'],
  })),
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

let turnRunning = false;

installMockAgentSession({
  handleMessage: async (prompt: string, _opts: unknown) => {
    prompts.push(prompt);
    turnRunning = true;
    try {
      if (!blockTurns) return;
      await new Promise<void>((resolve) => held.push(resolve));
    } finally {
      turnRunning = false;
    }
  },
  isRunning: () => turnRunning,
  steer: async () => true,
});

/**
 * The declared state a handoff fingerprint is taken of.
 *
 * Spread over the real module rather than replacing it: `handlers/window.ts` and both
 * MCP app doors import six other names from here, and a stub that omitted them would
 * fail at load rather than at the assertion. Only the capture is substituted, because
 * the real one asks a live iframe and there is none.
 */
const realAppProtocol = await import('../features/window/app-protocol.js');
mock.module('../features/window/app-protocol.js', () => ({
  ...realAppProtocol,
  captureDeclaredAppState: mock(async () => ({ selection: 'A1' })),
}));

// ── Imports under test (after mocks) ───────────────────────────────────────

const { ContextPool } = await import('../agents/context-pool.js');

import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'test-session' as SessionId;
const MONITOR = '0';
const APP = 'devtools';
const WINDOW = `${MONITOR}/${APP}`;

const LOST = '<prior_agent_context_lost';

function createMockReloadCache() {
  return { findMatches: () => [], record: () => {}, clear: mock(() => {}) };
}

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

/** Reach the private sweep — the interval that drives it is wall-clock. */
const sweep = (pool: { agentPool: { appAgents: unknown } }) =>
  (pool.agentPool.appAgents as { reapIdle: () => Promise<void> }).reapIdle();

describe('an app agent that replaces a reclaimed one', () => {
  let pool: InstanceType<typeof ContextPool>;

  beforeEach(async () => {
    blockTurns = false;
    held = [];
    prompts = [];
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
      content: 'carry on where we left off',
      ...extra,
    });
  }

  /** Age the app agent past the TTL and run the sweep. */
  async function reapIdle() {
    const agent = pool.agentPool.appAgents.get(MONITOR, APP)!;
    agent.lastUsed = Date.now() - (APP_AGENT_IDLE_MS + 1);
    await sweep(pool);
  }

  it('says so, once, in front of the first turn after an idle reap', async () => {
    await message('m1');
    expect(prompts[0]).not.toContain(LOST);

    await reapIdle();
    expect(pool.agentPool.appAgents.has(MONITOR, APP)).toBe(false);

    await message('m2');
    const notice = prompts[1];
    expect(notice).toContain('<prior_agent_context_lost reason="idle">');
    // The instruction is the point: an agent that believes it is starting clean
    // re-does work that already landed.
    expect(notice).toContain('do not assume a clean slate');
    // It frames the turn rather than trailing it.
    expect(notice.indexOf(LOST)).toBeLessThan(notice.indexOf('carry on where we left off'));

    // Told once. The successor now remembers being told.
    await message('m3');
    expect(prompts[2]).not.toContain(LOST);
  });

  it('does not claim a handoff the successor never made', async () => {
    // A second turn on the *same* agent does get the notice: the first turn's teardown
    // fingerprinted the app's declared state, and this agent is the one that made it.
    await message('m1');
    await message('m2');
    expect(prompts[1]).toContain('<app_state_since_handoff');

    // Reclaimed, the fingerprints go with it. Left behind they would answer the
    // successor's notice `changed="false"` — an explicit claim of continuity with a
    // turn it never ran.
    await reapIdle();
    await message('m3');
    expect(prompts[2]).toContain(LOST);
    expect(prompts[2]).not.toContain('<app_state_since_handoff');
  });

  it('stays quiet when the app tier asked for the reset', async () => {
    // `fresh: true` — the caller chose this, and telling it its own memory is gone is
    // noise in front of every deliberately-clean turn.
    await message('m1');
    await message('m2', { fresh: true });

    expect(prompts[1]).not.toContain(LOST);
  });

  it('stays quiet across an ordinary reused turn', async () => {
    await message('m1');
    await message('m2');

    expect(prompts.every((p) => !p.includes(LOST))).toBe(true);
    expect(pool.agentPool.appAgents.size).toBe(1);
  });
});
