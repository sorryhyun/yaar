/**
 * The loopback harness: the real server, from the socket down, with two fakes at the ends.
 *
 * Real: `createWsHandlers` (open/message/close), `SessionHub`, `LiveSession`, `ContextPool`,
 * `AgentPool`, `AgentSession`, `actionEmitter`, `PendingStore`, `BroadcastCenter`,
 * `WindowStateRegistry`, and the app-protocol handlers. Fake: the browser (`FakeClient`)
 * and the model (`ScriptedProvider`). Nothing in between.
 *
 * That "nothing in between" is the whole design. The deadlock ~460 tests missed was not
 * inside any unit — `live-session.ts` awaiting the turn is fine, `ws.data.queue`
 * serializing a connection's frames is fine — it was in their composition. A test that
 * mocks either one cannot see it. So this harness mocks neither, and the frames a test
 * sends travel the same queue the bug lived in.
 *
 * **No `mock.module` anywhere, and its own Bun process.** Both halves of that matter.
 *
 * The harness takes every substitution through a real seam — the provider through
 * `ContextPool`'s `acquireProvider` (§1.3), the session logger through the `sessionLogger`
 * option that already existed, the deadlines through `setDeadlinesForTest` (§1.2), the
 * config directory through `YAAR_CONFIG` so a reload cache lands in a temp dir. Everything
 * else (the apps on disk, the memory file, the environment section) is read for real,
 * because it is cheap and because a fake is one more thing that can lie.
 *
 * But a harness cannot defend itself against *other files'* mocks. `mock.module` is
 * process-global, has no teardown, and — this is the part that decides the layout —
 * `mock.restore()` cannot undo it once the real module has already been loaded, which by
 * then it always has. Five files in `src/tests/` replace `AgentSession` with a stub whose
 * `handleMessage` resolves instantly. Under that stub, "routeMessage awaits the whole
 * turn" awaits nothing, no turn can wait on the client, and every test in this directory
 * would pass while proving nothing — the exact failure this harness exists to end, wearing
 * a green tick. So this suite runs in its own Bun process (`bun test src/tests/loopback`;
 * see package.json), where the only code that can stub the system under test is this code,
 * and it doesn't.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OSAction, WindowContent } from '@yaar/shared';
import type { Deadlines } from '../../../config.js';
import type { LiveSession } from '../../../session/live-session.js';
import type { SessionLogger } from '../../../logging/index.js';
import type { SessionId } from '../../../session/types.js';
import { FakeClient, type WsHandlers } from './fake-client.js';
import { ScriptRegistry, ScriptedProvider } from './scripted-provider.js';

const { createWsHandlers } = await import('../../../websocket/server.js');
const { getSessionHub } = await import('../../../session/session-hub.js');
const { getBroadcastCenter, resetBroadcastCenter } =
  await import('../../../session/broadcast-center.js');
const { actionEmitter } = await import('../../../session/action-emitter.js');
const { setDeadlinesForTest } = await import('../../../config.js');

/**
 * Test deadlines. Small enough that a deadlocked turn is a fast red test, large enough
 * that an ordinary in-process round trip (a few event-loop turns) never trips them.
 */
const HARNESS_DEADLINES: Deadlines = {
  appQueryMs: 150,
  appCommandMs: 150,
  appCommandMinMs: 10,
  appReadyMs: 150,
  dialogMs: 150,
  userPromptMs: 150,
  renderFeedbackMs: 150,
};

/**
 * A logger that writes nowhere, handed in through the option the server already has for
 * one. Passing it is what keeps `ContextPool.initialize` from calling `createSession()`
 * and minting a `session_logs/` directory per test.
 */
function createLoggerDouble(): SessionLogger {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    getSessionId: () => 'harness-log-session',
    getAgentPath: () => join(tmpdir(), 'harness-agent.jsonl'),
    updateProvider: noop,
    registerAgent: asyncNoop,
    logUserMessage: noop,
    logAssistantMessage: noop,
    logThinking: noop,
    logToolUse: noop,
    logToolResult: noop,
    logAction: noop,
    logInteraction: noop,
    logThreadId: noop,
    updateLastActivity: asyncNoop,
    flush: asyncNoop,
    dispose: asyncNoop,
  } as unknown as SessionLogger;
}

export interface Harness {
  sessionId: SessionId;
  session: LiveSession;
  client: FakeClient;
  handlers: WsHandlers;
  /** Script the agent's turns and read back what actually ran. */
  registry: ScriptRegistry;
  /**
   * Put an iframe app window into the session's real registry, the way an agent's
   * `window.create` does. Returns the monitor-scoped key (`"0/ai-chat"`) — the key the
   * app-protocol handlers and the frontend both address it by.
   */
  seedIframeWindow(rawId: string, opts?: { appId?: string; monitorId?: string }): string;
  /** Open another connection to the same session (reconnect / multi-tab scenarios). */
  connect(monitorId?: string): Promise<FakeClient>;
  dispose(): Promise<void>;
}

export async function boot(
  opts: { deadlines?: Partial<Deadlines>; monitorId?: string } = {},
): Promise<Harness> {
  resetBroadcastCenter();
  // No app-protocol readiness reset here, deliberately. It used to be needed: readiness was
  // a process-global Set keyed by window key ("0/ai-chat"), with no session in the key and
  // no removal, so the *second* test to seed the same app id inherited "already ready" from
  // the first and never entered the wait it was written to prove. Readiness is now keyed by
  // session and dropped when the session is (`clearPendingForSession`), so each `boot()` —
  // which mints a fresh session id — starts with no registrations, and `dispose()` leaves
  // none behind. A test that needs the wait gets the wait.
  const restoreDeadlines = setDeadlinesForTest({ ...HARNESS_DEADLINES, ...opts.deadlines });

  // The reload cache writes itself to `{configDir}/reload-cache/{sessionId}.json`. Point it
  // at a temp dir so a test run leaves nothing behind in the repo's config/.
  const previousConfigDir = process.env.YAAR_CONFIG;
  process.env.YAAR_CONFIG = mkdtempSync(join(tmpdir(), 'yaar-harness-'));

  // One registry, shared by every provider instance the pool acquires (one per agent), so a
  // test scripts turns and reads results in one place. It cannot exist yet — it needs the
  // session's window registry, and the session is created by the `open()` below, which needs
  // the provider factory that closes over it. Hence the holder: the factory reads it when an
  // agent is actually created, which is always after the session exists.
  const held: { registry?: ScriptRegistry } = {};

  const handlers = createWsHandlers({
    restoreActions: [],
    contextMessages: [],
    sessionLogger: createLoggerDouble(),
    // §1.3 — the provider seam.
    acquireProvider: async () => {
      if (!held.registry) throw new Error('harness: a provider was acquired before boot()');
      return new ScriptedProvider(held.registry);
    },
  }) as WsHandlers;

  const client = new FakeClient(handlers, null, opts.monitorId ?? '0');
  await client.open();

  const sessionId = client.data.sessionId as SessionId;
  const session = getSessionHub().get(sessionId);
  if (!session) throw new Error('harness: session was not created by open()');

  const registry = new ScriptRegistry(sessionId, session.windowState);
  held.registry = registry;

  const clients = [client];

  return {
    sessionId,
    session,
    client,
    handlers,
    registry,

    seedIframeWindow(rawId, { appId = rawId, monitorId = '0' } = {}) {
      const content: WindowContent = {
        renderer: 'iframe',
        data: { url: `/apps/${appId}/index.html` },
      } as WindowContent;
      const action: OSAction = {
        type: 'window.create',
        windowId: rawId,
        title: appId,
        bounds: { x: 0, y: 0, w: 800, h: 600 },
        content,
        appId,
      } as OSAction;
      // The real registry call the action listener makes — including the handle-map
      // registration that turns "ai-chat" into "0/ai-chat".
      session.windowState.handleAction(action, monitorId);
      return session.windowState.getWindow(rawId)?.id ?? `${monitorId}/${rawId}`;
    },

    async connect(monitorId = '0') {
      const extra = new FakeClient(handlers, sessionId, monitorId);
      await extra.open();
      clients.push(extra);
      return extra;
    },

    async dispose() {
      // Order matters: cancel the waits first (so anything still parked settles as
      // `cancelled` rather than running out its own deadline against a dead session),
      // then tear the session down, then put the singletons and the environment back.
      actionEmitter.clearPendingForSession(sessionId);
      for (const c of clients) {
        await c.settleResponders().catch(() => {});
        await c.close();
        getBroadcastCenter().unsubscribe(c.data.connectionId);
      }
      // `remove()` → `LiveSession.cleanup()` → `clearPendingForSession`, which is also what
      // drops this session's app-protocol registrations. Nothing survives it.
      await getSessionHub().remove(sessionId);
      resetBroadcastCenter();
      restoreDeadlines();
      if (previousConfigDir === undefined) delete process.env.YAAR_CONFIG;
      else process.env.YAAR_CONFIG = previousConfigDir;
    },
  };
}
