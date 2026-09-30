/**
 * A window the user shared is reachable from outside at `/mcp/window/{token}`, for exactly as
 * long as it is shared — and what the URL opens is the window's app-agent tool set.
 *
 * The lifetime rows are the security claim: the token lives on the window's side record,
 * so a close revokes it, and a reopened window with the same id (`notes` again) starts
 * unshared. The endpoint rows drive the real handler with the real SDK client, the same
 * way `mcp-protocol-eras.test.ts` does, because a hand-built Request would let the
 * classifier see a shape no client sends.
 */
import { describe, it, expect, beforeAll, afterEach, spyOn } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OSAction } from '@yaar/shared';
import { handleExternalMcpRequest, initMcpServer } from '../mcp/server.js';
import { EXTERNAL_MCP_PREFIX, setWindowShared } from '../features/window/external-share.js';
import { singleCopy } from '../mcp/external-result.js';
import { refuseIncomplete, withGuide } from '../mcp/external-help.js';
import { prependNote } from '../lib/verb-result.js';
import { WindowStateRegistry } from '../session/window-state.js';
import { getSessionHub } from '../session/session-hub.js';
import { actionEmitter } from '../session/action-emitter.js';
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

describe('/mcp/window/{token}', () => {
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

  it('refuses an argument the tool does not declare, naming where it belongs', async () => {
    // A plain z.object strips an unknown key: `expectVersion` beside `params` used to be
    // dropped and the command ran with its stale-id guard silently off.
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

      const listed = await client.listTools();
      const command = listed.tools.find((t) => t.name === 'command');
      expect(command?.inputSchema.additionalProperties).toBe(false);

      const refused = await client.callTool({
        name: 'command',
        arguments: {
          command: 'storage:write',
          params: { path: 'strict.txt', content: 'x' },
          expectVersion: 'v1',
        },
      });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('unknown argument "expectVersion"');
      expect(text(refused)).toContain('params.expectVersion');

      // And the command did not run.
      const read = await client.callTool({
        name: 'query',
        arguments: { stateKey: 'storage/strict.txt' },
      });
      expect(read.isError).toBe(true);
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

  /** Share `notes` and open a real SDK client on its URL. */
  async function connect(): Promise<{ client: Client; done: () => Promise<void> }> {
    const s = openSession();
    s.windowState.handleAction(create('notes', 'notes'), '0');
    const shared = setWindowShared(s, '0/notes', true);
    if (!shared.ok || !shared.token) throw new Error('share failed');
    const server = serve();
    const client = new Client(
      { name: 'external-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${shared.token}`),
      ),
    );
    return {
      client,
      done: async () => {
        await client.close();
        server.stop(true);
      },
    };
  }

  it('answers __screenshot from a capture of the window, without asking the app', async () => {
    // The app agent's `query` used to hand every key to the iframe, which has never heard of
    // `__screenshot` — so the one agent driving a window could not look at it. No iframe
    // answers in this test: a query that reached the app would wait out its readiness
    // deadline instead of returning the picture.
    //
    // Driven through the session's real delivery, with this spy standing in for the desktop:
    // an `external:*` caller is no pool agent, and the capture it emitted used to be dropped
    // before it was broadcast — five seconds of silence, then `no-response`.
    const { client, done } = await connect();
    const delivered: { action: Record<string, unknown>; monitorId?: string }[] = [];
    const desktop = spyOn(session, 'broadcast').mockImplementation((event) => {
      const { actions, monitorId } = event as {
        actions?: Record<string, unknown>[];
        monitorId?: string;
      };
      for (const action of actions ?? []) {
        if (action.type !== 'window.capture') continue;
        delivered.push({ action, monitorId });
        queueMicrotask(() =>
          actionEmitter.resolveFeedback({
            requestId: action.requestId as string,
            windowId: action.windowId as string,
            renderer: 'capture',
            success: true,
            imageData: 'Y2FwdHVyZWQtcGl4ZWxz',
          }),
        );
      }
    });
    try {
      const result = await client.callTool({
        name: 'query',
        arguments: { stateKey: '__screenshot' },
      });
      expect(result.isError).toBeFalsy();
      const image = (result.content as { type: string; data?: string }[]).find(
        (c) => c.type === 'image',
      );
      expect(image?.data).toBe('Y2FwdHVyZWQtcGl4ZWxz');
      expect(delivered).toHaveLength(1);
      expect(delivered[0].action).toMatchObject({ type: 'window.capture', windowId: '0/notes' });
      expect(delivered[0].monitorId).toBe('0');
    } finally {
      desktop.mockRestore();
      await done();
    }
  });

  it('answers __content from the registry, and says both keys exist', async () => {
    const { client, done } = await connect();
    try {
      const result = await client.callTool({ name: 'query', arguments: { stateKey: '__content' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain('/api/apps/notes/dist/index.html');

      // Discoverable from the tool itself — an outside agent never sees the app agent's prompt.
      const { tools } = await client.listTools();
      const query = tools.find((t) => t.name === 'query');
      const param = JSON.stringify(query?.inputSchema);
      expect(param).toContain('__screenshot');
      expect(param).toContain('__content');
    } finally {
      await done();
    }
  });

  it('answers an object once, as compact JSON in content, with no structuredContent', async () => {
    // Inside YAAR the same answer carries the object twice; an outside client may read both.
    const { client, done } = await connect();
    try {
      const result = await client.callTool({
        name: 'command',
        arguments: { command: 'storage:write', params: { path: 'once.txt', content: 'hi' } },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeUndefined();
      const blocks = result.content as { type: string; text?: string }[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text).not.toContain('\n');
      expect(JSON.parse(blocks[0].text!)).toMatchObject({ path: 'app/once.txt', written: true });
    } finally {
      await done();
    }
  });

  describe('GET', () => {
    async function get(token: string, accept?: string): Promise<Response> {
      const server = serve();
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${token}`, {
          headers: accept ? { accept } : {},
        });
        await res.clone().arrayBuffer();
        return res;
      } finally {
        server.stop(true);
      }
    }

    function share(): string {
      const s = openSession();
      s.windowState.handleAction(create('notes', 'notes'), '0');
      const shared = setWindowShared(s, '0/notes', true);
      if (!shared.ok || !shared.token) throw new Error('share failed');
      return shared.token;
    }

    it('describes the endpoint instead of answering 405', async () => {
      const token = share();
      const res = await get(token, 'text/markdown');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const page = await res.text();
      expect(page).toContain('`notes` app');
      expect(page).toContain('2026-07-28');
      expect(page).toContain('Mcp-Method');
      expect(page).toContain("-H 'MCP-Protocol-Version: 2026-07-28'");
      expect(page).toContain('claude mcp add --transport http yaar-notes http://127.0.0.1:');
      expect(page).toContain(`${EXTERNAL_MCP_PREFIX}${token}`);
      // The tool list is the endpoint's own, not a copy.
      for (const tool of ['command', 'describe', 'direct_message', 'query', 'relay']) {
        expect(page).toContain(`- \`${tool}\``);
      }
      expect(page).toContain('the window is closed');
    });

    it('shows a browser plain text, which every browser renders', async () => {
      const res = await get(share(), 'text/html,application/xhtml+xml,*/*;q=0.8');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('still refuses a GET asking for an event stream', async () => {
      expect((await get(share(), 'text/event-stream')).status).toBe(405);
    });

    it('answers 404 for a token that opens nothing', async () => {
      openSession();
      expect((await get('not-a-token', 'text/html')).status).toBe(404);
    });

    it('documents a raw request that the endpoint really accepts', async () => {
      // The page's curl, in fetch form: exactly the headers and envelope it names, no more.
      const token = share();
      const server = serve();
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${token}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/list',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { result?: { tools?: unknown[] } };
        expect(body.result?.tools?.length).toBe(5);
      } finally {
        server.stop(true);
      }
    });

    it('refuses an incomplete raw request once, naming every gap and the guide', async () => {
      // A bare JSON-RPC call used to take four 400s to get right — one condition each, the
      // first of them advice about CLI opt-in gates.
      const token = share();
      const server = serve();
      const url = `http://127.0.0.1:${server.port}${EXTERNAL_MCP_PREFIX}${token}`;
      const post = (headers: Record<string, string>, body: unknown) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
      try {
        const bare = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'describe' } };
        const res = await post({}, bare);
        expect(res.status).toBe(400);
        const { error, id } = (await res.json()) as {
          id: unknown;
          error: { message: string; data: { missing: string[]; guide: string } };
        };
        expect(id).toBe(7);
        expect(error.data.guide).toBe(url);
        expect(error.data.missing).toHaveLength(5);
        for (const needed of [
          'MCP-Protocol-Version: 2026-07-28',
          'Mcp-Method: tools/call',
          'Mcp-Name: describe',
          'io.modelcontextprotocol/protocolVersion',
          'io.modelcontextprotocol/clientCapabilities',
        ]) {
          expect(error.message).toContain(needed);
        }
        expect(error.message).toEndWith(
          `GET ${url} for the raw-request guide, with working curl examples.`,
        );
        expect(error.message).not.toContain('MCP_SDK_GENERATION');

        // Doing exactly what that one answer said is enough.
        const fixed = await post(
          {
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call',
            'mcp-name': 'describe',
          },
          {
            ...bare,
            params: {
              ...bare.params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          },
        );
        expect(fixed.status).toBe(200);

        const init = await post({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        expect(init.status).toBe(400);
        expect(((await init.json()) as { error: { message: string } }).error.message).toContain(
          'stateless',
        );
      } finally {
        server.stop(true);
      }
    });
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

describe('singleCopy', () => {
  it('keeps non-text blocks, carries notes inside the object, and leaves text answers alone', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/webp' };
    const answer = singleCopy(
      prependNote(
        { content: [image, { type: 'text', text: '{\n  "a": 1\n}' }], structuredContent: { a: 1 } },
        'paged',
      ),
    );
    expect(answer).not.toHaveProperty('structuredContent');
    expect(answer).not.toHaveProperty('notes');
    expect(answer.content).toEqual([image, { type: 'text', text: '{"_notes":["paged"],"a":1}' }]);

    const plain = { content: [{ type: 'text' as const, text: 'Done.' }] };
    expect(singleCopy(plain)).toBe(plain);
  });
});

describe('withGuide', () => {
  it("appends the pointer to a handler's 400, once, and leaves anything else alone", async () => {
    const sdk = Response.json(
      { jsonrpc: '2.0', error: { code: -32020, message: 'Bad Request: x' }, id: 1 },
      { status: 400 },
    );
    const guided = (await (await withGuide(sdk, 'http://h/mcp/window/t')).json()) as {
      error: { message: string; data: { guide: string } };
    };
    expect(guided.error.message).toBe(
      'Bad Request: x GET http://h/mcp/window/t for the raw-request guide, with working curl examples.',
    );
    expect(guided.error.data.guide).toBe('http://h/mcp/window/t');

    const already = refuseIncomplete('http://h/mcp/window/t', 1, ['a']);
    expect(await withGuide(already, 'http://h/mcp/window/t')).toBe(already);
    const fine = Response.json({ result: {} });
    expect(await withGuide(fine, 'http://h/mcp/window/t')).toBe(fine);
  });
});
