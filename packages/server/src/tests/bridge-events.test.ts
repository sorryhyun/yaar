/**
 * Tests for the YAAR Bridge T4 (React) surface — the extension speaking unprompted.
 *
 * Everything else on the bridge is pull: a handshake, a tab snapshot, or a reply to a command the
 * server asked for. `event` is the first frame the real browser originates on its own (a native
 * dialog fired on a driven tab, a driven tab navigated), and it has to reach a *subscribed agent*
 * to be worth anything. So these tests walk the whole server half of the path:
 *
 *   extension frame → handleBridgeMessage → actionEmitter → LiveSession → subscribed agent's task
 *
 * The extension half (patching `window.alert` in the page) can only be exercised in a real Chrome.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { AITransport } from '../providers/types.js';
import { installMockAgentSession } from './helpers/mock-agent-session.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Same set as message-delivery.test.ts: enough to build a ContextPool and a LiveSession without a
// provider, a logger, or a disk. The real actionEmitter is used on purpose — it *is* the transport
// under test here, and stubbing it leaks process-wide into whatever file runs next.

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

// ── Imports under test (after mocks) ───────────────────────────────────────

const { LiveSession } = await import('../session/live-session.js');

import type { OSAction } from '@yaar/shared';
import { bridgeMessageSchema, BRIDGE_PROTOCOL_VERSION } from '@yaar/shared/schemas';
import { handleBridgeMessage } from '../websocket/bridge-handlers.js';
import { resetBroadcastCenter } from '../session/broadcast-center.js';
import type { SessionId } from '../session/types.js';
import type { Task } from '../agents/pool-types.js';

const SESSION = 'test-session' as SessionId;

/** An app window, the way `browser-user` (or any app) appears in the registry. */
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

/** A `dialog` frame, exactly as the extension puts it on the wire. */
function dialogFrame(message: string) {
  return JSON.stringify({
    type: 'event',
    channel: 'dialog',
    payload: { kind: 'alert', message, tabId: 7, url: 'https://example.com/post' },
  });
}

/** The bridge socket the handler wants; nothing on the `event` path touches it. */
const noopWs = { data: { connectionId: 'bridge-conn' } } as never;

/** Matches the `debounceMs` passed to `subscribeChannels` below. */
const DEBOUNCE_MS = 10;

/** Poll a predicate until it's true, or fail after a generous budget. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('Timed out waiting for condition');
}

/**
 * Wait long enough to prove an absence: `handleBridgeMessage` is synchronous and, when
 * no subscriber matches, `WindowSubscriptionPolicy.notifyChannel` arms no debounce timer
 * at all — so a delivery that was going to happen already would have by `DEBOUNCE_MS`.
 * There's no promise to await here, only a window to wait out.
 */
const settleAbsence = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS * 5));

// ───────────────────────────────────────────────────────────────────────────

describe('the wire contract', () => {
  it('accepts an event frame on a declared channel', () => {
    const parsed = bridgeMessageSchema.safeParse(JSON.parse(dialogFrame('are you sure?')));
    expect(parsed.success).toBe(true);
  });

  it('refuses a channel the app never declared', () => {
    // The channel enum is the honesty check: an extension cannot invent a channel that no agent
    // could have discovered from the app's manifest, so there is nothing to subscribe to.
    const parsed = bridgeMessageSchema.safeParse({
      type: 'event',
      channel: 'keystrokes',
      payload: { key: 'a' },
    });
    expect(parsed.success).toBe(false);
  });

  it('announces itself at a version that carries events', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(5);
  });
});

describe('a real-browser event reaches a subscribed agent', () => {
  let session: InstanceType<typeof LiveSession>;
  let delivered: Task[];

  beforeEach(async () => {
    resetBroadcastCenter();
    session = new LiveSession(SESSION);
    await (session as unknown as { ensureInitialized: () => Promise<boolean> }).ensureInitialized();

    const pool = session.getPool()!;
    // Deliver tasks into an array instead of running an agent turn.
    (pool as unknown as { handleTask: (t: Task) => Promise<void> }).handleTask = async (t) => {
      delivered.push(t);
    };
    delivered = [];
  });

  afterEach(async () => {
    await session.cleanup();
  });

  /** Subscribe monitor 0's agent to a channel on an open window. */
  function subscribe(targetWindowId: string, channel: string): void {
    session.getPool()!.windowSubscriptionPolicy.subscribeChannels({
      subscriberAgentKey: 'monitor-0',
      subscriberType: 'monitor',
      subscriberMonitorId: '0',
      targetWindowId,
      channels: [channel],
      mode: 'wake',
      debounceMs: DEBOUNCE_MS,
    });
  }

  it('wakes the agent with what the page actually said', async () => {
    session.windowState.handleAction(appWindow('browser-user'), '0');
    subscribe('0/browser-user', 'dialog');

    handleBridgeMessage(noopWs, dialogFrame('글 내용을 입력하세요'));
    await waitFor(() => delivered.length === 1);

    expect(delivered.length).toBe(1);
    // The whole point: the agent learns the message text, instead of watching its next click
    // time out against a tab frozen behind a modal.
    expect(delivered[0].content).toContain('글 내용을 입력하세요');
    expect(delivered[0].content).toContain('dialog');
  });

  it('drops the event when no Real Browser window is open', async () => {
    // The channels are declared on the window. No window, nobody who could have subscribed.
    handleBridgeMessage(noopWs, dialogFrame('nobody is listening'));
    await settleAbsence();

    expect(delivered).toEqual([]);
  });

  it('does not deliver a bridge event to some other app’s subscriber', async () => {
    session.windowState.handleAction(appWindow('notes'), '0');
    subscribe('0/notes', 'dialog');

    handleBridgeMessage(noopWs, dialogFrame('not for notes'));
    await settleAbsence();

    expect(delivered).toEqual([]);
  });

  it('stops delivering once the session is torn down', async () => {
    session.windowState.handleAction(appWindow('browser-user'), '0');
    subscribe('0/browser-user', 'dialog');

    await session.cleanup();

    // The listener lives on a process-global emitter, so a session that failed to unhook would
    // keep answering bridge frames — and hold its pool alive — for the life of the process.
    handleBridgeMessage(noopWs, dialogFrame('after cleanup'));
    await settleAbsence();

    expect(delivered).toEqual([]);
  });
});
