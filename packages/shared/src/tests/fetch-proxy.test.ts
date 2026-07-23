/**
 * The iframe fetch proxy's classification of a URL.
 *
 * The proxy exists to route *cross-origin* requests through `/api/fetch`, where the
 * domain allowlist lives. Everything turns on which URLs it considers cross-origin,
 * and one class was misfiled: a `data:` URL's parsed origin is the string `"null"`,
 * which is not `location.origin`, so `fetch(dataUrl)` was POSTed to the server —
 * refused without an iframe token, and *with* one, a base64 round trip to decode
 * bytes the app was already holding. The reported symptom ("Invalid or missing
 * iframe token") pointed nowhere near the cause, which is why this is pinned.
 *
 * The script is a string of ES5 injected into an iframe, so it is exercised the way
 * the browser runs it — evaluated with `window`/`location` supplied — rather than
 * pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_FETCH_PROXY_SCRIPT } from '../iframe-scripts/fetch-proxy.js';

interface Call {
  url: string;
  init?: RequestInit;
}

/** Install the proxy over a stub `window`, and report where each call landed. */
function installProxy(href = 'http://localhost:8000/api/apps/ocr/dist/index.html') {
  const real: Call[] = [];
  const window = {
    __YAAR_TOKEN__: 'tok-123',
    fetch(input: unknown, init?: RequestInit) {
      real.push({ url: String((input as { url?: string })?.url ?? input), init });
      // Shaped like /api/fetch's envelope so the proxy path can finish unwrapping it;
      // the direct paths hand this back untouched.
      return Promise.resolve(
        new Response(JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: 'ok' })),
      );
    },
  } as Record<string, unknown>;
  const location = { search: '', origin: new URL(href).origin, href };

  // `window` and `location` are parameters, so they shadow Bun's globals inside.
  new Function('window', 'location', IFRAME_FETCH_PROXY_SCRIPT)(window, location);

  const proxied = window.fetch as (input: unknown, init?: RequestInit) => Promise<Response>;
  return {
    /** Calls that reached the real fetch (i.e. were not routed through the proxy). */
    real,
    /** Where a URL ended up: the real fetch's target. */
    async go(url: string, init?: RequestInit): Promise<Call> {
      real.length = 0;
      await proxied(url, init);
      expect(real).toHaveLength(1);
      return real[0];
    },
  };
}

const DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('iframe fetch proxy — URL classification', () => {
  it('passes a data: URL straight through, unproxied', async () => {
    const p = installProxy();
    const call = await p.go(DATA_URL);
    expect(call.url).toBe(DATA_URL);
  });

  it('sends no token header with a data: URL — there is nothing to authorize', async () => {
    const p = installProxy();
    const call = await p.go(DATA_URL);
    expect(call.init?.headers).toBeUndefined();
  });

  it('passes a blob: URL straight through', async () => {
    const p = installProxy();
    const url = 'blob:http://localhost:8000/8f2c-4d1e';
    expect((await p.go(url)).url).toBe(url);
  });

  it('is case-insensitive about the scheme', async () => {
    const p = installProxy();
    const url = 'DATA:text/plain;base64,aGk=';
    expect((await p.go(url)).url).toBe(url);
  });

  it('still routes a genuinely cross-origin URL through /api/fetch', async () => {
    // The guard must not have widened into "pass everything through".
    const p = installProxy();
    const call = await p.go('https://example.com/thing.json');
    expect(call.url).toBe('/api/fetch');
    expect(call.init?.method).toBe('POST');
  });

  it('still passes a relative URL through with the token header', async () => {
    const p = installProxy();
    const call = await p.go('/api/storage/apps/self/x.json');
    expect(call.url).toBe('/api/storage/apps/self/x.json');
    expect(new Headers(call.init?.headers).get('X-Iframe-Token')).toBe('tok-123');
  });
});
