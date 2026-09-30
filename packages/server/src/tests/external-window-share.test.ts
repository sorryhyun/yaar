/**
 * A window the user shared is reachable from outside at `/mcp/x/{token}`, for exactly as
 * long as it is shared — and what the URL opens is the window's app-agent tool set.
 *
 * The lifetime rows are the security claim: the token lives on the window's side record,
 * so a close revokes it, and a reopened window with the same id (`notes` again) starts
 * unshared. The endpoint rows drive the real handler with the real SDK client, the same
 * way `mcp-protocol-eras.test.ts` does, because a hand-built Request would let the
 * classifier see a shape no client sends.
 */
import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OSAction } from '@yaar/shared';
import { handleExternalMcpRequest, initMcpServer } from '../mcp/server.js';
import { EXTERNAL_MCP_PREFIX, setWindowShared } from '../features/window/external-share.js';
import { WindowStateRegistry } from '../session/window-state.js';
import { getSessionHub } from '../session/session-hub.js';
import type { LiveSession } from '../session/live-session.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'ses-external-share' as SessionId;

function create(windowId: string, appId?: string): OSAction {
  return {
    type: 'window.create',
    windowId,
    title: windowId,
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    content: appId
      ? { renderer: 'iframe', data: `/api/apps/${appId}/dist/index.html` }
      : { renderer: 'markdown', data: 'hi' },
    ...(appId ? { appId } : {}),
  } as OSAction;
}

function close(windowId: string): OSAction {
  return { type: 'window.close', windowId } as OSAction;
}

describe('share lifetime (WindowStateRegistry)', () => {
  it('answers one stable token while shared, and resolves it to the window', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(create('notes', 'notes'), '0');
    const token = reg.shareExternally('0/notes');
    expect(token).toBeString();
    // A second share (another tab's click) must not invalidate a URL already handed out.
    expect(reg.shareExternally('0/notes')).toBe(token);
    expect(reg.findExternalShare(token!)).toBe('0/notes');
    expect(reg.listExternallyShared()).toEqual(['0/notes']);
  });

  it('unsharing revokes the token', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(create('notes', 'notes'), '0');
    const token = reg.shareExternally('0/notes')!;
    expect(reg.unshareExternally('0/notes')).toBe(true);
    expect(reg.findExternalShare(token)).toBeUndefined();
    expect(reg.unshareExternally('0/notes')).toBe(false);
  });

  it('closing the window revokes the token, and a reopened window starts unshared', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(create('notes', 'notes'), '0');
    const token = reg.shareExternally('0/notes')!;
    reg.handleAction(close('0/notes'), '0');
    expect(reg.findExternalShare(token)).toBeUndefined();

    // Same raw id, same monitor, same handle — a different window.
    reg.handleAction(create('notes', 'notes'), '0');
    expect(reg.getExternalShareToken('0/notes')).toBeUndefined();
    expect(reg.findExternalShare(token)).toBeUndefined();
  });

  it('refuses to share a window that does not exist yet', () => {
    // A record filed before its window is adopted by whichever window next takes the id.
    const reg = new WindowStateRegistry();
    expect(reg.shareExternally('0/notes')).toBeUndefined();
    reg.handleAction(create('notes', 'notes'), '0');
    expect(reg.getExternalShareToken('0/notes')).toBeUndefined();
  });

  it('does not resolve a token of the wrong length or a near miss', () => {
    const reg = new WindowStateRegistry();
    reg.handleAction(create('notes', 'notes'), '0');
    const token = reg.shareExternally('0/notes')!;
    expect(reg.findExternalShare('')).toBeUndefined();
    expect(reg.findExternalShare(token.slice(1))).toBeUndefined();
    expect(
      reg.findExternalShare(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`),
    ).toBeUndefined();
  });
});

describe('/mcp/x/{token}', () => {
  let session: LiveSession;

  beforeAll(async () => {
    await initMcpServer();
  });

  afterEach(async () => {
    await getSessionHub().remove(SESSION);
  });

  function openSession(): LiveSession {
    session = getSessionHub().attach(SESSION, {}).session;
    return session;
  }

  function serve() {
    return Bun.serve({
      port: 0,
      idleTimeout: 30,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        return handleExternalMcpRequest(req, path.slice(EXTERNAL_MCP_PREFIX.length));
      },
    });
  }

  async function listTools(token: string): Promise<string[]> {
    const server = serve();
    const client = new Client(
      { name: 'external-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${token}`),
        ),
      );
      const tools = await client.listTools();
      await client.close();
      return tools.tools.map((t) => t.name).sort();
    } finally {
      server.stop(true);
    }
  }

  async function status(token: string): Promise<number> {
    const server = serve();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${token}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      return res.status;
    } finally {
      server.stop(true);
    }
  }

  it("serves the app agent's tools, and nothing from the verbs namespace", async () => {
    const s = openSession();
    s.windowState.handleAction(create('notes', 'notes'), '0');
    const shared = setWindowShared(s, '0/notes', true);
    if (!shared.ok || !shared.token) throw new Error('share failed');

    const names = await listTools(shared.token);
    expect(names).toEqual(['command', 'describe', 'direct_message', 'query', 'relay']);
  });

  it("acts as the window's app agent: its own storage, and not past the commons", async () => {
    const s = openSession();
    s.windowState.handleAction(create('notes', 'notes'), '0');
    const shared = setWindowShared(s, '0/notes', true);
    if (!shared.ok || !shared.token) throw new Error('share failed');

    const server = serve();
    const client = new Client(
      { name: 'external-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${shared.token}`),
        ),
      );
      const text = (r: unknown) =>
        ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

      // The app's own tree — the one only this window's app agent reaches without a grant.
      const wrote = await client.callTool({
        name: 'command',
        arguments: { command: 'storage:write', params: { path: 'hello.txt', content: 'hi' } },
      });
      expect(wrote.isError).toBeFalsy();
      const read = await client.callTool({
        name: 'query',
        arguments: { stateKey: 'storage/hello.txt' },
      });
      expect(text(read)).toContain('hi');

      // Past the commons needs an app.json grant `notes` does not hold.
      const denied = await client.callTool({
        name: 'command',
        arguments: {
          command: 'storage:write',
          params: { path: 'yaar://storage/private/x.txt', content: 'no' },
        },
      });
      expect(denied.isError).toBe(true);
      await client.close();
    } finally {
      server.stop(true);
    }
  });

  it('answers 404 for an unknown token, an unshared window and a closed one', async () => {
    const s = openSession();
    s.windowState.handleAction(create('notes', 'notes'), '0');
    expect(await status('not-a-token')).toBe(404);

    const first = setWindowShared(s, '0/notes', true);
    if (!first.ok || !first.token) throw new Error('share failed');
    setWindowShared(s, '0/notes', false);
    expect(await status(first.token)).toBe(404);

    const second = setWindowShared(s, '0/notes', true);
    if (!second.ok || !second.token) throw new Error('share failed');
    expect(second.token).not.toBe(first.token);
    s.windowState.handleAction(close('0/notes'), '0');
    expect(await status(second.token)).toBe(404);
  });

  it('answers a URL on the plain loopback socket, never the TLS one', async () => {
    const s = openSession();
    s.windowState.handleAction(create('notes', 'notes'), '0');
    const { handleWindowShareRoutes } = await import('../http/routes/window-share.js');
    const url = new URL('http://localhost/api/window-share');
    const res = await handleWindowShareRoutes(
      new Request(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ windowId: '0/notes', sessionId: SESSION, shared: true }),
      }),
      url,
    );
    const body = (await res!.json()) as { shared: boolean; path: string; localUrl: string };
    expect(body.shared).toBe(true);
    // An MCP client in Node/Bun refuses the local TLS socket's self-signed certificate.
    expect(body.localUrl).toStartWith('http://127.0.0.1:');
    expect(body.localUrl).toEndWith(body.path);
  });

  it('shares app windows only', () => {
    const s = openSession();
    s.windowState.handleAction(create('readme'), '0');
    expect(setWindowShared(s, '0/readme', true)).toEqual({
      ok: false,
      error: 'Only app windows can be shared.',
    });
  });
});
