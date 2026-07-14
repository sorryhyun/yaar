/**
 * Slice 3 — the monitor of an action is derived, never guessed.
 *
 * The bulk of Slice 3's acceptance lives in
 * `packages/server/src/tests/monitor-identity.test.ts`. This one assertion cannot: that
 * file's process has `agents/agent-context.js` stubbed by `uri-resolve.test.ts` with
 * `getMonitorId: () => '0'`, and Bun's `mock.module` is process-wide and never restored
 * between files. "No monitor in context" — the exact condition under test — is not
 * expressible there. Here the real module is loaded, so an empty context is really empty.
 */
import { describe, it, expect } from 'bun:test';

const { actionEmitter } = await import('@yaar/server/session/action-emitter');

describe('a window action with no monitor', () => {
  it('fails instead of landing on monitor 0', () => {
    // resolveWindowMonitor used to end `?? activeMonitorId ?? '0'`: the session's
    // last-subscribed monitor, then the default. Both were guesses, and the guess was
    // wrong precisely when it mattered — the window was registered on the monitor the
    // server picked and rendered on the one the frontend picked, so one app became two
    // windows. Every window action is now emitted inside an agent turn or an iframe verb
    // call, and both carry a monitor. One that carries none cannot be placed.
    actionEmitter.clearCurrentMonitor();

    expect(() => actionEmitter.resolveWindowMonitor('some-session')).toThrow(/monitor/i);
  });
});
