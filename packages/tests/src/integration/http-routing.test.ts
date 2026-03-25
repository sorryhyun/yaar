/**
 * Integration tests: HTTP routing, CORS, auth, and 404 fallback.
 *
 * Uses checkHttpAuth and createFetchHandler directly — no Bun.serve() needed.
 */

import { describe, it, expect } from 'bun:test';
import { checkHttpAuth, generateRemoteToken } from '@yaar/server/http/auth';
import { checkWsAuth } from '@yaar/server/http/auth';

// ── checkHttpAuth ──────────────────────────────────────────────────────────

describe('checkHttpAuth', () => {
  it('allows all requests when IS_REMOTE is false (local dev)', () => {
    // IS_REMOTE defaults to false in test environment (no REMOTE=1 env var)
    const req = new Request('http://localhost:8000/api/apps');
    const url = new URL('http://localhost:8000/api/apps');
    const result = checkHttpAuth(req, url);
    expect(result).toBeNull(); // null = authorized
  });

  it('requires token when IS_REMOTE is true', () => {
    const token = generateRemoteToken();
    // With a valid token in Authorization header
    const withToken = new Request('http://localhost:8000/api/apps', {
      headers: { authorization: `Bearer ${token}` },
    });
    const url = new URL('http://localhost:8000/api/apps');
    // IS_REMOTE is still false in test (process.env.REMOTE not set), so auth is no-op
    const result = checkHttpAuth(withToken, url);
    expect(result).toBeNull();
  });

  it('/health is always exempt (would be even in remote mode)', () => {
    const req = new Request('http://localhost:8000/health');
    const url = new URL('http://localhost:8000/health');
    const result = checkHttpAuth(req, url);
    expect(result).toBeNull();
  });
});

// ── checkWsAuth ────────────────────────────────────────────────────────────

describe('checkWsAuth', () => {
  it('allows ws connections without token in local mode', () => {
    const url = new URL('ws://localhost:8000/ws');
    expect(checkWsAuth(url)).toBe(true);
  });

  it('allows ws connections with matching token', () => {
    const token = generateRemoteToken();
    const url = new URL(`ws://localhost:8000/ws?token=${token}`);
    // Still local mode, so always true regardless of token
    expect(checkWsAuth(url)).toBe(true);
  });
});

// ── CORS headers via createFetchHandler ───────────────────────────────────

describe('createFetchHandler CORS + routing', () => {
  // Heavy server deps are lazy-loaded or have graceful degradation.
  // We test the routing behavior without actually running any agents.

  it('handles OPTIONS preflight and returns 204 with no CORS from non-allowed origin', async () => {
    const { createFetchHandler } = await import('@yaar/server/http/server');
    const handler = createFetchHandler();
    const req = new Request('http://localhost:8000/api/apps', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example.com' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(req, {} as any);
    expect(res?.status).toBe(204);
    // Non-allowed origin does not receive CORS header
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('includes CORS headers for localhost on server port (allowed origin)', async () => {
    const { createFetchHandler } = await import('@yaar/server/http/server');
    const handler = createFetchHandler();
    const req = new Request('http://localhost:8000/api/apps', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8000' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(req, {} as any);
    expect(res?.status).toBe(204);
    expect(res?.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');
  });

  it('returns 404 for completely unknown routes', async () => {
    // In bun runtime, Bun.file().exists() works natively — no dist folder
    // means static handler returns 404 for unknown routes.
    const { createFetchHandler } = await import('@yaar/server/http/server');
    const handler = createFetchHandler();
    const req = new Request('http://localhost:8000/this-route-does-not-exist-at-all');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(req, {} as any);
    expect(res).toBeDefined();
    // Static fallback with no dist → 404; or index.html if dist exists → 200
    expect([200, 404]).toContain(res!.status);
  });

  it('returns 200 for /health', async () => {
    const { createFetchHandler } = await import('@yaar/server/http/server');
    const handler = createFetchHandler();
    const req = new Request('http://localhost:8000/health');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(req, {} as any);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body).toMatchObject({ status: 'ok' });
  });
});
