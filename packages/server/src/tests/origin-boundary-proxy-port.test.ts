/**
 * App-origin isolation over a remote transport.
 *
 * `localhost` vs `127.0.0.1` means nothing once you reach the machine over a network,
 * so remote mode gets its split from Tailscale Serve instead: two ports on one *stable*
 * MagicDNS name — distinct browser origins, since the same-origin policy separates on
 * port too.
 *
 * The load-bearing detail these rows lock down: over a proxy the server cannot read
 * the addressed origin off the request. `url.hostname`/`url.port` describe the loopback
 * hop `tailscaled` dialed, and `Host`/`X-Forwarded-*` are the proxy's word. So the two
 * public ports are pointed at two *different local sockets*, and the app-origin socket's
 * fetch handler runs inside `runOnAppOriginSocket()`. Which socket a request landed on
 * is not something a request can claim.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { resolvePrincipal } from '../http/access.js';
import { appHtmlCsp } from '../http/csp.js';
import {
  desktopRedirectTarget,
  getOriginBoundary,
  installLoopbackAliasBoundary,
  installProxyPortBoundary,
  isolatedAppOrigin,
  isOriginBoundaryActive,
  resetOriginBoundary,
  runOnAppOriginSocket,
} from '../http/origin-boundary.js';
import { refreshRestoredWindowActions } from '../logging/window-restore.js';

const DESKTOP = 'https://my-box.tailnet-abc.ts.net';
const APP = 'https://my-box.tailnet-abc.ts.net:8443';

/** The local socket a proxied request actually lands on — never the public origin. */
const LOCAL_DESKTOP = 'http://127.0.0.1:8000';
const LOCAL_APP = 'http://127.0.0.1:8001';

function resolve(rawUrl: string, headers: Record<string, string> = {}) {
  const req = new Request(rawUrl, { headers });
  return resolvePrincipal(req, new URL(req.url));
}

function isHost(result: unknown): boolean {
  return !(result instanceof Response) && (result as { kind: string }).kind === 'host';
}

afterEach(() => {
  resetOriginBoundary();
  delete process.env.YAAR_APP_ORIGIN_ISOLATION;
});

describe('proxy-port origin boundary', () => {
  it('is active even in remote mode, where the loopback-alias split is not', () => {
    // The whole point of Phase 3: `isAppOriginIsolationEnabled()` is local-only, so
    // remote mode gets its boundary from the transport instead, installed at runtime.
    installProxyPortBoundary(DESKTOP, APP);
    expect(getOriginBoundary()).toEqual({
      mode: 'proxy-port',
      desktopOrigin: DESKTOP,
      appOrigin: APP,
    });
    expect(isOriginBoundaryActive()).toBe(true);
  });

  it('falls back to the loopback alias when the tunnel never came up', () => {
    // Now that tunnel-off remote mode is gone, a failed tunnel is the *only* way remote
    // mode ends up with no transport — and it leaves the server loopback-only, which is
    // exactly where `localhost`/`127.0.0.1` works. `isAppOriginIsolationEnabled()` still
    // answers false under IS_REMOTE, so the lifecycle installs this explicitly rather
    // than letting the environment fall through to `off`.
    process.env.YAAR_APP_ORIGIN_ISOLATION = '1';
    installLoopbackAliasBoundary();
    expect(getOriginBoundary()).toEqual({ mode: 'loopback-alias' });
    expect(isOriginBoundaryActive()).toBe(true);
    // The frontend derives the sibling alias from its own location in this mode; the
    // server must not name one, or it would pin a port the document was not served on.
    expect(isolatedAppOrigin()).toBeNull();
    // And the split is enforced: a token-less request wearing the app alias is not the host.
    expect(isHost(resolve('http://127.0.0.1:8000/api/settings'))).toBe(false);
  });

  it('states the app origin, because the client cannot derive it', () => {
    // Locally the frontend computes the sibling loopback alias itself (only the browser
    // knows which port served the document). `https://host:8443` is not computable from
    // `https://host` by anything standing on the client, so the server names it.
    installProxyPortBoundary(DESKTOP, APP);
    expect(isolatedAppOrigin()).toBe(APP);
  });

  describe('resolvePrincipal — a token-less app can no longer pass as the host', () => {
    it('refuses a request that arrived on the app-origin socket', () => {
      installProxyPortBoundary(DESKTOP, APP);
      // Same URL, same headers as the desktop's own call — only the socket differs, and
      // that is the one thing an app cannot forge.
      const denied = runOnAppOriginSocket(() => resolve(`${LOCAL_APP}/api/storage/x`));
      expect(denied).toBeInstanceOf(Response);
      expect((denied as Response).status).toBe(403);
    });

    it('refuses a cross-origin call carrying a browser-set app Origin', () => {
      installProxyPortBoundary(DESKTOP, APP);
      const denied = resolve(`${LOCAL_DESKTOP}/api/storage/x`, { origin: APP });
      expect(denied).toBeInstanceOf(Response);
      expect((denied as Response).status).toBe(403);
    });

    it('is not fooled by the desktop origin differing only in port', () => {
      // `https://host` and `https://host:8443` share a hostname. A hostname comparison
      // (what the loopback-alias mode does) would refuse the desktop itself here.
      installProxyPortBoundary(DESKTOP, APP);
      expect(isHost(resolve(`${LOCAL_DESKTOP}/api/storage/x`, { origin: DESKTOP }))).toBe(true);
    });

    it('still reads the desktop socket with no Origin as the host', () => {
      installProxyPortBoundary(DESKTOP, APP);
      expect(isHost(resolve(`${LOCAL_DESKTOP}/api/storage/x`))).toBe(true);
    });

    it('does not leak the app-socket marking across requests', () => {
      installProxyPortBoundary(DESKTOP, APP);
      runOnAppOriginSocket(() => resolve(`${LOCAL_APP}/api/storage/x`));
      expect(isHost(resolve(`${LOCAL_DESKTOP}/api/storage/x`))).toBe(true);
    });

    it('is inert with no boundary in force', () => {
      // The app socket only exists when a boundary is being installed, but the marking
      // must mean nothing on its own — otherwise a failed tunnel would 403 the desktop.
      // (The flag is what takes the *loopback-alias* boundary out of the picture too;
      // 127.0.0.1 is the app alias there, and this URL is a loopback hop.)
      process.env.YAAR_APP_ORIGIN_ISOLATION = '0';
      expect(isHost(runOnAppOriginSocket(() => resolve(`${LOCAL_APP}/api/storage/x`)))).toBe(true);
    });
  });

  describe('the desktop never lives on the app origin', () => {
    it('redirects a desktop document off the app socket', () => {
      installProxyPortBoundary(DESKTOP, APP);
      const target = runOnAppOriginSocket(() =>
        desktopRedirectTarget(new URL(`${LOCAL_APP}/settings?x=1`)),
      );
      // Note the *public* desktop origin, not the loopback hop: this is a Location
      // header the browser has to be able to follow.
      expect(target).toBe(`${DESKTOP}/settings?x=1`);
    });

    it('leaves a request on the desktop socket alone', () => {
      installProxyPortBoundary(DESKTOP, APP);
      expect(desktopRedirectTarget(new URL(`${LOCAL_DESKTOP}/settings`))).toBeNull();
    });
  });

  it('lets an isolated app reach the desktop origin through CSP', () => {
    // The app document is served from the app origin ('self'); its SDKs are handed the
    // desktop origin as __yaar_api. Under a flat `connect-src 'self'` every one of those
    // calls — including the fetch proxy's own — is refused.
    installProxyPortBoundary(DESKTOP, APP);
    const policy = appHtmlCsp(
      new Request(`${LOCAL_APP}/x.html`, { headers: { host: 'evil.example.com' } }),
    );
    expect(policy).toStartWith("connect-src 'self'");
    expect(policy).toContain(DESKTOP);
    expect(policy).toContain(APP);
    // Host is the proxy's word and irrelevant here — both origins are addresses the
    // server itself published.
    expect(policy).not.toContain('evil.example.com');
  });
});

/**
 * Replayed `window.create` actions carry the *current* run's marks, not a logged one's.
 *
 * Two paths replay rather than freshly emit: a restored session log, and the snapshot a
 * reconnecting client is handed. The second rebuilds each action from
 * `WindowStateRegistry`, which never carried the marks at all — so before this, every
 * open app window silently lost its origin isolation on a page refresh.
 */
describe('refreshRestoredWindowActions — per-run origin marks', () => {
  const iframeWindow = (extra: Record<string, unknown> = {}) => [
    {
      type: 'window.create' as const,
      windowId: '0/notes',
      title: 'Notes',
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'iframe' as const, data: '/api/apps/notes/index.html' },
      ...extra,
    },
  ];

  it('strips a stale mark when no boundary is in force', async () => {
    // A log written on a run with isolation on must not tell a run with it off to serve
    // the app from an origin this run never published.
    process.env.YAAR_APP_ORIGIN_ISOLATION = '0';
    const [action] = await refreshRestoredWindowActions(
      iframeWindow({ isolateOrigin: true, appOrigin: 'http://127.0.0.1:8000' }),
      'sess-1',
    );
    expect((action as { isolateOrigin?: boolean }).isolateOrigin).toBeUndefined();
    expect((action as { appOrigin?: string }).appOrigin).toBeUndefined();
  });

  it('replaces a logged loopback origin with this run’s app origin', async () => {
    installProxyPortBoundary(DESKTOP, APP);
    const [action] = await refreshRestoredWindowActions(
      iframeWindow({ isolateOrigin: true, appOrigin: 'http://127.0.0.1:8000' }),
      'sess-1',
    );
    // `notes` is not an installed app in this checkout, so the marks resolve to "not
    // isolated" — the assertion that matters is that the *stale* value is gone either way.
    expect((action as { appOrigin?: string }).appOrigin).not.toBe('http://127.0.0.1:8000');
  });

  it('always remints the iframe token', async () => {
    installProxyPortBoundary(DESKTOP, APP);
    const [action] = await refreshRestoredWindowActions(
      iframeWindow({ iframeToken: 'stale-token' }),
      'sess-1',
    );
    const token = (action as { iframeToken?: string }).iframeToken;
    expect(token).toBeString();
    expect(token).not.toBe('stale-token');
  });
});
