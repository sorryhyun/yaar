/**
 * Shared fake `AgentSession` installer for the suites that build a real
 * `ContextPool`/`AgentPool` against a stubbed provider session — no provider, logger,
 * or disk — and only care that a turn "ran": `message-delivery`, `multi-monitor`,
 * `monitor-identity`, `agent-cleanup`, `app-agent-fresh`, `app-agent-context-lost`,
 * `bridge-events`. All seven hand-copied a near-identical `MockAgentSession` class and
 * `agents/agent-context.js` re-export shape; centralizing it here is what stops an
 * eighth copy from drifting from the seventh. Deliberately narrower than the real
 * class: it does not stub `getConnectionId`/`getInstanceId`/`getCurrentMessageId`/
 * `getCurrentRole`/`getRawSessionId`/`getSessionId`/`getSessionLogger` because nothing
 * in these suites' code paths calls them on an `AgentSession` instance.
 *
 * `--isolate` (the `units` partition, see the `yaar-testing` skill) gives each test
 * file its own fresh module registry, so this stays safe to share: every caller gets
 * its own private `mock.module(...)` registration and its own set of `mock()` fns —
 * nothing here is shared *state*, only shared *shape*.
 *
 * Call `installMockAgentSession(...)` synchronously, before any dynamic
 * `import('../agents/context-pool.js')` or `import('../agents/agent-pool.js')` in the
 * test file — `mock.module` only affects imports that happen after it registers.
 *
 * Overrides exist only where a suite actually needs different behavior:
 * `agent-cleanup.test.ts` passes in its own externally-held `mock()` fns so it can
 * assert call counts and swap implementations (`mockRejectedValueOnce`, etc.) — each
 * still gets wrapped in a fresh `mock()` below like every other field (so the class
 * field itself supports `.mock.calls`/`toHaveBeenCalled()`, which `app-agent-fresh.test.ts`
 * relies on for `handleMessage` and `steer`), but a wrapper only ever forwards to the
 * override, so the override's own call tracking still advances in lockstep and the
 * test's assertions on *its* reference keep working. `app-agent-fresh.test.ts` and
 * `app-agent-context-lost.test.ts` need a `handleMessage`/`isRunning` pair that can
 * hold a turn open (steering tests); since these are no longer class-body field
 * initializers, they can't close over `this` the way the original hand-copies did —
 * callers track "is a turn running" in a module-scope variable instead (the same
 * pattern those two files already use for `blockTurns`/`held`). `multi-monitor.test.ts`
 * and `agent-cleanup.test.ts` need `getMonitorId` to resolve to a real monitor.
 */
import { mock } from 'bun:test';

export interface MockAgentSessionOverrides {
  attachProvider?: (provider: unknown) => void;
  handleMessage?: (prompt: string, opts: unknown) => unknown;
  isRunning?: () => boolean;
  interrupt?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  wasInterrupted?: () => boolean;
  steer?: () => Promise<boolean>;
  /** `agents/agent-context.js`'s `getMonitorId`, not the class's own state. */
  getMonitorId?: () => string | undefined;
}

export function installMockAgentSession(overrides: MockAgentSessionOverrides = {}): void {
  mock.module('../../agents/agent-session.js', () => {
    class MockAgentSession {
      attachProvider = mock(overrides.attachProvider ?? (() => {}));
      handleMessage = mock(overrides.handleMessage ?? (async () => {}));
      isRunning = mock(overrides.isRunning ?? (() => false));
      interrupt = mock(overrides.interrupt ?? (async () => {}));
      cleanup = mock(overrides.cleanup ?? (async () => {}));
      getRecordedActions = mock(() => []);
      setOutputCallback = mock(() => {});
      getUsage = mock(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }));
      wasInterrupted = mock(overrides.wasInterrupted ?? (() => false));
      steer = mock(overrides.steer ?? (async () => false));
      prewarm = mock(async () => {});
    }
    return {
      AgentSession: MockAgentSession,
      getAgentId: mock(() => undefined),
      getCurrentConnectionId: mock(() => undefined),
      getSessionId: mock(() => undefined),
      getMonitorId: mock(overrides.getMonitorId ?? (() => undefined)),
      getWindowId: mock(() => undefined),
      runWithAgentId: mock((_id: string, fn: () => unknown) => fn()),
      runWithAgentContext: mock((_ctx: unknown, fn: () => unknown) => fn()),
    };
  });
}
