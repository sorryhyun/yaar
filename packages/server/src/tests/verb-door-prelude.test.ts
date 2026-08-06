/**
 * Both verb doors open the same way.
 *
 * `/api/verb` and `/api/verb/subscribe` each hand-rolled the same three steps —
 * read the JSON body, resolve the caller, insist it is a real app — and then
 * diverged on rules that genuinely differ (the main door admits an anonymous
 * `describe`; the subscribe door has stream and bundle carve-outs). The shared
 * part is now `openVerbDoor` plus `requireApp`; the divergent part deliberately
 * stayed at each door.
 *
 * What must stay true: the two doors give the *same* refusal to the same bad
 * caller, and the main door's one carve-out — anonymous `describe` — still holds.
 */
import { describe, it, expect } from 'bun:test';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-door-prelude' as SessionId;

function request(path: string, body: unknown, token?: string): Request {
  return new Request(`http://localhost:8000${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-iframe-token': token } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const req = request(path, body, token);
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error(`route did not handle POST ${path}`);
  return res;
}

describe('the shared verb-door prelude', () => {
  it('refuses a malformed body identically at both doors', async () => {
    const main = await post('/api/verb', 'not json at all');
    const sub = await post('/api/verb/subscribe', 'not json at all');
    expect(main.status).toBe(400);
    expect(sub.status).toBe(main.status);
  });

  it('refuses an unknown token identically at both doors', async () => {
    const main = await post('/api/verb', { verb: 'read', uri: 'yaar://apps' }, 'not-a-token');
    const sub = await post(
      '/api/verb/subscribe',
      { action: 'subscribe', uri: 'yaar://apps' },
      'not-a-token',
    );
    expect(main.status).toBe(403);
    expect(sub.status).toBe(403);
    expect(await main.text()).toContain('Invalid or expired iframe token');
    expect(await sub.text()).toContain('Invalid or expired iframe token');
  });

  it('refuses a token-less caller at both doors — except the main door’s describe', async () => {
    // Subscribe has no anonymous tier: every branch keys by the caller's token.
    const sub = await post('/api/verb/subscribe', { action: 'subscribe', uri: 'yaar://apps' });
    expect(sub.status).toBe(403);
    expect(await sub.text()).toContain('Invalid or missing iframe token');

    // Neither does the main door for a data verb…
    const read = await post('/api/verb', { verb: 'read', uri: 'yaar://apps' });
    expect(read.status).toBe(403);
    expect(await read.text()).toContain('Invalid or missing iframe token');

    // …but `describe` is metadata-only, and stays open to a caller with no token.
    const described = await post('/api/verb', { verb: 'describe', uri: 'yaar://apps' });
    expect(described.status).toBe(200);
    expect(((await described.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('answers a token that no longer checks out before it judges the body', async () => {
    // Behavior delta from moving `resolvePrincipal` into the prelude: a request that
    // is bad in two ways at once now reports the *identity* failure rather than the
    // shape one. That is the more accurate of the two answers, and both are refusals.
    const res = await post('/api/verb', { verb: 'bogus', uri: 'yaar://apps' }, 'not-a-token');
    expect(res.status).toBe(403);
  });

  it('still validates the verb and the URI for a caller whose token is good', async () => {
    const token = generateIframeToken('win-prelude', SESSION, { appId: 'notes' });
    const badVerb = await post('/api/verb', { verb: 'bogus', uri: 'yaar://apps' }, token);
    expect(badVerb.status).toBe(400);
    expect(await badVerb.text()).toContain('Invalid verb');

    const noUri = await post('/api/verb', { verb: 'read' }, token);
    expect(noUri.status).toBe(400);
    expect(await noUri.text()).toContain('uri');
  });
});
