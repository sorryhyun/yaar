/**
 * A `PoolHost` for suites that build a `ContextPool` or `AgentPool` without a
 * `LiveSession` around it: every monitor a desktop with no reported viewport, no agent
 * directory, and no transcript. `openSessionLogger` mints nothing, so no suite writes a
 * `session_logs/` directory.
 *
 * Pass `overrides` for the one member a suite needs to observe or change.
 */
import type { PoolHost } from '../../agents/pool-types.js';

export function createTestPoolHost(overrides: Partial<PoolHost> = {}): PoolHost {
  return {
    layout: {
      getFormFactor: () => 'desktop',
      getViewport: () => undefined,
      getOrientation: () => undefined,
      removeAgent: () => {},
    },
    registerAgent: () => {},
    unregisterAgent: () => {},
    getSessionLogger: () => null,
    openSessionLogger: async () => 'test-log-session',
    ...overrides,
  };
}
