/**
 * The one-shot DevTools probes in `LocalUserBrowser`, against a *real* socket.
 *
 * `local-user-browser.test.ts` covers this class with `mock.module` and a stubbed
 * global `fetch`, which is the right tool for "does it avoid spawning Chrome" but
 * cannot see anything about the fetch itself. Both probes here carry a sub-4s
 * `AbortSignal.timeout` (2000ms and 3000ms), and both swallow an abort into a
 * *negative answer* — `false`, or the "Could not reach the user's Chrome" throw.
 * So a runtime that aborts such a fetch early does not fail loudly here; it
 * reports "the user has no debuggable Chrome" and sends the caller down the
 * launch path. A stubbed fetch resolves instantly and never exercises the timer.
 *
 * The negative case is the load-bearing one: without it this file would pass on a
 * runtime that resolved every probe unconditionally, which is the same shape of
 * false green it exists to rule out.
 *
 * Ephemeral port, because the production default is 9222 and a developer running a
 * debuggable Chrome must not change the result (the "never depends on the machine
 * it runs on" rule in packages/server/CLAUDE.md).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { Server } from 'bun';

import { LocalUserBrowser } from '../lib/browser/local-user-browser.js';

/** Exposes the protected discovery probe; nothing else about the class changes. */
class ProbeableBrowser extends LocalUserBrowser {
  probeChromePort(): Promise<number> {
    return this.ensureChromePort();
  }
}

/** `Server.port` is optional in the type (a unix-socket server has none); these all bind TCP. */
function portOf(srv: Server<unknown>): number {
  const port = srv.port;
  if (port == null) throw new Error('expected a TCP port');
  return port;
}

/** Answers `/json/version` the way Chrome's DevTools HTTP endpoint does, and nothing else. */
function startFakeDevTools(): Server<unknown> {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/json/version') {
        return Response.json({
          Browser: 'FakeChrome/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
}

/** A port with nothing listening: bind one, read it back, drop it. */
async function deadPort(): Promise<number> {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
  const port = portOf(srv);
  await srv.stop(true);
  return port;
}

let server: Server<unknown> | null = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

describe('LocalUserBrowser DevTools probes over a real socket', () => {
  it('reports available on the first call from cold', async () => {
    server = startFakeDevTools();
    // First call on a fresh instance — no warmed connection, no prior fetch.
    expect(await new LocalUserBrowser(portOf(server)).isAvailable()).toBe(true);
  });

  it('reports unavailable when nothing is listening', async () => {
    expect(await new LocalUserBrowser(await deadPort()).isAvailable()).toBe(false);
  });

  it('hands out the port instead of throwing when the endpoint answers', async () => {
    server = startFakeDevTools();
    const browser = new ProbeableBrowser(portOf(server));
    expect(await browser.probeChromePort()).toBe(portOf(server));
  });

  it('throws the reach error when the endpoint is gone', async () => {
    const port = await deadPort();
    const browser = new ProbeableBrowser(port);
    await expect(browser.probeChromePort()).rejects.toThrow(
      `Could not reach the user's Chrome on 127.0.0.1:${port}`,
    );
  });
});
