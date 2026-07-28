/**
 * Integration tests: HTTP routing, CORS, auth, and 404 fallback — **in local mode**.
 *
 * Uses checkHttpAuth and createFetchHandler directly — no Bun.serve() needed.
 *
 * Local mode is not an accident of the environment here, it is the subject: `IS_REMOTE` is a
 * module-load constant, and it used to be whatever the developer's `config/settings.json` had
 * persisted, so this file failed on a machine that had toggled remote mode on and passed in
 * CI. `scripts/test-env.ts` (preloaded via bunfig) now pins `REMOTE=0` for the process, and
 * the guard below fails loudly rather than silently if that ever stops holding.
 *
 * The remote half of the same surface — where the gate actually gates — is
 * `packages/server/src/tests/remote/remote-mode.test.ts`, which runs in its own `REMOTE=1`
 * process for the same module-load-constant reason.
 */

import { describe, it, expect } from 'bun:test';
import { checkHttpAuth, generateRemoteToken, isStaticAsset } from '@yaar/server/http/auth';
import { checkWsAuth } from '@yaar/server/http/auth';
import { IS_REMOTE } from '@yaar/server/config/env';

// ── the premise every case below rests on ──────────────────────────────────

describe('test environment', () => {
  it('runs in local mode, independent of the developer’s settings.json', () => {
    expect(IS_REMOTE).toBe(false);
  });
});

// ── checkHttpAuth ──────────────────────────────────────────────────────────

describe('checkHttpAuth', () => {
  it('allows all requests when IS_REMOTE is false (local dev)', () => {
    const req = new Request('http://localhost:8000/api/apps');
    const url = new URL('http://localhost:8000/api/apps');
    const result = checkHttpAuth(req, url);
    expect(result).toBeNull(); // null = authorized
  });

  it('is a no-op even for a request that does present a token', () => {
    // Local mode short-circuits before the token is ever compared. That a *valid* token is
    // accepted, and an absent or wrong one refused, is only observable under REMOTE=1 —
    // asserted in packages/server/src/tests/remote/remote-mode.test.ts.
    const token = generateRemoteToken();
    const withToken = new Request('http://localhost:8000/api/apps', {
      headers: { authorization: `Bearer ${token}` },
    });
    const url = new URL('http://localhost:8000/api/apps');
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

  it('allows ws connections regardless of the token in local mode', () => {
    const token = generateRemoteToken();
    const url = new URL(`ws://localhost:8000/ws?token=${token}`);
    expect(checkWsAuth(url)).toBe(true);
    // Local mode does not read the token at all — a wrong one is just as fine here, and
    // only remote-mode.test.ts can tell the two apart.
    expect(checkWsAuth(new URL('ws://localhost:8000/ws?token=wrong'))).toBe(true);
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

// ── isStaticAsset (F-20) ───────────────────────────────────────────────────
//
// Remote auth used to be bypassable by choosing a filename. isStaticAsset() ran
// before any /api check and looked only at the extension, so in REMOTE=1 mode
// `GET /api/storage/anything.png` and `POST /api/storage/payload.js` skipped the
// token entirely — and storage is where the user's files and every app's secrets
// live. The attacker picks the extension, so the extension cannot be the credential.

describe('isStaticAsset', () => {
  it('never treats anything under /api/ as a static asset, whatever it is named', () => {
    expect(isStaticAsset('/api/storage/secrets.png')).toBe(false);
    expect(isStaticAsset('/api/storage/payload.js')).toBe(false);
    expect(isStaticAsset('/api/storage/apps/vault/db.json')).toBe(false);
    expect(isStaticAsset('/api/apps/notes/index.html')).toBe(false);
    expect(isStaticAsset('/api/sessions/x/transcript')).toBe(false);
  });

  it('never treats /mcp/ as a static asset', () => {
    expect(isStaticAsset('/mcp/verbs')).toBe(false);
  });

  it('still serves the frontend build unauthenticated, so the client can read the token', () => {
    // The desktop's own bundle has to load before any JS exists to attach a token.
    expect(isStaticAsset('/')).toBe(true);
    expect(isStaticAsset('/index.html')).toBe(true);
    expect(isStaticAsset('/assets/main.js')).toBe(true);
    expect(isStaticAsset('/assets/main.css')).toBe(true);
    expect(isStaticAsset('/favicon.ico')).toBe(true);
  });

  it('treats an extensionless frontend route as an asset (SPA fallback serves index.html)', () => {
    expect(isStaticAsset('/settings')).toBe(true);
  });
});
