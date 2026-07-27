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

/**
 * Install the proxy over a stub `window`, and report where each call landed.
 *
 * `globalToken` is what an injected `<script>window.__YAAR_TOKEN__=...</script>`
 * would have left behind; pass null to model a page where nothing injected one
 * and the token rides only in the URL.
 */
function installProxy(
  href = 'http://localhost:8000/api/apps/ocr/dist/index.html',
  globalToken: string | null = 'tok-123',
) {
  const real: Call[] = [];
  const window = {
    ...(globalToken === null ? {} : { __YAAR_TOKEN__: globalToken }),
    fetch(input: unknown, init?: RequestInit) {
      real.push({ url: String((input as { url?: string })?.url ?? input), init });
      // Shaped like /api/fetch's envelope so the proxy path can finish unwrapping it;
      // the direct paths hand this back untouched.
      return Promise.resolve(
        new Response(JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: 'ok' })),
      );
    },
  } as Record<string, unknown>;
  const location = { search: new URL(href).search, origin: new URL(href).origin, href };

  // `window` and `location` are parameters, so they shadow Bun's globals inside.
  new Function('window', 'location', IFRAME_FETCH_PROXY_SCRIPT)(window, location);

  const proxied = window.fetch as (input: unknown, init?: RequestInit) => Promise<Response>;
  return {
    /** The stub window, so a test can inject a token after the script installed. */
    window,
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

/**
 * The proxy used to read `window.__YAAR_TOKEN__` once, at install, and never look
 * at the `__yaar_token` URL param itself. It worked only because `verb-sdk` is
 * listed ahead of it at both injection sites (`compiler/src/compile.ts` and
 * `IframeRenderer.tsx`) and back-filled the global from the URL on its way past.
 * Reordering those arrays — or injecting the proxy on its own — silently dropped
 * the token from every cross-origin fetch, with nothing to point at the cause.
 *
 * These pin the load order out of the contract: the proxy is installed alone,
 * with no `verb-sdk` ahead of it.
 */
describe('iframe fetch proxy — token discovery, standalone', () => {
  const WITH_URL_TOKEN =
    'http://localhost:8000/api/apps/ocr/dist/index.html?__yaar_token=tok-from-url';

  it('picks up a URL-only token with no verb-sdk present', async () => {
    const p = installProxy(WITH_URL_TOKEN, null);
    const call = await p.go('/api/storage/apps/self/x.json');
    expect(new Headers(call.init?.headers).get('X-Iframe-Token')).toBe('tok-from-url');
  });

  it('sends the URL-only token on the proxied cross-origin path too', async () => {
    const p = installProxy(WITH_URL_TOKEN, null);
    const call = await p.go('https://example.com/thing.json');
    expect(call.url).toBe('/api/fetch');
    expect(new Headers(call.init?.headers).get('X-Iframe-Token')).toBe('tok-from-url');
  });

  it('prefers a token injected after install over the one in the URL', async () => {
    // The token is read per call, not snapshotted, so the dev-preview path — which
    // injects `window.__YAAR_TOKEN__` into a page whose URL carries no token — works
    // whichever side of the SDK scripts the injection lands on.
    const p = installProxy(undefined, null);
    p.window.__YAAR_TOKEN__ = 'tok-injected-late';
    const call = await p.go('/api/storage/apps/self/x.json');
    expect(new Headers(call.init?.headers).get('X-Iframe-Token')).toBe('tok-injected-late');
  });

  it('sends no token header when neither the URL nor the global carries one', async () => {
    const p = installProxy(undefined, null);
    const call = await p.go('/api/storage/apps/self/x.json');
    expect(call.init?.headers).toBeUndefined();
  });
});
