/**
 * App-origin isolation, Stage 2 — the origin boundary becomes enforcing.
 *
 * Stage 1 stood the boundary up (installed apps served from the 127.0.0.1 alias)
 * but changed no enforcement: `resolvePrincipal` still read "no token" as the host,
 * so a hostile app could omit its token and be promoted. Stage 2 closes that: a
 * token-less request that carries the *app* origin is refused, never host.
 *
 * The invariant has two unspoofable faces, one per escape (docs/architecture/known_gaps.md):
 *   #1  a browser-set `Origin` of the app alias  — a cross-origin, SDK-shaped fetch
 *   #2  a request that lands on the app alias     — a relative fetch from the app
 *
 * These rows lock both, plus the two things that must NOT change: the desktop is
 * still host, and a well-behaved app (one that presents its token) is still an app.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { resolvePrincipal } from '../http/access.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';

const FLAG = 'YAAR_APP_ORIGIN_ISOLATION';

/** Run resolvePrincipal the way a route does, from a fully-formed request. */
function resolve(rawUrl: string, headers: Record<string, string> = {}) {
  const req = new Request(rawUrl, { headers });
  return resolvePrincipal(req, new URL(req.url));
}

afterEach(() => {
  delete process.env[FLAG];
});

describe('app-origin isolation (Stage 2 enforcement)', () => {
  describe('explicitly disabled (=0) — inert, behavior is exactly as before', () => {
    it('reads a token-less request landing on 127.0.0.1 as the host', () => {
      process.env[FLAG] = '0';
      const p = resolve('http://127.0.0.1:8000/api/storage/x');
      expect(p).not.toBeInstanceOf(Response);
      expect((p as { kind: string }).kind).toBe('host');
    });

    it('reads a token-less request with a 127.0.0.1 Origin as the host', () => {
      process.env[FLAG] = '0';
      const p = resolve('http://localhost:8000/api/storage/x', {
        origin: 'http://127.0.0.1:8000',
      });
      expect(p).not.toBeInstanceOf(Response);
      expect((p as { kind: string }).kind).toBe('host');
    });
  });

  describe('default (no env, local mode) — enforcing', () => {
    it('refuses a token-less request landing on the app alias with no flag set', () => {
      // The flip: absent YAAR_APP_ORIGIN_ISOLATION now means on (local mode).
      const p = resolve('http://127.0.0.1:8000/api/storage/x');
      expect(p).toBeInstanceOf(Response);
      expect((p as Response).status).toBe(403);
    });
  });

  describe('flag on — the app origin can no longer pass as the host', () => {
    it('#1 refuses a token-less cross-origin request wearing the app Origin', () => {
      process.env[FLAG] = '1';
      const p = resolve('http://localhost:8000/api/storage/x', {
        origin: 'http://127.0.0.1:8000',
      });
      expect(p).toBeInstanceOf(Response);
      expect((p as Response).status).toBe(403);
    });

    it('#2 refuses a token-less request that landed on the app alias', () => {
      process.env[FLAG] = '1';
      // A relative fetch from the app: same-origin to 127.0.0.1, so no Origin header.
      const p = resolve('http://127.0.0.1:8000/api/storage/x');
      expect(p).toBeInstanceOf(Response);
      expect((p as Response).status).toBe(403);
    });

    it('still reads the desktop (localhost, no app origin) as the host', () => {
      process.env[FLAG] = '1';
      // The desktop's own same-origin POST carries Origin: localhost, not the app alias.
      const p = resolve('http://localhost:8000/api/storage/x', {
        origin: 'http://localhost:8000',
      });
      expect(p).not.toBeInstanceOf(Response);
      expect((p as { kind: string }).kind).toBe('host');
    });

    it('does not refuse a well-behaved app: a valid token wins even on the app alias', async () => {
      process.env[FLAG] = '1';
      const token = await generateAppIframeToken('win-1', 'sess-1', {
        appId: 'notes',
        permissions: ['yaar://apps/self/storage/'],
      });
      // The app document / a subresource rides the token in the query on 127.0.0.1.
      const p = resolve(`http://127.0.0.1:8000/api/storage/apps/notes/x?__yaar_token=${token}`);
      expect(p).not.toBeInstanceOf(Response);
      expect((p as { kind: string; appId?: string }).kind).toBe('app');
      expect((p as { appId?: string }).appId).toBe('notes');
    });

    it('does not refuse an app SDK call: a token header wins on a cross-origin request', async () => {
      process.env[FLAG] = '1';
      const token = await generateAppIframeToken('win-1', 'sess-1', { appId: 'notes' });
      // SDK calls the desktop (localhost) cross-origin, Origin: app alias, token in header.
      const p = resolve('http://localhost:8000/api/verb', {
        origin: 'http://127.0.0.1:8000',
        'x-iframe-token': token,
      });
      expect(p).not.toBeInstanceOf(Response);
      expect((p as { kind: string }).kind).toBe('app');
    });
  });
});
