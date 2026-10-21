/**
 * An app agent's reply reaches the monitor once, not twice (issue #182, gap 11) — and not
 * zero times (issue #187, item 1).
 *
 * The monitor asked an app agent something with `hook: "response"`. The app agent answered
 * with `direct_message` to the monitor — which wakes the monitor (a relay interrupts and
 * queues) — and then the hook delivered the turn's final text again two seconds later,
 * interrupting the turn the first delivery had started. A turn whose last tool call
 * messaged the monitor that asked now fires no hook, and leaves no copy of its reply on
 * the monitor's timeline either.
 *
 * But a message sent mid-work (a question, a progress note) is not the answer: a turn that
 * kept calling tools after it still owes the monitor its final report, and the hook carries
 * it. Skipping it there left the monitor waiting on a reply that never came.
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

const REPLY = 'pins reviewed: 3 approved, 1 rejected';

/** What the app agent's next turn does besides answering: message the monitor, or not. */
let duringTurn: () => void = () => {};
/** The agent's work-tool-call count, as `AgentSession.toolCallCount` reports it. */
let toolCalls = 0;

installMockAgentSession({
  toolCallCount: () => toolCalls,
  handleMessage: async (_prompt, opts) => {
    duringTurn();
    const { onContextMessage } = opts as {
      onContextMessage?: (role: string, content: string) => void;
    };
    onContextMessage?.('assistant', REPLY);
  },
});

const { ContextPool } = await import('../agents/context-pool.js');

import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import type { SessionId } from '../session/types.js';

const MONITOR = '0';
const APP = 'pin-preview';
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

describe('a hooked app agent turn that already messaged its monitor', () => {
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
    hookResponses = [];
    pool.notifyHookResponse = (_appId, _windowId, _monitorId, text) => {
      hookResponses.push(text);
    };
    duringTurn = () => {};
    toolCalls = 0;
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  /** What `direct_message` to the monitor records for its sender (mcp/messaging). */
  function appAgentMessagesMonitor(monitorId = MONITOR): void {
    const agent = pool.agentPool.appAgents.get(MONITOR, APP);
    if (!agent) throw new Error('no app agent to send from');
    pool.agentPool.noteMonitorMessaged(agent.instanceId, monitorId);
  }

  function ask(messageId: string, hook?: 'response') {
    return pool.handleTask({
      requestedType: 'app',
      kind: 'relay',
      messageId,
      windowId: WINDOW,
      monitorId: MONITOR,
      content: 'review the pins',
      ...(hook ? { hook } : {}),
    });
  }

  it('fires no hook, and puts no second copy on the timeline', async () => {
    duringTurn = () => appAgentMessagesMonitor();
    await ask('m1', 'response');

    expect(hookResponses).toEqual([]);
    expect(pool.timelineFor(MONITOR).drainAndFormat()).not.toContain(REPLY);
  });

  it('still fires the hook when the turn kept working after messaging the monitor', async () => {
    duringTurn = () => {
      toolCalls++; // starts the work
      appAgentMessagesMonitor(); // asks the monitor a question
      toolCalls += 3; // and carries on to the deploy
    };
    await ask('m1', 'response');

    expect(hookResponses).toEqual([REPLY]);
  });

  it('fires no hook when the last of several messages ends the turn', async () => {
    duringTurn = () => {
      appAgentMessagesMonitor(); // a progress note
      toolCalls += 2;
      appAgentMessagesMonitor(); // the answer
    };
    await ask('m1', 'response');

    expect(hookResponses).toEqual([]);
  });

  it('still fires the hook when the turn did not message the monitor', async () => {
    await ask('m1', 'response');

    expect(hookResponses).toEqual([REPLY]);
  });

  it('is not silenced by a message an earlier turn sent', async () => {
    duringTurn = () => appAgentMessagesMonitor();
    await ask('m1');
    duringTurn = () => {};
    await ask('m2', 'response');

    expect(hookResponses).toEqual([REPLY]);
  });

  it('is not silenced by a message to a different monitor', async () => {
    duringTurn = () => appAgentMessagesMonitor('1');
    await ask('m1', 'response');

    expect(hookResponses).toEqual([REPLY]);
  });
});
