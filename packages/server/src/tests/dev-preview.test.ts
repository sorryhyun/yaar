/**
 * `GET /api/dev/preview/{appId}` — an app as a top-level page, token included.
 *
 * The reason this route exists is that opening `dist/index.html` directly is by far
 * the best inner loop for verifying one app (no window management, no cross-origin
 * iframe to reach into, the app's own automation hook directly addressable) and it
 * was *almost* usable: no `__YAAR_TOKEN__` is injected, so every token-gated SDK call
 * 403s with a message ("Invalid or missing iframe token") that names nothing about
 * the actual cause.
 *
 * What has to hold: the token is real and is the *app's* identity, and handing one out
 * is host-only — the same escalation oracle `POST /api/iframe-token` is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { generateHtmlWrapper } from '@yaar/compiler';
import { IFRAME_FETCH_PROXY_SCRIPT } from '@yaar/shared';
import { handleDevRoutes } from '../http/routes/dev.js';
import { appHtmlCsp } from '../http/csp.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';
import { validateIframeToken } from '../http/iframe-tokens.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';

/**
 * An installed app with a compiled `dist/index.html`, written for the test.
 *
 * Pointing at a bundled app instead looks simpler and is wrong: `dist/` is
 * git-ignored, so a checked-out tree that has not compiled anything — CI — has no
 * entry point to serve and every assertion here fell to the route's own 404. The
 * fixture is the real compiler wrapper around the real fetch-proxy SDK script, so
 * the injection point is still asserted against the HTML the route actually meets.
 */
const APP = 'zz-dev-preview-fixture';
const appDir = join(USER_APPS_DIR, APP);

beforeAll(async () => {
  await mkdir(join(appDir, 'dist'), { recursive: true });
  await writeFile(
    join(appDir, 'app.json'),
    JSON.stringify({ id: APP, name: 'Dev Preview Fixture', description: 'test fixture' }),
  );
  await writeFile(
    join(appDir, 'dist', 'index.html'),
    generateHtmlWrapper('/* fixture app */', 'Dev Preview Fixture', IFRAME_FETCH_PROXY_SCRIPT),
  );
});

afterAll(async () => {
  await rm(appDir, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost:8000${path}`, { headers });
  return handleDevRoutes(req, new URL(req.url));
}

/** The token the injected <script> assigns, or null if none was injected. */
function injectedToken(html: string): string | null {
  const m = html.match(/window\.__YAAR_TOKEN__=("(?:[^"\\]|\\.)*")/);
  return m ? (JSON.parse(m[1]) as string) : null;
}

describe('GET /api/dev/preview/{appId}', () => {
  it('serves the app and injects a valid token bound to that app', async () => {
    const res = await get(`/api/dev/preview/${APP}`);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const html = await res!.text();
    const token = injectedToken(html);
    expect(token).not.toBeNull();

    // A real, mintable identity — not a placeholder the SDK would send and be refused on.
    const entry = validateIframeToken(token!);
    expect(entry).not.toBeNull();
    expect(entry!.appId).toBe(APP);
  });

  it('injects the token ahead of the SDK scripts that read it', async () => {
    // The SDKs snapshot `window.__YAAR_TOKEN__` as they install. Injected after them,
    // the token is present in the page and absent from every request it makes.
    const html = await (await get(`/api/dev/preview/${APP}`))!.text();
    expect(html.indexOf('__YAAR_TOKEN__')).toBeLessThan(html.indexOf('__yaarFetchProxyInstalled'));
  });

  it('serves it under the same CSP the app runs under in a window', async () => {
    // A preview that is laxer than production is a preview that green-lights code the
    // deployed app would be refused — so both come from appHtmlCsp(). Asserted here
    // against the request the route actually saw, not against a literal, because the
    // policy widens to the loopback pair when app-origin isolation is on.
    const res = await get(`/api/dev/preview/${APP}`);
    const req = new Request(`http://localhost:8000/api/dev/preview/${APP}`);
    expect(res!.headers.get('Content-Security-Policy')).toBe(appHtmlCsp(req));
    expect(res!.headers.get('Content-Security-Policy')).toStartWith("connect-src 'self'");
  });

  it('is refused to app iframes — it hands out an app token', async () => {
    const token = await generateAppIframeToken('win-1', 'sess-1', { appId: 'notes' });
    const res = await get(`/api/dev/preview/${APP}`, { 'x-iframe-token': token });
    expect(res!.status).toBe(403);
  });

  it('404s an app that does not exist', async () => {
    const res = await get('/api/dev/preview/no-such-app');
    expect(res!.status).toBe(404);
  });

  it('refuses an app id that could climb out of the apps directory', async () => {
    const res = await get('/api/dev/preview/' + encodeURIComponent('../../etc'));
    expect(res!.status).toBe(400);
  });
});
