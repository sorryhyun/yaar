/**
 * `safeFetch` follows redirects the way a browser does, not by replaying the first
 * request at every hop.
 *
 * It used to rebuild each hop from the caller's `init`: the bearer token, every cookie
 * the chain had collected, and the POST body all went to wherever `Location` pointed —
 * so any host the caller trusted could hand its credentials to any other.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { safeFetch } from '../ssrf.js';

interface Hop {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Route requests by URL to canned responses, recording what each hop carried. */
function mockTransport(routes: Record<string, () => Response>): Hop[] {
  const hops: Hop[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hops.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch;
  return hops;
}

function redirect(status: number, location: string, setCookie: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of setCookie) headers.append('set-cookie', c);
  return new Response(null, { status, headers });
}

describe('safeFetch redirects', () => {
  it('keeps credentials and cookies on their own origin', async () => {
    const hops = mockTransport({
      'https://trusted.example/start': () =>
        redirect(302, 'https://unrelated.example/land', ['hop=1; Path=/']),
      'https://unrelated.example/land': () => new Response('ok'),
    });

    await safeFetch('https://trusted.example/start', {
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=abc' },
    });

    expect(hops[0].headers.get('authorization')).toBe('Bearer secret');
    expect(hops[0].headers.get('cookie')).toBe('sid=abc');
    expect(hops[1].headers.get('authorization')).toBeNull();
    expect(hops[1].headers.get('cookie')).toBeNull();
  });

  it('keeps credentials on a same-origin hop, and sends cookies their domain covers', async () => {
    const hops = mockTransport({
      'https://login.example.com/a': () =>
        redirect(302, 'https://login.example.com/b', ['sso=1; Domain=example.com; Path=/']),
      'https://login.example.com/b': () => redirect(302, 'https://app.example.com/home'),
      'https://app.example.com/home': () => new Response('ok'),
    });

    await safeFetch('https://login.example.com/a', {
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=abc' },
    });

    expect(hops[1].headers.get('authorization')).toBe('Bearer secret');
    expect(hops[1].headers.get('cookie')).toBe('sid=abc; sso=1');
    // Across origins: the bearer is gone, the host-only `sid` stays behind, and the
    // cookie scoped to the parent domain goes along.
    expect(hops[2].headers.get('authorization')).toBeNull();
    expect(hops[2].headers.get('cookie')).toBe('sso=1');
  });

  it("hands back the chain's cookies, never the caller's own", async () => {
    // A caller with a jar stores every Set-Cookie it sees. Echoing its own Cookie header
    // back put a copy of each value there, and that copy outranked the fresh value the
    // caller sent next time: a per-request anti-bot key reached the upstream stale.
    mockTransport({ 'https://a.example/write': () => new Response('ok') });
    const direct = await safeFetch('https://a.example/write', {
      headers: { Cookie: 'sid=abc; key=1' },
    });
    expect(direct.headers.getSetCookie()).toEqual([]);

    mockTransport({
      'https://a.example/start': () => redirect(302, 'https://a.example/end', ['hop=2; Path=/']),
      'https://a.example/end': () => new Response('ok'),
    });
    const chained = await safeFetch('https://a.example/start', {
      headers: { Cookie: 'sid=abc' },
    });
    expect(chained.headers.getSetCookie()).toEqual(['hop=2; path=/']);
  });

  it('refuses a Set-Cookie for a domain the responding host is not in', async () => {
    const hops = mockTransport({
      'https://evil.example/a': () =>
        redirect(302, 'https://bank.example/b', ['stolen=1; Domain=bank.example']),
      'https://bank.example/b': () => new Response('ok'),
    });

    await safeFetch('https://evil.example/a');
    expect(hops[1].headers.get('cookie')).toBeNull();
  });

  it('turns a POST answered by 302 or 303 into a bodiless GET', async () => {
    for (const status of [302, 303]) {
      const hops = mockTransport({
        'https://a.example/form': () => redirect(status, 'https://a.example/done'),
        'https://a.example/done': () => new Response('ok'),
      });
      await safeFetch('https://a.example/form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"x":1}',
      });
      expect(hops[1].method).toBe('GET');
      expect(hops[1].body).toBeNull();
      expect(hops[1].headers.get('content-type')).toBeNull();
    }
  });

  it('keeps method and body across 307/308', async () => {
    const hops = mockTransport({
      'https://a.example/form': () => redirect(307, 'https://a.example/moved'),
      'https://a.example/moved': () => new Response('ok'),
    });
    await safeFetch('https://a.example/form', { method: 'POST', body: 'payload' });
    expect(hops[1].method).toBe('POST');
    expect(hops[1].body).toBe('payload');
  });

  it('asks beforeRedirect about every hop, and stops when it throws', async () => {
    const hops = mockTransport({
      'https://ok.example/a': () => redirect(302, 'https://blocked.example/b'),
    });
    const asked: string[] = [];
    const attempt = safeFetch('https://ok.example/a', undefined, {
      beforeRedirect: (url) => {
        asked.push(url);
        throw new Error('not allowed');
      },
    });
    await expect(attempt).rejects.toThrow('not allowed');
    expect(asked).toEqual(['https://blocked.example/b']);
    expect(hops).toHaveLength(1);
  });
});
