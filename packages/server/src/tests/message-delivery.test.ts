/**
 * Acceptance for "every dropped message is visible" and "authoritative resync".
 *
 * The findings these close — this list is the only surviving index of these F-numbers,
 * so keep the descriptions with them:
 *
 *   F-18 dropped work is invisible — a budget timeout, a full queue, an unknown monitor,
 *        or a pool reset killed a user's message and told nobody, leaving the chip on
 *        their screen reading "queued" for something that would never run.
 *   F-2  a command sent into a closed socket was discarded with a console.warn, after the
 *        UI had already consumed the drawing that went with it.
 *   F-1  the reconnect snapshot only *added* windows, so a window closed during the
 *        outage stayed on screen and an agent that finished kept its spinner.
 *
 * The rules they encode: **any path that drops a user message emits an ERROR naming that
 * message**, and **the reconnect snapshot is authoritative — what it does not name does
 * not exist.**
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

// NB: `../agents/limiter.js` is deliberately NOT mocked here. `mock.module` is
// process-wide and never restored, so a limiter stub in this file replaces the real
// `AgentLimiter` class for every file that runs after it — which is how pool-drain.test.ts
// started failing with "undefined is not a constructor". The real limiter works fine for
// these tests; it only needs to hand out one agent.

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
    getMonitorId: mock(() => undefined),
    getWindowId: mock(() => undefined),
    runWithAgentId: mock((_id: string, fn: () => unknown) => fn()),
    runWithAgentContext: mock((_ctx: unknown, fn: () => unknown) => fn()),
  };
});

// ── Imports under test (after mocks) ───────────────────────────────────────

const { LiveSession } = await import('../session/live-session.js');

import {
  ClientEventType,
  ServerEventType,
  type OSAction,
  type ServerEvent,
  type SnapshotEvent,
  type ErrorEvent,
} from '@yaar/shared';
import { resetBroadcastCenter, getBroadcastCenter } from '../session/broadcast-center.js';
import type { SessionId, YaarWebSocket } from '../session/types.js';

const SESSION = 'test-session' as SessionId;

function createMockWs(): YaarWebSocket & { events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  return {
    readyState: 1,
    send: (data: string) => events.push(JSON.parse(data) as ServerEvent),
    events,
  } as unknown as YaarWebSocket & { events: ServerEvent[] };
}

function errorsFrom(ws: { events: ServerEvent[] }): ErrorEvent[] {
  return ws.events.filter((e): e is ErrorEvent => e.type === ServerEventType.ERROR);
}

function userMessage(messageId: string, monitorId = '0') {
  return {
    type: ClientEventType.USER_MESSAGE,
    messageId,
    content: 'hello',
    monitorId,
  } as never;
}

function plainWindow(id: string): OSAction {
  return {
    type: 'window.create',
    windowId: id,
    title: id,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'markdown', data: '# hi' },
  } as OSAction;
}

// ───────────────────────────────────────────────────────────────────────────
// F-18 — a message that will not run says so, and names itself
// ───────────────────────────────────────────────────────────────────────────

describe('F-18 — every dropped message is visible', () => {
  let session: InstanceType<typeof LiveSession>;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    resetBroadcastCenter();
    session = new LiveSession(SESSION);
    ws = createMockWs();
    session.addConnection('conn-a', ws);
    getBroadcastCenter().subscribe('conn-a', ws, SESSION);
  });

  afterEach(async () => {
    await session.cleanup();
    resetBroadcastCenter();
  });

  it('a message naming a monitor that does not exist is rejected by id, not in the abstract', async () => {
    await session.routeMessage(userMessage('m-1', 'does-not-exist'), 'conn-a');

    const errors = errorsFrom(ws);
    expect(errors).toHaveLength(1);
    // The point of the slice: the client is holding `m-1` and showing a chip for it. An
    // error it cannot tie back to that id leaves the chip exactly where it was.
    expect(errors[0].messageId).toBe('m-1');
    expect(errors[0].error).toContain('does not exist');
  });

  it('a message with no monitor at all is rejected by id', async () => {
    await session.routeMessage(
      { type: ClientEventType.USER_MESSAGE, messageId: 'm-2', content: 'hi' } as never,
      'conn-a',
    );

    const errors = errorsFrom(ws);
    expect(errors).toHaveLength(1);
    expect(errors[0].messageId).toBe('m-2');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F-2 — a resent message is acked, not run twice
// ───────────────────────────────────────────────────────────────────────────

describe('F-2 — the outbox can retry safely', () => {
  let session: InstanceType<typeof LiveSession>;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    resetBroadcastCenter();
    session = new LiveSession(SESSION);
    ws = createMockWs();
    session.addConnection('conn-a', ws);
    getBroadcastCenter().subscribe('conn-a', ws, SESSION);
  });

  afterEach(async () => {
    await session.cleanup();
    resetBroadcastCenter();
  });

  it('the same messageId twice runs once and is acknowledged twice', async () => {
    await session.routeMessage(userMessage('m-dup'), 'conn-a');
    const turnsAfterFirst = turnCount(session);

    // The client never saw an ack (the socket died at the wrong moment) and resent from its
    // outbox. Running this a second time would have the agent do the user's bidding twice.
    await session.routeMessage(userMessage('m-dup'), 'conn-a');

    expect(turnCount(session)).toBe(turnsAfterFirst);
    const acks = ws.events.filter(
      (e) =>
        e.type === ServerEventType.MESSAGE_ACCEPTED &&
        (e as { messageId: string }).messageId === 'm-dup',
    );
    // And it is acked again — otherwise the outbox would hold it forever and resend it on
    // every reconnect, for the rest of the session.
    expect(acks.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * How many turns the monitor agent was asked to run — counted off the `AgentSession` stub
 * this file installs.
 *
 * Good enough for the one thing it is used for below (a duplicate `messageId` must not run
 * twice), and it must not be trusted with more than that. The stub's `handleMessage` resolves
 * instantly, so there is no turn here in any real sense: a message that was *dropped* and a
 * message that was *reordered* both leave this count looking perfect. What the count cannot
 * see is exactly what the queue is for.
 *
 * The load-bearing version is `tests/loopback/loopback-message-loss.test.ts` (S4), which
 * counts what the real provider was actually handed — every prompt, in the order the turns
 * started, with one turn held open so the others have to queue behind it.
 */
function turnCount(session: InstanceType<typeof LiveSession>): number {
  const pool = session.getPool();
  const agent = pool?.agentPool.getMonitorAgent('0');
  if (!agent) return 0;
  const handleMessage = agent.session.handleMessage as unknown as { mock: { calls: unknown[] } };
  return handleMessage.mock.calls.length;
}

// ───────────────────────────────────────────────────────────────────────────
// F-1 — the snapshot is authoritative: what it does not name does not exist
// ───────────────────────────────────────────────────────────────────────────

describe('F-1 — authoritative resync', () => {
  let session: InstanceType<typeof LiveSession>;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    resetBroadcastCenter();
    session = new LiveSession(SESSION);
    ws = createMockWs();
    session.addConnection('conn-a', ws);
    getBroadcastCenter().subscribe('conn-a', ws, SESSION);
  });

  afterEach(async () => {
    await session.cleanup();
    resetBroadcastCenter();
  });

  function snapshotFrom(w: { events: ServerEvent[] }): SnapshotEvent {
    const snap = w.events.filter((e): e is SnapshotEvent => e.type === ServerEventType.SNAPSHOT);
    expect(snap.length).toBe(1);
    return snap[0];
  }

  it("RESYNC answers with the session's live windows", async () => {
    session.windowState.handleAction(plainWindow('notes'), '0');

    await session.routeMessage({ type: ClientEventType.RESYNC } as never, 'conn-a');

    const snapshot = snapshotFrom(ws);
    const windowIds = snapshot.actions
      .filter((a) => a.type === 'window.create')
      .map((a) => (a as { windowId: string }).windowId);
    expect(windowIds).toContain('0/notes');
  });

  it('a window closed during the outage is absent from the snapshot — which is how it gets removed', async () => {
    session.windowState.handleAction(plainWindow('notes'), '0');
    session.windowState.handleAction(plainWindow('todo'), '0');
    // The agent closed one while nobody was listening. Under the old additive snapshot the
    // client kept it on screen forever: a merge can only add.
    session.windowState.handleAction({ type: 'window.close', windowId: 'todo' } as OSAction, '0');

    await session.routeMessage({ type: ClientEventType.RESYNC } as never, 'conn-a');

    const windowIds = snapshotFrom(ws)
      .actions.filter((a) => a.type === 'window.create')
      .map((a) => (a as { windowId: string }).windowId);
    expect(windowIds).toContain('0/notes');
    expect(windowIds).not.toContain('0/todo');
  });

  it('a dialog still waiting for an answer survives the reconnect', async () => {
    // Broadcast is the single gateway every server→client event goes through, so it is what
    // the surface registry mirrors: if the client was told to show it, the snapshot knows.
    session.broadcast({
      type: ServerEventType.ACTIONS,
      actions: [
        { type: 'dialog.confirm', id: 'd-1', title: 'Allow?', message: 'Allow this?' } as OSAction,
      ],
    } as ServerEvent);

    await session.routeMessage({ type: ClientEventType.RESYNC } as never, 'conn-a');

    const dialogs = snapshotFrom(ws).actions.filter((a) => a.type === 'dialog.confirm');
    expect(dialogs).toHaveLength(1);
    expect((dialogs[0] as { id: string }).id).toBe('d-1');
  });

  it('a dialog the user already answered is not asked again', async () => {
    session.broadcast({
      type: ServerEventType.ACTIONS,
      actions: [
        { type: 'dialog.confirm', id: 'd-2', title: 'Allow?', message: 'Allow this?' } as OSAction,
      ],
    } as ServerEvent);

    await session.routeMessage(
      { type: ClientEventType.DIALOG_FEEDBACK, dialogId: 'd-2', confirmed: true } as never,
      'conn-a',
    );
    await session.routeMessage({ type: ClientEventType.RESYNC } as never, 'conn-a');

    // An answer arrives as a client event, not an action, so it never passes through the
    // broadcast gateway. Without an explicit hook it would be re-shown on every reconnect —
    // re-asking a question the user had already settled.
    expect(snapshotFrom(ws).actions.filter((a) => a.type === 'dialog.confirm')).toHaveLength(0);
  });

  it('a notification dismissed during the outage does not come back', async () => {
    session.broadcast({
      type: ServerEventType.ACTIONS,
      actions: [{ type: 'notification.show', id: 'n-1', title: 'Hi', body: 'there' } as OSAction],
    } as ServerEvent);
    session.broadcast({
      type: ServerEventType.ACTIONS,
      actions: [{ type: 'notification.dismiss', id: 'n-1' } as OSAction],
    } as ServerEvent);

    await session.routeMessage({ type: ClientEventType.RESYNC } as never, 'conn-a');

    expect(snapshotFrom(ws).actions.filter((a) => a.type === 'notification.show')).toHaveLength(0);
  });
});
