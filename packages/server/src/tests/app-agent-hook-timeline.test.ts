/**
 * What an app agent's turn leaves on its monitor's timeline when a hook carries the answer.
 *
 * A `hook: "response"` task delivers the app agent's reply to the monitor through the hook,
 * so the timeline entry drops the response text (the monitor would otherwise read it twice).
 * A turn that emitted no OS actions — only app_command/app_query work — then had nothing
 * left to say, and still pushed a bare `<ai agent="…">No actions taken.</ai>` that read to
 * the monitor as a separate, unexplained turn (issue #175). That turn now pushes nothing.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AITransport } from '../providers/types.js';
import { installMockAgentSession } from './helpers/mock-agent-session.js';
import { createTestPoolHost } from './helpers/test-pool-host.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
// The set shared with app-agent-fresh.test.ts: enough to build a real ContextPool +
// AgentPool with no provider, logger, or disk.

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
    logMonitors = mock(() => {});
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

installMockAgentSession();

const { ContextPool } = await import('../agents/context-pool.js');

import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';

const MONITOR = '0';
const APP = 'devtools';
const WINDOW = `${MONITOR}/${APP}`;

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

describe('an app agent turn with no OS actions', () => {
  let pool: InstanceType<typeof ContextPool>;
  let hookResponses: string[];

  beforeEach(async () => {
    const windowState = new WindowStateRegistry();
    windowState.handleAction(appWindow(APP), MONITOR);
    pool = new ContextPool({
      sessionId: 'test-session' as SessionId,
      host: createTestPoolHost(),
      windowState: windowState as never,
      reloadCache: { findMatches: () => [], record: () => {}, clear: mock(() => {}) } as never,
      broadcast: mock(() => {}),
    });
    await pool.initialize();
    // Capture the hook instead of letting it start a monitor turn.
    hookResponses = [];
    pool.notifyHookResponse = (_appId, windowId) => {
      hookResponses.push(windowId);
    };
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  function message(extra: { hook?: 'response' } = {}) {
    return pool.handleTask({
      requestedType: 'app',
      kind: 'user',
      messageId: 'm1',
      windowId: WINDOW,
      monitorId: MONITOR,
      content: 'look at the preview',
      ...extra,
    });
  }

  it('leaves no timeline entry when a hook delivers the answer', async () => {
    await message({ hook: 'response' });

    expect(hookResponses).toEqual([WINDOW]);
    expect(pool.timelineFor(MONITOR).size).toBe(0);
  });

  it('still records the turn when no hook will', async () => {
    await message();

    expect(hookResponses).toEqual([]);
    expect(pool.timelineFor(MONITOR).drainAndFormat()).toContain('No actions taken.');
  });
});
