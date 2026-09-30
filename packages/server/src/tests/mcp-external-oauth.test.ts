/**
 * Signing in to an OAuth-protected external MCP server, end to end.
 *
 * One `Bun.serve` plays both the MCP server (401 until it sees its token, then a real SDK
 * handler) and its authorization server (RFC 9728 + RFC 8414 metadata, dynamic
 * registration, a consent endpoint that approves at once, a PKCE-checking token endpoint).
 * The test plays the user's browser: it follows the consent URL `login` answers and hands
 * the redirect to the real callback route. Nothing in the SDK's flow is stubbed, so this
 * pins what YAAR adds around it — the persisted credentials, the captured consent URL,
 * the single-use state, and the status an agent reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { stat } from 'fs/promises';
import { join } from 'path';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { getMcpClientManager } from '../mcp/external/index.js';
import { handleAuthRoutes } from '../http/routes/auth.js';
import { getConfigDir } from '../config.js';

const SERVER = 'fake-oauth';
const ACCESS_TOKEN = 'at-123';

let fake: ReturnType<typeof Bun.serve>;
let base: string;
/** The PKCE challenge the consent endpoint saw, checked at the token endpoint. */
let challenge = '';
let registrations = 0;

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('echo', { description: 'says hi' }, async () => ({
    content: [{ type: 'text', text: 'hi' }],
  }));
  return server;
});

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (path === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (path === '/register' && req.method === 'POST') {
        registrations++;
        const metadata = (await req.json()) as Record<string, unknown>;
        return Response.json({ ...metadata, client_id: 'client-1' }, { status: 201 });
      }
      if (path === '/authorize') {
        // The user approves at once.
        challenge = url.searchParams.get('code_challenge') ?? '';
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'code-1');
        back.searchParams.set('state', url.searchParams.get('state')!);
        back.searchParams.set('iss', base);
        return Response.redirect(back.href, 302);
      }
      if (path === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await req.text());
        const ok =
          form.get('grant_type') === 'authorization_code' &&
          form.get('code') === 'code-1' &&
          (await s256(form.get('code_verifier') ?? '')) === challenge;
        if (!ok) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({
          access_token: ACCESS_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'rt-1',
        });
      }
      if (path === '/mcp') {
        if (req.headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) {
          return new Response('unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        return mcp.fetch(req);
      }
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${fake.port}`;
});

afterAll(async () => {
  const manager = await getMcpClientManager();
  await manager.removeServer(SERVER);
  fake.stop(true);
});

/** Play the browser: follow the consent URL, then deliver its redirect to YAAR's callback. */
async function approve(authUrl: string): Promise<Response> {
  const consent = await fetch(authUrl, { redirect: 'manual' });
  const callback = new URL(consent.headers.get('location')!);
  return (await handleAuthRoutes(new Request(callback.href), callback))!;
}

describe('external MCP OAuth', () => {
  let authUrl = '';
  let callbackUrl: URL;

  it('reports sign-in required instead of a bare connection failure', async () => {
    const manager = await getMcpClientManager();
    await manager.addServer(SERVER, { type: 'http', url: `${base}/mcp` });

    await expect(manager.listTools(SERVER)).rejects.toThrow(/Sign-in required/);
    expect(manager.getStatus(SERVER)).toMatchObject({ state: 'error', auth: 'required' });
  });

  it('login answers a consent URL that redirects back to this server', async () => {
    const manager = await getMcpClientManager();
    const answer = await manager.beginAuth(SERVER);
    authUrl = answer.authUrl!;

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(new URL(url.searchParams.get('redirect_uri')!).pathname).toBe('/api/auth/mcp/callback');
    expect(registrations).toBe(1);
  });

  it('the callback exchanges the code, persists 0600 credentials, and the server works', async () => {
    const consent = await fetch(authUrl, { redirect: 'manual' });
    callbackUrl = new URL(consent.headers.get('location')!);
    const page = (await handleAuthRoutes(new Request(callbackUrl.href), callbackUrl))!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Signed in');

    const manager = await getMcpClientManager();
    const tools = await manager.listTools(SERVER, true);
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(manager.getStatus(SERVER)).toMatchObject({ state: 'connected', auth: 'signed_in' });

    const file = join(getConfigDir(), 'credentials', 'mcp', `${SERVER}.json`);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('a replayed callback is refused — the state was spent', async () => {
    const page = (await handleAuthRoutes(new Request(callbackUrl.href), callbackUrl))!;
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('expired or was already used');
  });

  it('logout forgets the tokens, and the server asks again', async () => {
    const manager = await getMcpClientManager();
    await manager.signOut(SERVER);
    await expect(
      stat(join(getConfigDir(), 'credentials', 'mcp', `${SERVER}.json`)),
    ).rejects.toThrow();
    await expect(manager.listTools(SERVER, true)).rejects.toThrow(/Sign-in required/);

    // And signing in again works from a clean slate (fresh registration included).
    const { authUrl: again } = await manager.beginAuth(SERVER);
    expect((await approve(again!)).status).toBe(200);
    expect((await manager.listTools(SERVER, true)).map((t) => t.name)).toEqual(['echo']);
  });
});

describe('OAuth callback page', () => {
  it('escapes what it echoes — the page is on the desktop origin with no auth', async () => {
    const url = new URL(
      'http://127.0.0.1/api/auth/google/callback?error=<script>alert(1)</script>',
    );
    const page = (await handleAuthRoutes(new Request(url.href), url))!;
    const html = await page.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
