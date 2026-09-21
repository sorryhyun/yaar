/**
 * Shared fake `CDPClient` installer for `browser-session.test.ts` and
 * `browser-pool.test.ts` — both mock `lib/browser/cdp.js` with a near-identical
 * `CDPClient.connect` stub, so the object-shape boilerplate lives here once.
 *
 * `--isolate` (the `units` partition, see the `yaar-testing` skill) gives each test
 * file its own fresh module registry, so this stays safe to share: every caller gets
 * its own private `mock.module(...)` registration and its own set of `mock()` fns —
 * nothing here is shared *state*, only shared *shape*.
 *
 * Call `installFakeCdpClient()` synchronously, before any dynamic
 * `import('../lib/browser/session.js')` or `import('../lib/browser/pool.js')` in the
 * test file — `mock.module` only affects imports that happen after it registers, so a
 * call issued too late (or never awaited-through before the module-under-test import)
 * leaves the real `cdp.js` in place.
 *
 * `CDPClient.connect` itself is intentionally not returned: callers already do
 * `const { CDPClient } = await import('../lib/browser/cdp.js')` after installing the
 * mock (to assert on `.connect` calls / args directly), and returning a second
 * reference to the same mock here would just be one more thing to keep in sync.
 */
import { mock } from 'bun:test';

export interface FakeCdpClientMocks {
  send: ReturnType<typeof mock>;
  waitForEvent: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
  onClose: ReturnType<typeof mock>;
}

export function installFakeCdpClient(): FakeCdpClientMocks {
  const send = mock((_method: string, _params?: Record<string, unknown>) =>
    Promise.resolve({} as Record<string, unknown>),
  );
  const waitForEvent = mock(() => Promise.resolve(undefined));
  const close = mock(() => undefined);
  const on = mock(() => {});
  const off = mock(() => {});
  const onClose = mock(() => {});

  mock.module('../../lib/browser/cdp.js', () => ({
    CDPClient: {
      connect: mock(() =>
        Promise.resolve({
          send,
          waitForEvent,
          close,
          on,
          off,
          onClose,
        }),
      ),
    },
  }));

  return { send, waitForEvent, close, on, off, onClose };
}
