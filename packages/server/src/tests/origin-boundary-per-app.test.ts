/**
 * The `loopback-subdomain` boundary: each installed app on its own `<appId>.localhost`
 * origin (`YAAR_PER_APP_ORIGIN=1`, docs/proposals/app_site_isolation_proposal.md).
 *
 * Three things it has to hold:
 *   - every `*.localhost` is app side, never the desktop — and the shared `127.0.0.1`
 *     alias still is too, for the client that fell back to it;
 *   - a token is held to the app it was minted for, on both faces of a request (the
 *     `Origin` that called, and the host it landed on);
 *   - an app's SDK calls from its own origin still reach the desktop API (CORS), while
 *     the /mcp/ doors stay closed to it.
 *
 * On by default; `=0` turns it off, and then nothing here changes `loopback-alias`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import type { Server } from 'bun';
import { createFetchHandler } from '../http/server.js';
import { resolvePrincipal } from '../http/access.js';
import { appHtmlCsp } from '../http/csp.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import {
  desktopRedirectTarget,
  getOriginBoundary,
  isDesktopOrigin,
  tokenFitsAppOrigin,
} from '../http/origin-boundary.js';
import { IS_REMOTE, getPort } from '../config.js';
import type { WsData } from '../websocket/server.js';
import type { SessionId } from '../session/types.js';

const FLAG = 'YAAR_PER_APP_ORIGIN';
const SESSION = 'sess-per-app-origin' as SessionId;
const PORT = getPort();

let notesToken: string;
let handle: ReturnType<typeof createFetchHandler>;

beforeAll(() => {
  notesToken = generateIframeToken('win-notes', SESSION, { appId: 'notes' });
  handle = createFetchHandler();
});

afterEach(() => {
  delete process.env[FLAG];
});

function on() {
  process.env[FLAG] = '1';
}

function off() {
  process.env[FLAG] = '0';
}

function request(rawUrl: string, headers: Record<string, string> = {}, method = 'GET') {
  const req = new Request(rawUrl, { headers, method });
  return { req, url: new URL(req.url) };
}

async function fetchVia(rawUrl: string, headers: Record<string, string> = {}, method = 'GET') {
  const res = await handle(
    new Request(rawUrl, { headers, method }),
    undefined as unknown as Server<WsData>,
  );
  if (!res) throw new Error(`handler returned nothing for ${rawUrl}`);
  return res;
}

describe('per-app origin boundary', () => {
  it('runs in local mode, where a loopback boundary exists at all', () => {
    expect(IS_REMOTE).toBe(false);
  });

  describe('mode', () => {
    it('is on by default: the flag unset is loopback-subdomain', () => {
      expect(getOriginBoundary().mode).toBe('loopback-subdomain');
    });

    it('is loopback-alias with the flag at 0', () => {
      off();
      expect(getOriginBoundary().mode).toBe('loopback-alias');
    });

    it('is loopback-subdomain with the flag', () => {
      on();
      expect(getOriginBoundary().mode).toBe('loopback-subdomain');
    });

    it('does nothing when isolation itself is off', () => {
      on();
      process.env.YAAR_APP_ORIGIN_ISOLATION = '0';
      try {
        expect(getOriginBoundary().mode).toBe('off');
      } finally {
        delete process.env.YAAR_APP_ORIGIN_ISOLATION;
      }
    });
  });

  describe('which side a request is on', () => {
    it('refuses a token-less request that landed on a per-app host', () => {
      on();
      const { req, url } = request(`http://notes.localhost:${PORT}/api/storage/x`);
      const p = resolvePrincipal(req, url);
      expect(p).toBeInstanceOf(Response);
      expect((p as Response).status).toBe(403);
    });

    it('refuses a token-less request carrying a per-app Origin', () => {
      on();
      const { req, url } = request(`http://localhost:${PORT}/api/storage/x`, {
        origin: `http://notes.localhost:${PORT}`,
      });
      expect(resolvePrincipal(req, url)).toBeInstanceOf(Response);
    });

    it('still treats the shared 127.0.0.1 alias as an app origin (the fallback)', () => {
      on();
      const { req, url } = request(`http://127.0.0.1:${PORT}/api/storage/x`);
      expect(resolvePrincipal(req, url)).toBeInstanceOf(Response);
    });

    it('still reads the desktop as the host', () => {
      on();
      const { req, url } = request(`http://localhost:${PORT}/api/storage/x`, {
        origin: `http://localhost:${PORT}`,
      });
      const p = resolvePrincipal(req, url);
      expect((p as { kind: string }).kind).toBe('host');
    });

    it('never reads a per-app origin as the desktop', () => {
      on();
      expect(isDesktopOrigin(`http://notes.localhost:${PORT}`)).toBe(false);
    });

    it('sends a desktop document that landed on a per-app host back to localhost', () => {
      on();
      expect(desktopRedirectTarget(new URL(`https://notes.localhost:8443/?x=1`))).toBe(
        'https://localhost:8443/?x=1',
      );
    });

    it('leaves *.localhost alone without the flag', () => {
      off();
      expect(desktopRedirectTarget(new URL(`http://notes.localhost:${PORT}/`))).toBeNull();
    });
  });

  describe('a token is held to its own app', () => {
    const fitsFor = (appId: string | undefined, rawUrl: string, origin?: string) => {
      const { req, url } = request(rawUrl, origin ? { origin } : {});
      return tokenFitsAppOrigin(req, url, appId);
    };
    const fits = (rawUrl: string, origin?: string) => fitsFor('notes', rawUrl, origin);

    it("accepts an app's token on its own host and from its own Origin", () => {
      on();
      expect(fits(`http://notes.localhost:${PORT}/api/storage/x`)).toBe(true);
      expect(fits(`http://localhost:${PORT}/api/verb`, `http://notes.localhost:${PORT}`)).toBe(
        true,
      );
    });

    it("refuses an app's token on another app's host", () => {
      // App Y framing X.localhost with Y's own token would run Y's document in X's origin.
      on();
      expect(fits(`http://other.localhost:${PORT}/api/storage/page.html`)).toBe(false);
    });

    it("refuses an app's token sent from another app's Origin", () => {
      on();
      expect(fits(`http://localhost:${PORT}/api/verb`, `http://other.localhost:${PORT}`)).toBe(
        false,
      );
    });

    it('refuses a token naming no app on a per-app host', () => {
      on();
      expect(fitsFor(undefined, `http://notes.localhost:${PORT}/x`)).toBe(false);
    });

    it('lets a token through on the shared alias, which names no app', () => {
      on();
      expect(fits(`http://127.0.0.1:${PORT}/api/storage/x`)).toBe(true);
    });

    it('checks nothing without the flag', () => {
      off();
      expect(fits(`http://other.localhost:${PORT}/x`)).toBe(true);
    });

    it('is enforced by the real handler, ahead of any route', async () => {
      on();
      const res = await fetchVia(
        `http://other.localhost:${PORT}/api/storage/page.html?__yaar_token=${notesToken}`,
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Token does not belong to this app's origin");
    });
  });

  describe('CORS and the /mcp/ doors', () => {
    it("answers an app's preflight from its own origin", async () => {
      on();
      const origin = `http://notes.localhost:${PORT}`;
      const res = await fetchVia(`http://localhost:${PORT}/api/verb`, { origin }, 'OPTIONS');
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    });

    it('does not answer a per-app origin on a port this server is not on', async () => {
      on();
      const res = await fetchVia(
        `http://localhost:${PORT}/api/verb`,
        { origin: `http://notes.localhost:1` },
        'OPTIONS',
      );
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('does not answer it without the flag', async () => {
      off();
      const res = await fetchVia(
        `http://localhost:${PORT}/api/verb`,
        { origin: `http://notes.localhost:${PORT}` },
        'OPTIONS',
      );
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it("answers the desktop's *.localhost probe, readable and naming the mode", async () => {
      on();
      const origin = `http://localhost:${PORT}`;
      const res = await fetchVia(`http://probe.localhost:${PORT}/health`, { origin });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(((await res.json()) as { originBoundary?: string }).originBoundary).toBe(
        'loopback-subdomain',
      );
    });

    it('keeps the /mcp/ doors closed to a per-app origin', async () => {
      on();
      const res = await fetchVia(
        `http://localhost:${PORT}/mcp/verbs`,
        { origin: `http://notes.localhost:${PORT}`, 'content-type': 'application/json' },
        'POST',
      );
      expect(res.status).toBe(403);
    });
  });

  describe('CSP', () => {
    it('takes the serving port from a per-app Host, and names no other app', () => {
      on();
      const policy = appHtmlCsp(
        new Request(`http://notes.localhost:5173/x.html`, {
          headers: { host: 'notes.localhost:5173' },
        }),
      );
      expect(policy).toContain('http://localhost:5173');
      expect(policy).not.toContain('.localhost');
    });
  });
});
