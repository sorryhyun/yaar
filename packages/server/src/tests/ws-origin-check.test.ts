/**
 * `/ws` and `/bridge` refuse a browser that is not the desktop (or the extension).
 *
 * A WebSocket is not subject to CORS, and in local mode `/ws` asks for no credential: a
 * connection naming no session joins the user's live one, reading every event and
 * sending the agent messages. So any page the user visited could open it. The browser's
 * `Origin` is what separates the desktop from that page — and from an isolated app,
 * which lives on loopback too but on the app alias.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { Server } from 'bun';
import { createFetchHandler } from '../http/server.js';
import { installLoopbackAliasBoundary, resetOriginBoundary } from '../http/origin-boundary.js';
import { getPort } from '../config.js';
import type { WsData } from '../websocket/server.js';

const handle = createFetchHandler();

/** A server whose upgrade always succeeds — the handler then returns nothing. */
const server = { upgrade: () => true } as unknown as Server<WsData>;

async function upgrade(path: string, origin?: string, host = 'localhost') {
  return handle(
    new Request(`http://${host}:${getPort()}${path}`, {
      headers: { upgrade: 'websocket', ...(origin ? { origin } : {}) },
    }),
    server,
  );
}

afterEach(() => resetOriginBoundary());

describe('/ws Origin validation', () => {
  it('refuses a foreign Origin', async () => {
    const res = await upgrade('/ws', 'http://evil.example');
    expect(res?.status).toBe(403);
  });

  it('refuses a DNS-rebound page, which is same-origin with itself', async () => {
    const res = await upgrade('/ws', `http://evil.example:${getPort()}`);
    expect(res?.status).toBe(403);
  });

  it('refuses the isolated-app origin', async () => {
    installLoopbackAliasBoundary();
    expect((await upgrade('/ws', `http://127.0.0.1:${getPort()}`))?.status).toBe(403);
    // A relative dial that stayed on the app alias sends that Origin and lands there.
    expect((await upgrade('/ws', undefined, '127.0.0.1'))?.status).toBe(403);
  });

  it("upgrades the desktop's own origin, on any loopback port", async () => {
    expect(await upgrade('/ws', `http://localhost:${getPort()}`)).toBeUndefined();
    expect(await upgrade('/ws', 'http://localhost:5173')).toBeUndefined();
  });

  it('upgrades a client that sends no Origin (not a browser page)', async () => {
    expect(await upgrade('/ws')).toBeUndefined();
  });
});

describe('/bridge Origin validation', () => {
  it('refuses a web page', async () => {
    expect((await upgrade('/bridge', 'http://evil.example'))?.status).toBe(403);
    expect((await upgrade('/bridge', `http://localhost:${getPort()}`))?.status).toBe(403);
  });

  it('upgrades the extension and origin-less clients', async () => {
    expect(await upgrade('/bridge', 'chrome-extension://abcdefghijklmnop')).toBeUndefined();
    expect(await upgrade('/bridge')).toBeUndefined();
  });
});
