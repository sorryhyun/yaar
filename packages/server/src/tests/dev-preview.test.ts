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
import { describe, it, expect } from 'bun:test';
import { handleDevRoutes } from '../http/routes/dev.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';
import { validateIframeToken } from '../http/iframe-tokens.js';

/** An app that ships a compiled dist/index.html in the repo. */
const APP = 'browser-user';

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
    // deployed app would be refused.
    const res = await get(`/api/dev/preview/${APP}`);
    expect(res!.headers.get('Content-Security-Policy')).toBe("connect-src 'self'");
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
