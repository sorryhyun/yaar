/**
 * Tests for the clipboard pre-grant (`lib/browser/clipboard-grant.ts`).
 *
 * Runs against a *real* fake DevTools endpoint — an ephemeral-port Bun.serve that
 * answers `/json/version` and speaks enough CDP to record what was sent — rather than
 * `mock.module`. That keeps the file in the `units` partition and exercises the real
 * `CDPClient` and the real fetch probe, which is where the interesting behaviour is.
 *
 * The port is ephemeral because the production default is 9222 and a developer running
 * a debuggable Chrome must not change the result (see the "never depends on the machine
 * it runs on" rule in packages/server/CLAUDE.md).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';

import {
  startClipboardGrant,
  stopClipboardGrant,
  clipboardGrantStatus,
} from '../lib/browser/clipboard-grant.js';

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeChrome {
  server: Server<unknown>;
  calls: CdpCall[];
  /** Drop the live DevTools socket, the way a Chrome restart would. */
  dropConnection(): void;
}

function startFakeChrome(): FakeChrome {
  const calls: CdpCall[] = [];
  let live: ServerWebSocket<unknown> | null = null;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/json/version') {
        return Response.json({
          Browser: 'FakeChrome/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
        });
      }
      if (srv.upgrade(req)) return undefined;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        live = ws;
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: object };
        calls.push({ method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      },
      close() {
        live = null;
      },
    },
  });

  return {
    server,
    calls,
    dropConnection: () => live?.close(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

const grants = (chrome: FakeChrome) =>
  chrome.calls.filter((c) => c.method === 'Browser.grantPermissions');

let fake: FakeChrome | null = null;

afterEach(() => {
  stopClipboardGrant();
  fake?.server.stop(true);
  fake = null;
  delete process.env.YAAR_CLIPBOARD_GRANT;
});

describe('clipboard grant', () => {
  it('grants clipboard read to the desktop origin over CDP', async () => {
    fake = startFakeChrome();
    startClipboardGrant(8000, { debugPort: fake.server.port, intervalMs: 50 });

    await waitFor(() => grants(fake!).length > 0);

    const grant = grants(fake)[0]!;
    expect(grant.params.origin).toBe('http://localhost:8000');
    expect(grant.params.permissions).toContain('clipboardReadWrite');
    expect(grant.params.permissions).toContain('clipboardSanitizedWrite');
    expect(clipboardGrantStatus()).toEqual({ held: true, origin: 'http://localhost:8000' });
  });

  it('never grants to the app origin — that would hand every installed app the clipboard', async () => {
    fake = startFakeChrome();
    startClipboardGrant(8000, { debugPort: fake.server.port, intervalMs: 50 });

    await waitFor(() => grants(fake!).length > 0);

    for (const grant of grants(fake)) {
      expect(String(grant.params.origin)).not.toContain('127.0.0.1');
    }
  });

  it('re-grants after the DevTools connection drops', async () => {
    fake = startFakeChrome();
    startClipboardGrant(8000, { debugPort: fake.server.port, intervalMs: 50 });
    await waitFor(() => grants(fake!).length > 0);

    // The override dies with the connection, so a reconnect that assumed the old grant
    // still stood would leave the origin `denied` with nothing holding it.
    fake.dropConnection();
    await waitFor(() => grants(fake!).length > 1);

    expect(clipboardGrantStatus().held).toBe(true);
  });

  it('is a no-op, not an error, when no debuggable Chrome is listening', async () => {
    // Bind and immediately release a port so it is almost certainly unused.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    const deadPort = probe.port;
    probe.stop(true);

    startClipboardGrant(8000, { debugPort: deadPort, intervalMs: 50 });
    await Bun.sleep(200);

    expect(clipboardGrantStatus()).toEqual({ held: false, origin: null });
  });

  it('does nothing when YAAR_CLIPBOARD_GRANT=0', async () => {
    process.env.YAAR_CLIPBOARD_GRANT = '0';
    fake = startFakeChrome();

    startClipboardGrant(8000, { debugPort: fake.server.port, intervalMs: 50 });
    await Bun.sleep(200);

    expect(grants(fake)).toHaveLength(0);
    expect(clipboardGrantStatus().held).toBe(false);
  });

  it('releases the connection on stop', async () => {
    fake = startFakeChrome();
    startClipboardGrant(8000, { debugPort: fake.server.port, intervalMs: 50 });
    await waitFor(() => grants(fake!).length > 0);

    stopClipboardGrant();

    expect(clipboardGrantStatus()).toEqual({ held: false, origin: null });
  });
});
