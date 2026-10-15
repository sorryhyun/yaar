/**
 * Where work coming out of a devtools preview window goes (issue #182, gap 10).
 *
 * A preview runs a test build under `preview--{projectId}`. Its `sendInteraction(...,
 * { toMonitor: true })` reached the monitor agent as real work: the client sends every
 * toMonitor wake as a USER_MESSAGE, and a preview's window task fell through to the
 * plain-window branch, which is the monitor too. Now:
 *
 * - The client names the window a toMonitor wake came out of (`sourceWindowId`), and the
 *   controller sends a preview's down the window-task path instead of the monitor's.
 * - That path hands it to devtools' app agent, on devtools' own window, labelled as
 *   preview traffic — or, with no devtools window on the monitor, leaves it on the
 *   monitor's timeline without starting a turn.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AITransport } from '../providers/types.js';
import { installMockAgentSession } from './helpers/mock-agent-session.js';
import { createTestPoolHost } from './helpers/test-pool-host.js';

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

mock.module('../agents/limiter.js', () => ({
  getAgentLimiter: () => ({
    tryAcquire: () => true,
    release: mock(() => {}),
  }),
  resetAgentLimiter: mock(() => {}),
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

/** Every turn any agent ran: its prompt, and the app it ran for (none for the monitor). */
const turns: { prompt: string; appId?: string; windowId?: string }[] = [];

installMockAgentSession({
  handleMessage: async (prompt, opts) => {
    const { appId, windowId } = opts as { appId?: string; windowId?: string };
    turns.push({ prompt, appId, windowId });
  },
});

const { ContextPool } = await import('../agents/context-pool.js');
const { ClientEventController } = await import('../session/client-event-controller.js');

import {
  ClientEventType,
  NO_AGENT_ACK,
  ServerEventType,
  type OSAction,
  type ServerEvent,
} from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';
import type { ConnectionId } from '../session/broadcast-center.js';
import type { Task } from '../agents/pool-types.js';

const MONITOR = '0';
const PREVIEW_APP = 'preview--1792043502306';
const PREVIEW_RAW = 'devtools-preview-1792043502306';
const PREVIEW = `${MONITOR}/${PREVIEW_RAW}`;
const DEVTOOLS = `${MONITOR}/devtools`;

function appWindow(windowId: string, appId: string): OSAction {
  return {
    type: 'window.create',
    windowId,
    title: windowId,
    appId,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'iframe', data: '' },
  } as OSAction;
}

const INTERACTION = '<app_interaction>{"event":"pins_for_review","count":3}</app_interaction>';

describe('ContextPool — a task from a devtools preview window', () => {
  let pool: InstanceType<typeof ContextPool>;
  let windowState: WindowStateRegistry;
  let broadcasts: ServerEvent[];

  async function build(withDevtools: boolean): Promise<void> {
    windowState = new WindowStateRegistry();
    if (withDevtools) windowState.handleAction(appWindow('devtools', 'devtools'), MONITOR);
    windowState.handleAction(appWindow(PREVIEW_RAW, PREVIEW_APP), MONITOR);
    broadcasts = [];
    pool = new ContextPool({
      sessionId: 'test-session' as SessionId,
      host: createTestPoolHost(),
      windowState: windowState as never,
      reloadCache: { findMatches: () => [], record: () => {}, clear: mock(() => {}) } as never,
      broadcast: (event: ServerEvent) => {
        broadcasts.push(event);
      },
    });
    await pool.initialize();
    turns.length = 0;
  }

  afterEach(async () => {
    await pool.cleanup();
  });

  function previewTask(): Task {
    return {
      requestedType: 'app',
      kind: 'user',
      messageId: 'preview-msg',
      windowId: PREVIEW,
      content: INTERACTION,
    };
  }

  it("runs on devtools' app agent, in devtools' window, labelled as preview traffic", async () => {
    await build(true);
    await pool.handleTask(previewTask());

    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn.appId).toBe('devtools');
    expect(turn.windowId).toBe(DEVTOOLS);
    expect(turn.prompt).toContain(
      `<preview_interaction appId="${PREVIEW_APP}" windowId="${PREVIEW_RAW}">`,
    );
    expect(turn.prompt).toContain('not the user');
    expect(turn.prompt).toContain(INTERACTION);
    // The preview never became an app agent's active window, and spawned no agent of its own.
    expect(pool.getActiveAppWindow(MONITOR, 'devtools')).toBe(DEVTOOLS);
    expect(pool.getActiveAppWindow(MONITOR, PREVIEW_APP)).toBeUndefined();
    expect(pool.agentPool.appAgents.get(MONITOR, PREVIEW_APP)).toBeUndefined();
  });

  it('starts no turn when no devtools window is open — the monitor reads it next turn', async () => {
    await build(false);
    await pool.handleTask(previewTask());

    expect(turns).toHaveLength(0);
    const timeline = pool.timelineFor(MONITOR).drainAndFormat();
    expect(timeline).toContain(`<preview_interaction appId="${PREVIEW_APP}"`);
    expect(timeline).toContain(INTERACTION);
    // Settled for the sender, as a message no agent answers.
    expect(broadcasts).toContainEqual({
      type: ServerEventType.MESSAGE_ACCEPTED,
      messageId: 'preview-msg',
      agentId: NO_AGENT_ACK,
    });
  });

  it('still sends a real app window to its own app agent', async () => {
    await build(true);
    await pool.handleTask({ ...previewTask(), windowId: DEVTOOLS, content: 'hello' });

    expect(turns).toHaveLength(1);
    expect(turns[0].appId).toBe('devtools');
    expect(turns[0].prompt).not.toContain('preview_interaction');
  });
});

describe("ClientEventController — a toMonitor wake's source window", () => {
  let windowState: WindowStateRegistry;
  let handled: Task[];
  let controller: InstanceType<typeof ClientEventController>;

  beforeEach(() => {
    windowState = new WindowStateRegistry();
    windowState.handleAction(appWindow(PREVIEW_RAW, PREVIEW_APP), MONITOR);
    windowState.handleAction(appWindow('notes', 'notes'), MONITOR);
    handled = [];
    const pool = {
      agentPool: { hasMonitorAgent: () => true },
      handleTask: async (task: Task) => {
        handled.push(task);
      },
    };
    controller = new ClientEventController({
      windowState,
      monitors: { has: () => true },
      claimMessageId: () => true,
      getPool: () => pool,
      sendTo: () => {},
    } as never);
  });

  async function send(sourceWindowId: string | undefined): Promise<void> {
    const messageId = `m-${handled.length}`;
    await controller.routes()[ClientEventType.USER_MESSAGE](
      {
        type: ClientEventType.USER_MESSAGE,
        messageId,
        content: INTERACTION,
        monitorId: MONITOR,
        ...(sourceWindowId ? { sourceWindowId } : {}),
      },
      'conn-1' as ConnectionId,
    );
    await controller.taskSettled(messageId);
  }

  it("sends a preview's wake down the window path, not the monitor's", async () => {
    await send(PREVIEW);

    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ requestedType: 'app', windowId: PREVIEW });
  });

  it("leaves a real app's wake, and the user's own typing, on the monitor", async () => {
    await send(`${MONITOR}/notes`);
    await send(undefined);

    expect(handled.map((t) => t.requestedType)).toEqual(['monitor', 'monitor']);
  });
});
