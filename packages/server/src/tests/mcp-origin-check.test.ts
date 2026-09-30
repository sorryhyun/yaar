/**
 * Every /mcp/ door refuses a browser that is not this desktop.
 *
 * The MCP spec asks servers to validate Origin against DNS rebinding: a page on a
 * rebound hostname is same-origin with itself, so CORS never stands in its way, and
 * under MCP_SKIP_AUTH the core doors have no bearer behind them. YAAR's MCP clients are
 * CLIs, which send no Origin — so the rule costs them nothing, and these rows pin both
 * halves: a foreign Origin is a 403 before any door runs, and no Origin (or the
 * desktop's own) reaches the door as before.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import type { Server } from 'bun';
import { createFetchHandler } from '../http/server.js';
import { getPort } from '../config.js';
import type { WsData } from '../websocket/server.js';

let handle: ReturnType<typeof createFetchHandler>;

beforeAll(() => {
  handle = createFetchHandler();
});

async function post(path: string, origin?: string): Promise<Response> {
  const req = new Request(`http://localhost:${getPort()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const res = await handle(req, undefined as unknown as Server<WsData>);
  if (!res) throw new Error(`handler returned nothing for ${path}`);
  return res;
}

describe('/mcp/ Origin validation', () => {
  for (const path of ['/mcp/verbs', '/mcp/app', '/mcp/window/not-a-real-token']) {
    it(`refuses a foreign Origin at ${path}`, async () => {
      const res = await post(path, 'http://evil.example');
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Origin not allowed');
    });

    it(`lets a request with no Origin reach the door at ${path}`, async () => {
      const res = await post(path);
      expect(res.status).not.toBe(403);
    });
  }

  it("lets the desktop's own origin through", async () => {
    const res = await post('/mcp/window/not-a-real-token', `http://localhost:${getPort()}`);
    // The door itself answers (uninitialized here, so 503) — not the Origin gate's 403.
    expect(res.status).not.toBe(403);
  });

  it('leaves non-MCP routes to their own CORS rules', async () => {
    const res = await handle(
      new Request(`http://localhost:${getPort()}/health`, {
        headers: { origin: 'http://evil.example' },
      }),
      undefined as unknown as Server<WsData>,
    );
    expect(res?.status).not.toBe(403);
  });
});
