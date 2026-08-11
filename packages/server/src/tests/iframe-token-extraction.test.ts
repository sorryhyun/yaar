/**
 * One rule for what "presenting an iframe token" means.
 *
 * Three layers asked the question and one of them answered differently:
 * `access.ts`'s `resolvePrincipal` and `auth.ts`'s remote-mode check read the
 * header **or** `?__yaar_token=`, while `server.ts`'s Phase B route allowlist read
 * the header alone. A subresource that cannot set headers — an `<img src>`, an
 * `EventSource` — has only the query parameter, so it skipped the coarse gate
 * entirely and met only the fine-grained gates behind it.
 *
 * All three now call `extractIframeToken`. That tightens the coarse gate, which is
 * the safe direction only if every legitimate query-param consumer is on the
 * allowlist — so there is one row per consumer below, driving the real handler.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import type { Server } from 'bun';
import { createFetchHandler } from '../http/server.js';
import { extractIframeToken } from '../http/access.js';
import { hasValidIframeToken } from '../http/auth.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import type { WsData } from '../websocket/server.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-token-extraction' as SessionId;

/** The refusal Phase B gives a token-bearing request for a route apps may not reach. */
const OFF_ALLOWLIST = 'Route not available to iframe apps';

let token: string;
let handle: ReturnType<typeof createFetchHandler>;

beforeAll(() => {
  token = generateIframeToken('win-extract', SESSION, { appId: 'notes' });
  handle = createFetchHandler();
});

/**
 * Drive the real handler. Phase B runs long before any route dispatch, so the
 * `server` argument (only ever read on the `/ws` and `/bridge` upgrade paths) is
 * never touched here.
 */
async function fetchWithQueryToken(method: string, path: string): Promise<Response> {
  const url = `http://localhost:8000${path}${path.includes('?') ? '&' : '?'}__yaar_token=${token}`;
  const res = await handle(new Request(url, { method }), undefined as unknown as Server<WsData>);
  if (!res) throw new Error(`handler returned nothing for ${method} ${path}`);
  return res;
}

/** Did Phase B refuse this request as off-allowlist? */
async function refusedByAllowlist(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  return (await res.clone().text()).includes(OFF_ALLOWLIST);
}

describe('extractIframeToken', () => {
  it('reads the header the SDK sends', () => {
    const req = new Request('http://localhost:8000/api/verb', {
      headers: { 'x-iframe-token': 'from-header' },
    });
    expect(extractIframeToken(req, new URL(req.url))).toBe('from-header');
  });

  it('reads the query parameter a subresource rides on', () => {
    const req = new Request('http://localhost:8000/api/storage/x.png?__yaar_token=from-query');
    expect(extractIframeToken(req, new URL(req.url))).toBe('from-query');
  });

  it('prefers the header when a request somehow carries both', () => {
    const req = new Request('http://localhost:8000/api/storage/x.png?__yaar_token=from-query', {
      headers: { 'x-iframe-token': 'from-header' },
    });
    expect(extractIframeToken(req, new URL(req.url))).toBe('from-header');
  });

  it('finds no token when neither spelling is present', () => {
    const req = new Request('http://localhost:8000/api/verb');
    expect(extractIframeToken(req, new URL(req.url))).toBeNull();
  });

  it('is the rule the remote-mode credential check uses', () => {
    const query = new Request(`http://localhost:8000/api/storage/x.png?__yaar_token=${token}`);
    expect(hasValidIframeToken(query, new URL(query.url))).toBe(true);

    const header = new Request('http://localhost:8000/api/verb', {
      headers: { 'x-iframe-token': token },
    });
    expect(hasValidIframeToken(header, new URL(header.url))).toBe(true);

    const bogus = new Request('http://localhost:8000/api/storage/x.png?__yaar_token=nope');
    expect(hasValidIframeToken(bogus, new URL(bogus.url))).toBe(false);
  });
});

describe('every query-param consumer is on the coarse allowlist', () => {
  // One row per thing that can only carry a token in the query — the reason the
  // tightening above is safe. Each of these is fetched by the browser on an app's
  // behalf, with no way to set a header.
  const consumers: Array<[label: string, method: string, path: string]> = [
    ['storage file (<img src>)', 'GET', '/api/storage/shared/example.png'],
    ['storage listing', 'GET', '/api/storage/shared?list=true'],
    ['app static file (the iframe document itself)', 'GET', '/api/apps/notes/index.html'],
    ['PDF page raster (<img src>)', 'GET', '/api/pdf/files/example.pdf/1'],
    ['browser screenshot (<img src>)', 'GET', '/api/browser/sess-1/screenshot'],
    ['browser events (EventSource)', 'GET', '/api/browser/sess-1/events'],
  ];

  for (const [label, method, path] of consumers) {
    it(`admits ${label}`, async () => {
      const res = await fetchWithQueryToken(method, path);
      // The route's own answer may be anything (404 for a file that isn't there, 403
      // from a *fine-grained* gate like the yaar-web bundle check). What must not
      // happen is the coarse gate turning it away for being off the allowlist.
      expect(await refusedByAllowlist(res)).toBe(false);
    });
  }
});

describe('a query-param token now meets the coarse gate', () => {
  it('refuses a host-only route it used to walk straight past', async () => {
    // `/api/iframe-token` mints an app's identity and is `requireHost`-only, so it is
    // deliberately absent from every PUBLIC_ENDPOINTS list. Before this change the
    // query-param spelling skipped Phase B and was caught only downstream.
    const res = await fetchWithQueryToken('POST', '/api/iframe-token');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(OFF_ALLOWLIST);
  });

  it('refuses an invalid query-param token outright rather than promoting it', async () => {
    const res = await handle(
      new Request('http://localhost:8000/api/storage/x.png?__yaar_token=not-a-token'),
      undefined as unknown as Server<WsData>,
    );
    expect(res?.status).toBe(403);
    expect(await res?.text()).toContain('Invalid or expired iframe token');
  });

  it('still refuses cross-app static files, whichever spelling carries the token', async () => {
    const res = await fetchWithQueryToken('GET', '/api/apps/vault/secrets.js');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Cross-app access denied');
  });
});
