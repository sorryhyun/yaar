/**
 * Acceptance for "monitor is derived, never defaulted".
 *
 * Written red, against the specified behavior rather than the behavior that existed;
 * now green. Each one names the finding it closes — this list is the only surviving
 * index of these F-numbers, so keep the descriptions with them:
 *
 *   F-7  monitor subscriptions accumulate instead of switching
 *   F-10 routing semantics flip on the first subscription
 *   F-11 window-scoped events carry no monitorId, so a click on monitor 1 runs on monitor 0
 *   F-12 four disagreeing monitor fallbacks
 *   F-13 activeMonitorId is session-global and last-writer-wins
 *   F-14 the monitor list is client-local
 *
 * The rule they encode: **for window-scoped events the monitor comes from the
 * window; for user-scoped events it comes from the connection. There is no fallback.**
 * A task or action that cannot resolve a monitor is a bug, and must throw rather
 * than guess.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AITransport } from '../providers/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Same set as multi-monitor.test.ts: enough to build a ContextPool and a
// LiveSession without a provider, a logger, or a disk. The real actionEmitter is
// used on purpose (see the note in multi-monitor.test.ts — stubbing it leaks
// process-wide and breaks LiveSession construction in whatever file runs next).

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
    getMonitorId: mock(() => undefined),
    getWindowId: mock(() => undefined),
    runWithAgentId: mock((_id: string, fn: () => unknown) => fn()),
    runWithAgentContext: mock((_ctx: unknown, fn: () => unknown) => fn()),
  };
});

// ── Imports under test (after mocks) ───────────────────────────────────────

const { ContextPool } = await import('../agents/context-pool.js');
const { LiveSession } = await import('../session/live-session.js');

import {
  ClientEventType,
  ServerEventType,
  type MonitorInfo,
  type OSAction,
  type ServerEvent,
} from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import {
  BroadcastCenter,
  getBroadcastCenter,
  resetBroadcastCenter,
} from '../session/broadcast-center.js';
import type { SessionId, YaarWebSocket } from '../session/types.js';

const SESSION = 'test-session' as SessionId;
const EVENT: ServerEvent = { type: ServerEventType.ERROR, error: 'ping' } as ServerEvent;

function createMockWs(): YaarWebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: 1,
    send: (data: string) => sent.push(data),
    sent,
  } as unknown as YaarWebSocket & { sent: string[] };
}

function createMockReloadCache() {
  return { findMatches: () => [], record: () => {}, clear: mock(() => {}) };
}

/** A plain (non-app) window — no appId, so it routes to the monitor agent. */
function plainWindow(id: string): OSAction {
  return {
    type: 'window.create',
    windowId: id,
    title: id,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'markdown', data: '# hi' },
  } as OSAction;
}

/** The session's authoritative monitor list (F-14). */
function monitorsOf(session: InstanceType<typeof LiveSession>): MonitorInfo[] {
  return session.getMonitors();
}

/** The (prompt, options) pairs a monitor's agent was actually asked to run. */
function turnsOn(
  pool: InstanceType<typeof ContextPool>,
  monitorId: string,
): { prompt: string; opts: { monitorId?: string } }[] {
  const agent = pool.agentPool.getMonitorAgent(monitorId);
  if (!agent) return [];
  const handleMessage = agent.session.handleMessage as unknown as {
    mock: { calls: [string, { monitorId?: string }][] };
  };
  return handleMessage.mock.calls.map(([prompt, opts]) => ({ prompt, opts }));
}

// ───────────────────────────────────────────────────────────────────────────
// F-10 / F-7 — a subscription means exactly one monitor, and it can be left
// ───────────────────────────────────────────────────────────────────────────

describe('F-10 — a connection receives only what it subscribed to', () => {
  let bc: BroadcastCenter;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    bc = new BroadcastCenter();
    ws = createMockWs();
    bc.subscribe('conn-a', ws, SESSION);
  });

  it('delivers nothing for a monitor the connection never subscribed to', () => {
    // Today: an empty subscription set means "send everything" (broadcast-center.ts:116),
    // so a connection that has not yet subscribed receives every monitor's events —
    // and then silently changes routing mode the instant its first SUBSCRIBE_MONITOR
    // lands. There is no state in which "no subscription" is a meaningful answer to
    // "which monitor is this connection looking at?"; it is a connection with no
    // monitor, and a monitor-scoped event has no business reaching it.
    expect(bc.publishToMonitor(SESSION, '7', EVENT)).toBe(0);
    expect(ws.sent).toEqual([]);
  });

  it('delivers to the monitor the connection did subscribe to', () => {
    bc.subscribeToMonitor('conn-a', '1');

    expect(bc.publishToMonitor(SESSION, '1', EVENT)).toBe(1);
    expect(bc.publishToMonitor(SESSION, '0', EVENT)).toBe(0);
  });
});

describe('F-7 — subscribing to a monitor replaces the previous one', () => {
  let bc: BroadcastCenter;

  beforeEach(() => {
    bc = new BroadcastCenter();
    bc.subscribe('conn-a', createMockWs(), SESSION);
  });

  it('a connection that moves to monitor 1 stops receiving monitor 0', () => {
    // A connection looks at one monitor at a time. subscribeToMonitor() only ever
    // .add()s (broadcast-center.ts:47-55) and nothing anywhere removes — so a tab
    // that switches monitors keeps receiving the old one's events forever, and the
    // frontend applies them unfiltered.
    bc.subscribeToMonitor('conn-a', '0');
    bc.subscribeToMonitor('conn-a', '1');

    expect(bc.publishToMonitor(SESSION, '1', EVENT)).toBe(1);
    expect(bc.publishToMonitor(SESSION, '0', EVENT)).toBe(0);
  });

  it('two tabs on different monitors do not receive each other’s events', () => {
    // Guard: this already holds today, and must survive the rewrite.
    const wsB = createMockWs();
    bc.subscribe('conn-b', wsB, SESSION);
    bc.subscribeToMonitor('conn-a', '0');
    bc.subscribeToMonitor('conn-b', '1');

    expect(bc.publishToMonitor(SESSION, '1', EVENT)).toBe(1);
    expect(wsB.sent.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F-11 — a window event runs on the window's own monitor
// ───────────────────────────────────────────────────────────────────────────

describe('F-11 — a window-scoped task derives its monitor from the window', () => {
  let pool: InstanceType<typeof ContextPool>;
  let windowState: WindowStateRegistry;

  beforeEach(async () => {
    windowState = new WindowStateRegistry();
    // A plain window living on monitor 1 — key "1/notes".
    windowState.handleAction(plainWindow('notes'), '1');

    pool = new ContextPool(
      SESSION,
      windowState as never,
      createMockReloadCache() as never,
      mock(() => {}),
    );
    await pool.initialize(); // creates monitor 0's agent
    await pool.createMonitorAgent('1');
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  it('runs a click in a plain window on monitor 1 on monitor 1’s agent', async () => {
    // The client's COMPONENT_ACTION / WINDOW_MESSAGE carry no monitorId (events.ts:105-151),
    // and handleTask re-types a plain window task to 'monitor' without deriving the
    // monitor from the window (context-pool.ts:447). It then falls to `?? '0'`
    // (monitor-task-processor.ts:24). So clicking a button in a window on monitor 1
    // runs on monitor 0's agent, streams into monitor 0's CLI, and any window it opens
    // lands on monitor 0. The window registry has known the answer the whole time:
    // getMonitorForWindow('1/notes') === '1'. AppTaskProcessor already asks it
    // (app-task-processor.ts:36); the plain-window path never does.
    await pool.handleTask({
      type: 'app',
      messageId: 'click-1',
      windowId: '1/notes',
      content: '<ui:click>button "Save" in window "notes"</ui:click>',
    });

    expect(turnsOn(pool, '0')).toEqual([]);

    const onOne = turnsOn(pool, '1');
    expect(onOne.length).toBe(1);
    expect(onOne[0].opts.monitorId).toBe('1');
  });

  it('runs a window message in a plain window on monitor 1 on monitor 1’s agent', async () => {
    await pool.handleTask({
      type: 'app',
      messageId: 'msg-1',
      windowId: '1/notes',
      content: 'summarize this',
    });

    expect(turnsOn(pool, '0')).toEqual([]);
    expect(turnsOn(pool, '1').length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F-12 — nothing guesses a monitor
// ───────────────────────────────────────────────────────────────────────────

describe('F-12 — a monitor that cannot be resolved is an error, not a default', () => {
  let pool: InstanceType<typeof ContextPool>;

  beforeEach(async () => {
    pool = new ContextPool(
      SESSION,
      new WindowStateRegistry() as never,
      createMockReloadCache() as never,
      mock(() => {}),
    );
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  it('rejects a monitor task that names no monitor', async () => {
    // `?? '0'` (monitor-task-processor.ts:24) turns "I don't know" into "monitor 0".
    // A user-scoped task's monitor comes from the connection and is always present;
    // one that arrives without it is a bug upstream, and must say so.
    await expect(
      pool.handleTask({ type: 'monitor', messageId: 'm1', content: 'hello' }),
    ).rejects.toThrow(/monitor/i);
  });

  it('rejects a window task whose window is not registered', async () => {
    // No window → no monitor to derive. Today this silently lands on monitor 0.
    await expect(
      pool.handleTask({ type: 'app', messageId: 'm2', windowId: 'ghost', content: 'hello' }),
    ).rejects.toThrow(/monitor|window/i);
  });

  it('rejects a session task that names no monitor', async () => {
    // context-pool.ts:355 — the third `?? '0'`.
    await expect(
      pool.handleSessionTask({ type: 'session', messageId: 'm3', content: 'hello' }),
    ).rejects.toThrow(/monitor/i);
  });

  it('reports the session agent’s monitor for the turn it is running', async () => {
    // findMonitorForAgent() looks in monitorAgents and appAgents (agent-pool.ts:441)
    // — the session agent is in neither, so it returns undefined, and every downstream
    // `getMonitorId() ?? '0'` (e.g. handlers/window.ts:184) puts its windows on monitor 0.
    // Meanwhile the emitter stamps the outbound ACTIONS event with activeMonitorId. The
    // window is registered on one monitor and its event delivered to another — one turn,
    // two answers. The session agent runs on a monitor like everyone else; say which.
    await pool.createMonitorAgent('1');
    await pool.handleSessionTask({
      type: 'session',
      messageId: 's1',
      content: 'look at this',
      monitorId: '1',
    });

    const agent = await pool.getOrCreateSessionAgent();
    expect(agent).not.toBeNull();
    expect(pool.agentPool.getRoleForAgent(agent!.instanceId)).toBe('session'); // known agent…
    expect(pool.agentPool.findMonitorForAgent(agent!.instanceId)).toBe('1'); // …on a known monitor
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F-13 — there is no session-global "current monitor"
// ───────────────────────────────────────────────────────────────────────────

describe('F-13 — a session has no active monitor; a connection does', () => {
  let session: InstanceType<typeof LiveSession>;

  beforeEach(() => {
    resetBroadcastCenter();
    session = new LiveSession(SESSION);
  });

  afterEach(async () => {
    await session.cleanup();
    resetBroadcastCenter();
  });

  it('does not collapse two tabs onto one monitor', async () => {
    // LiveSession.activeMonitorId (live-session.ts:108,719) is one field per session,
    // overwritten by whichever connection last sent SUBSCRIBE_MONITOR. With two tabs on
    // different monitors, tab B's subscribe retargets every monitor-less action of tab A's.
    // The fix is not a better fallback — it is that the field is a category error and goes.
    const bc = getBroadcastCenter();
    bc.subscribe('conn-a', createMockWs(), SESSION);
    bc.subscribe('conn-b', createMockWs(), SESSION);

    await session.routeMessage(
      { type: ClientEventType.SUBSCRIBE_MONITOR, monitorId: '0' } as never,
      'conn-a',
    );
    await session.routeMessage(
      { type: ClientEventType.SUBSCRIBE_MONITOR, monitorId: '1' } as never,
      'conn-b',
    );

    expect((session as unknown as { activeMonitorId?: string }).activeMonitorId).toBeUndefined();

    // Each tab still gets its own monitor's events — the routing that mattered.
    expect(bc.publishToMonitor(SESSION, '0', EVENT)).toBe(1);
    expect(bc.publishToMonitor(SESSION, '1', EVENT)).toBe(1);
  });

  // The matching emitter assertion — that a window action emitted with no monitor in
  // context throws rather than guessing — lives in
  // packages/tests/src/integration/monitor-routing.test.ts. It cannot run here:
  // uri-resolve.test.ts stubs `agents/agent-context.js` with `getMonitorId: () => '0'`,
  // and Bun's mock.module is process-wide and never restored, so every file that runs
  // after it is told there is a monitor in context. "No monitor" is not expressible in
  // this process.

  it('stops delivering a monitor’s events once it is removed', async () => {
    // REMOVE_MONITOR (live-session.ts:725) removed the agent and nothing else — the
    // connection stayed subscribed in the BroadcastCenter, so a deleted monitor kept
    // delivering, and the frontend re-created its windows from events it should never
    // have received.
    const bc = getBroadcastCenter();
    bc.subscribe('conn-a', createMockWs(), SESSION);

    // The monitor has to be asked for: the session mints it, so a monitor nobody
    // created is not one this session can deliver to — or delete.
    await session.routeMessage({ type: ClientEventType.ADD_MONITOR } as never, 'conn-a');
    await session.routeMessage(
      { type: ClientEventType.SUBSCRIBE_MONITOR, monitorId: '1' } as never,
      'conn-a',
    );
    await session.routeMessage(
      { type: ClientEventType.REMOVE_MONITOR, monitorId: '1' } as never,
      'conn-a',
    );

    expect(bc.publishToMonitor(SESSION, '1', EVENT)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F-14 — the monitor list is server state
// ───────────────────────────────────────────────────────────────────────────

describe('F-14 — monitors belong to the session, not to a tab', () => {
  let session: InstanceType<typeof LiveSession>;

  beforeEach(() => {
    resetBroadcastCenter();
    session = new LiveSession(SESSION);
  });

  afterEach(async () => {
    await session.cleanup();
    resetBroadcastCenter();
  });

  it('starts with the default monitor', () => {
    expect(monitorsOf(session)).toEqual([{ id: '0', label: 'Monitor 1' }]);
  });

  it('a monitor created by one tab is visible to the session, and broadcast to the other', async () => {
    // Two tabs each minted monitor "1" from their own counter, collided on the same
    // server-side agent, and neither saw the other's monitors. A reconnecting tab got
    // snapshot windows on monitors it had no entry for and WindowManager could not
    // render them. So the session mints the id, and tells every tab.
    const bc = getBroadcastCenter();
    const wsB = createMockWs();
    bc.subscribe('conn-a', createMockWs(), SESSION);
    bc.subscribe('conn-b', wsB, SESSION);

    await session.routeMessage({ type: ClientEventType.ADD_MONITOR } as never, 'conn-a');

    expect(monitorsOf(session)).toEqual([
      { id: '0', label: 'Monitor 1' },
      { id: '1', label: 'Monitor 2' },
    ]);

    // Tab B learns about monitor 1 without having asked — and is not dragged onto it.
    const monitorEvents = wsB.sent
      .map(
        (raw) => JSON.parse(raw) as { type: string; monitors?: { id: string }[]; focus?: string },
      )
      .filter((e) => e.type === 'MONITORS');
    expect(monitorEvents.at(-1)?.monitors?.map((m) => m.id)).toEqual(['0', '1']);
    expect(monitorEvents.at(-1)?.focus).toBeUndefined();
  });
});
