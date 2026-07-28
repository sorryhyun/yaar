/**
 * Remote mode (`REMOTE=1`) — the half of the auth and origin-boundary surface that local-mode
 * tests structurally cannot reach.
 *
 * **This whole directory runs in its own process**, spawned by the package's test script with
 * `YAAR_TEST_REMOTE=1` (scripts/test/env.ts turns that into `REMOTE=1` before `config/env.ts`
 * loads). `IS_REMOTE` is a module-load constant, so remote mode is a property of a *process*,
 * never of a test: `checkHttpAuth`'s first line returns `null` when it is false, and every
 * assertion below would pass no matter what the gate did. `ml-runtime-remote-auth.test.ts`
 * exists because that vacuity hid a real bug — the neighbouring local-mode cases in
 * `http-routing.test.ts` "would not have caught it, and did not".
 *
 * The first test is the canary: if `REMOTE` did not take, nothing after it means anything.
 *
 * Its local-mode counterparts are `packages/tests/src/integration/http-routing.test.ts` (the
 * gate is inert) and `app-origin-isolation.test.ts` (the loopback-alias boundary). Both now
 * assert `IS_REMOTE === false` up front for the same reason this file asserts the opposite.
 */

import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { IS_REMOTE, isAppOriginIsolationEnabled } from '../../config.js';
import { checkHttpAuth, checkWsAuth, generateRemoteToken } from '../../http/auth.js';
import { resolvePrincipal } from '../../http/access.js';
import { generateAppIframeToken } from '../../http/iframe-tokens.js';
import {
  getOriginBoundary,
  installProxyPortBoundary,
  resetOriginBoundary,
  runOnAppOriginSocket,
} from '../../http/origin-boundary.js';

/** The tunnel's two published origins — one MagicDNS name, two ports. */
const DESKTOP_ORIGIN = 'https://host.tail1234.ts.net';
const APP_ORIGIN = 'https://host.tail1234.ts.net:8443';

let token: string;

beforeAll(() => {
  // Minted by `lifecycle` at boot in a real run. Until it exists the gate is open by
  // design (`!remoteToken` short-circuits), so every case below needs it in place.
  token = generateRemoteToken();
});

/** Ask the gate about a path, the way `http/server.ts` does. Returns the status, 200 = allowed. */
function probe(path: string, headers: Record<string, string> = {}): number {
  const req = new Request(`https://host.tail1234.ts.net${path}`, { headers });
  return checkHttpAuth(req, new URL(req.url))?.status ?? 200;
}

describe('remote mode is genuinely in effect', () => {
  it('IS_REMOTE is true — otherwise nothing in this file means anything', () => {
    expect(IS_REMOTE).toBe(true);
  });
});

describe('checkHttpAuth under REMOTE=1', () => {
  it('refuses an API call with no credential', () => {
    expect(probe('/api/apps')).toBe(401);
  });

  it('accepts the remote token in the Authorization header', () => {
    expect(probe('/api/apps', { authorization: `Bearer ${token}` })).toBe(200);
  });

  it('accepts the remote token as a query parameter', () => {
    expect(probe(`/api/apps?token=${token}`)).toBe(200);
  });

  it('refuses a wrong token', () => {
    expect(probe('/api/apps', { authorization: 'Bearer not-the-token' })).toBe(401);
  });

  it('exempts /health, so a reachability probe needs no secret', () => {
    expect(probe('/health')).toBe(200);
  });

  it('exempts /mcp/*, which carries its own bearer token', () => {
    expect(probe('/mcp/verbs')).toBe(200);
  });

  it('exempts the frontend bootstrap, which must load to read #remote=<token>', () => {
    expect(probe('/')).toBe(200);
    expect(probe('/index.html')).toBe(200);
    expect(probe('/assets/app.js')).toBe(200);
  });

  it('does not let a chosen extension act as the credential', () => {
    // The gate used to be a pure suffix test that ran before any /api check, so naming a
    // storage path `.png` skipped the token entirely. Storage holds the user's files and
    // the attacker picks the name — see isStaticAsset's header.
    expect(probe('/api/storage/secret.png')).toBe(401);
    expect(probe('/api/storage/payload.js')).toBe(401);
  });

  it('accepts an iframe token as a credential in its own right', async () => {
    // What makes an isolated app work over a remote transport: cross-origin, its Referer is
    // trimmed to a bare origin, so the remote token cannot ride along in it.
    const iframeToken = await generateAppIframeToken('win-1', 'sess-1', { appId: 'notes' });
    expect(probe('/api/verb', { 'x-iframe-token': iframeToken })).toBe(200);
    expect(probe(`/api/storage/apps/notes/x?__yaar_token=${iframeToken}`)).toBe(200);
  });
});

describe('checkWsAuth under REMOTE=1', () => {
  it('refuses an upgrade with no token', () => {
    expect(checkWsAuth(new URL('wss://host.tail1234.ts.net/ws'))).toBe(false);
  });

  it('accepts an upgrade carrying the remote token', () => {
    expect(checkWsAuth(new URL(`wss://host.tail1234.ts.net/ws?token=${token}`))).toBe(true);
  });

  it('refuses an upgrade carrying a wrong token', () => {
    expect(checkWsAuth(new URL('wss://host.tail1234.ts.net/ws?token=nope'))).toBe(false);
  });
});

describe('the origin boundary under REMOTE=1', () => {
  afterEach(() => {
    resetOriginBoundary();
  });

  it('gets no boundary from the loopback alias — that split means nothing over a network', () => {
    expect(isAppOriginIsolationEnabled()).toBe(false);
    expect(getOriginBoundary().mode).toBe('off');
  });

  it('takes the proxy-port boundary the tunnel installs once both origins are live', () => {
    installProxyPortBoundary(DESKTOP_ORIGIN, APP_ORIGIN);
    expect(getOriginBoundary()).toEqual({
      mode: 'proxy-port',
      desktopOrigin: DESKTOP_ORIGIN,
      appOrigin: APP_ORIGIN,
    });
  });

  it('refuses a token-less request wearing the app origin', () => {
    installProxyPortBoundary(DESKTOP_ORIGIN, APP_ORIGIN);
    const req = new Request(`${DESKTOP_ORIGIN}/api/storage/x`, { headers: { origin: APP_ORIGIN } });
    const p = resolvePrincipal(req, new URL(req.url));
    expect(p).toBeInstanceOf(Response);
    expect((p as Response).status).toBe(403);
  });

  it('refuses a token-less request that arrived on the app-origin socket', () => {
    // Behind a proxy `url` describes the loopback hop, so *which socket* is the only
    // unforgeable answer — a relative fetch from the app sends no Origin at all.
    installProxyPortBoundary(DESKTOP_ORIGIN, APP_ORIGIN);
    const req = new Request('http://127.0.0.1:8443/api/storage/x');
    const p = runOnAppOriginSocket(() => resolvePrincipal(req, new URL(req.url)));
    expect(p).toBeInstanceOf(Response);
    expect((p as Response).status).toBe(403);
  });

  it('still reads the desktop, on its own origin, as the host', () => {
    installProxyPortBoundary(DESKTOP_ORIGIN, APP_ORIGIN);
    const req = new Request(`${DESKTOP_ORIGIN}/api/storage/x`, {
      headers: { origin: DESKTOP_ORIGIN },
    });
    const p = resolvePrincipal(req, new URL(req.url));
    expect(p).not.toBeInstanceOf(Response);
    expect((p as { kind: string }).kind).toBe('host');
  });

  it('does not refuse a well-behaved app: a valid token wins on the app origin', async () => {
    installProxyPortBoundary(DESKTOP_ORIGIN, APP_ORIGIN);
    const iframeToken = await generateAppIframeToken('win-1', 'sess-1', { appId: 'notes' });
    const req = new Request(`${DESKTOP_ORIGIN}/api/verb`, {
      headers: { origin: APP_ORIGIN, 'x-iframe-token': iframeToken },
    });
    const p = resolvePrincipal(req, new URL(req.url));
    expect(p).not.toBeInstanceOf(Response);
    expect((p as { kind: string; appId?: string }).appId).toBe('notes');
  });
});
